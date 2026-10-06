#!/usr/bin/env node
// check-i18n — 字典静态检查，防止 `{m}m` 式静默劫持与占位符/重复 key 类错误。
//
//   node scripts/check-i18n.mjs
//
// 背景：i18n 是**动态字典**。`apps/web/src/shared/i18n/dict/*.ts` 由
// `import.meta.glob` 合并成一张扁平表；`t()`/`tr()` 既可精确命中，也可把
// 含 `{placeholder}` 的 key 编译成正则去匹配。历史真 bug（commit 1f65db4）：
// `dict/ledger.ts` 的 `'{m}m'` 被编译成 `^(.+?)m$`，把任何以 m 结尾且没有
// 精确翻译的英文串吞成「… 分钟」（`Close room` → `Close roo 分钟`）。现
// 源码已按「孤立单位字母 h/m/s → 数字捕获」收紧，本脚本独立复刻这套编译
// 规则并对字典做静态检查，作为防复发闸门。
//
// 仓库根按「脚本自身位置」定位（而非 process.cwd()），与 check-links 等脚本
// 一致，worktree 场景下检查的就是本 worktree。
//
// 退出码：出现「必查」错误时非零；「应查」只提示、不影响退出码。

import fs from 'node:fs';
import path from 'node:path';
import { findRepoRoot } from './lib/repo-root.mjs';

const repoRoot = findRepoRoot(import.meta.url);
const I18N_DIR = path.join(repoRoot, 'apps/web/src/shared/i18n');
const DICT_DIR = path.join(I18N_DIR, 'dict');

// ── `t()` 的编译规则（必须与 apps/web/src/shared/i18n/index.ts 保持一致）──
// 若 index.ts 调整了占位符/单位判定，这里要同步；`apps/web/test/i18nTemplate.test.ts`
// 从运行时行为侧兜底，本脚本只做字典侧的静态复刻。
const PLACEHOLDER = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
const UNIT_LETTERS = new Set(['h', 'm', 's']);
const NUMERIC_CAPTURE = '(\\d+(?:\\.\\d+)?)';

function placeholderNames(s) {
  const out = [];
  let m;
  PLACEHOLDER.lastIndex = 0;
  while ((m = PLACEHOLDER.exec(s))) out.push(m[1]);
  PLACEHOLDER.lastIndex = 0;
  return out;
}

function escapeRegExp(literal) {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 与 index.ts 完全一致的「孤立单位字母」判定。 */
function isUnitPlaceholder(key, end) {
  const suffix = key[end];
  if (suffix === undefined || !UNIT_LETTERS.has(suffix)) return false;
  const after = key[end + 1];
  return after === undefined || !/[A-Za-z]/.test(after);
}

/** 按 index.ts 现行规则编译模板（单位占位符用数字捕获）。 */
function compileActual(key) {
  let pattern = '^';
  let last = 0;
  let m;
  PLACEHOLDER.lastIndex = 0;
  while ((m = PLACEHOLDER.exec(key))) {
    pattern += escapeRegExp(key.slice(last, m.index));
    pattern += isUnitPlaceholder(key, m.index + m[0].length) ? NUMERIC_CAPTURE : '(.+?)';
    last = m.index + m[0].length;
  }
  pattern += escapeRegExp(key.slice(last)) + '$';
  return new RegExp(pattern);
}

/**
 * 修复前（1f65db4）的通用编译：所有占位符一律 `(.+?)`。用于量化「被中和的
 * 历史风险」——单位模板在通用编译下会命中哪些具体 key。
 */
function compileGeneric(key) {
  let pattern = '^';
  let last = 0;
  let m;
  PLACEHOLDER.lastIndex = 0;
  while ((m = PLACEHOLDER.exec(key))) {
    pattern += escapeRegExp(key.slice(last, m.index));
    pattern += '(.+?)';
    last = m.index + m[0].length;
  }
  pattern += escapeRegExp(key.slice(last)) + '$';
  return new RegExp(pattern);
}

// ── dict 模块解析（零依赖，不 import TS）────────────────────────────────────
// dict 模块是扁平的 `Record<string,string>`：key 可带引号也可以是标识符，
// value 一律字符串（含跨行书写）。这里用一个跳过注释/处理转义的小扫描器把
// 「key: value」按出现顺序解析出来，行号一并记录以便人工复核。
function tokenize(src) {
  const toks = [];
  let i = 0;
  let line = 1;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === '\n') {
      line += 1;
      i += 1;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
        if (src[i] === '\n') line += 1;
        i += 1;
      }
      i += 2;
      continue;
    }
    if (c === "'" || c === '"') {
      const quote = c;
      const startLine = line;
      i += 1;
      let v = '';
      while (i < n && src[i] !== quote) {
        if (src[i] === '\\') {
          const nx = src[i + 1];
          v += nx === 'n' ? '\n' : nx === 't' ? '\t' : nx === 'r' ? '\r' : nx;
          if (nx === '\n') line += 1;
          i += 2;
          continue;
        }
        if (src[i] === '\n') line += 1;
        v += src[i];
        i += 1;
      }
      i += 1;
      toks.push({ t: 'str', v, line: startLine });
      continue;
    }
    if (c === '`') {
      const startLine = line;
      i += 1;
      let v = '';
      while (i < n && src[i] !== '`') {
        if (src[i] === '\n') line += 1;
        v += src[i];
        i += 1;
      }
      i += 1;
      toks.push({ t: 'str', v, line: startLine });
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      let w = '';
      const startLine = line;
      while (i < n && /[A-Za-z0-9_$]/.test(src[i])) {
        w += src[i];
        i += 1;
      }
      toks.push({ t: 'word', v: w, line: startLine });
      continue;
    }
    if (!/\s/.test(c)) toks.push({ t: 'punc', v: c, line });
    i += 1;
  }
  return toks;
}

function parseDictModule(src) {
  const toks = tokenize(src);
  let idx = -1;
  for (let k = 0; k < toks.length - 1; k += 1) {
    if (
      toks[k].t === 'punc' &&
      toks[k].v === '=' &&
      toks[k + 1].t === 'punc' &&
      toks[k + 1].v === '{'
    ) {
      idx = k + 1;
      break;
    }
  }
  if (idx < 0) return { entries: [], error: '未找到 `= {` 对象字面量起点' };

  const entries = [];
  let depth = 0;
  let pendingKey = null;
  let sawColon = false;
  let error = null;
  const unparsed = [];

  for (let i = idx; i < toks.length; i += 1) {
    const tk = toks[i];
    if (tk.t === 'punc' && tk.v === '{') {
      depth += 1;
      continue;
    }
    if (tk.t === 'punc' && tk.v === '}') {
      depth -= 1;
      if (depth === 0) break;
      continue;
    }
    if (depth !== 1) continue;
    if (tk.t === 'punc' && tk.v === ':') {
      sawColon = true;
      continue;
    }
    if (tk.t === 'punc' && tk.v === ',') {
      pendingKey = null;
      sawColon = false;
      continue;
    }
    if ((tk.t === 'str' || tk.t === 'word') && !sawColon) {
      pendingKey = tk;
      continue;
    }
    if (tk.t === 'str' && sawColon && pendingKey) {
      entries.push({
        key: pendingKey.v,
        value: tk.v,
        keyLine: pendingKey.line,
        valueLine: tk.line,
      });
      pendingKey = null;
      sawColon = false;
      continue;
    }
    if (tk.t === 'word' && sawColon) {
      unparsed.push(`第 ${tk.line} 行出现非字符串 value（${tk.v}）`);
      continue;
    }
    if (tk.t === 'punc') unparsed.push(`第 ${tk.line} 行出现意外符号 ${tk.v}`);
  }
  if (unparsed.length > 0) error = unparsed.slice(0, 3).join('；');
  return { entries, error };
}

// ── 加载并合并（复刻 index.ts：按 glob 路径字典序，后者覆盖前者）────────────
if (!fs.existsSync(DICT_DIR)) {
  console.log(`✗ 找不到字典目录：${DICT_DIR}`);
  process.exit(1);
}
const moduleFiles = fs
  .readdirSync(DICT_DIR)
  .filter((f) => f.endsWith('.ts') && f !== 'index.ts')
  .sort();

const parseErrors = [];
const entries = [];
for (const file of moduleFiles) {
  const src = fs.readFileSync(path.join(DICT_DIR, file), 'utf8');
  const { entries: parsed, error } = parseDictModule(src);
  if (error) parseErrors.push(`${file}: ${error}`);
  for (const e of parsed) entries.push({ ...e, file });
}

// key → 按合并顺序出现的全部定义
const occurrences = new Map();
for (const e of entries) {
  if (!occurrences.has(e.key)) occurrences.set(e.key, []);
  occurrences.get(e.key).push(e);
}
// 合并后的最终字典（后者覆盖前者）
const merged = new Map();
for (const [key, list] of occurrences) merged.set(key, list[list.length - 1]);

const allKeys = [...merged.keys()];
const concreteKeys = allKeys.filter((k) => placeholderNames(k).length === 0);
const templateKeys = allKeys.filter((k) => placeholderNames(k).length > 0);

// ── 收集 `t()/tr()/tNode()` 调用点（仅产品代码，供模板冲突与用法检查）──────
// 只在 apps/web/src（去掉 i18n/dict）里找**字符串字面量**实参；动态变量、
// 模板字面量与服务端返回的串无法静态枚举，故本检查天生偏保守。
function stripComments(src) {
  // 逐字符替换为空格（保留换行），保证剥离后**偏移量与行号与原文件一致**。
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') {
        out += ' ';
        i += 1;
      }
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      i += 2;
      out += '  ';
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
        out += src[i] === '\n' ? '\n' : ' ';
        i += 1;
      }
      if (i < n) {
        out += '  ';
        i += 2;
      }
      continue;
    }
    if (c === "'" || c === '"') {
      const q = c;
      out += c;
      i += 1;
      while (i < n && src[i] !== q) {
        out += src[i];
        if (src[i] === '\\') {
          i += 1;
          if (i < n) out += src[i];
        }
        i += 1;
      }
      if (i < n) {
        out += src[i];
        i += 1;
      }
      continue;
    }
    if (c === '`') {
      // 模板字面量原样保留（不解析 ${}，但至少不会误伤字符串边界）
      out += c;
      i += 1;
      while (i < n && src[i] !== '`') {
        out += src[i];
        if (src[i] === '\\') {
          i += 1;
          if (i < n) out += src[i];
        }
        i += 1;
      }
      if (i < n) {
        out += src[i];
        i += 1;
      }
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

function walkFiles(dir, acc) {
  let ents;
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of ents) {
    if (['node_modules', 'dist', '.git', '.slim', 'coverage'].includes(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkFiles(p, acc);
    else acc.push(p);
  }
  return acc;
}

const webSrcRoot = path.join(repoRoot, 'apps/web/src');
const callSites = []; // { fn, literal, file, line }
const callFileCache = new Map();
const callLiteralRe = /(?<![\w.$])(t|tr|tNode)\(\s*(['"])((?:\\.|(?!\2).)*)\2/g;

if (fs.existsSync(webSrcRoot)) {
  const srcFiles = walkFiles(webSrcRoot, []).filter(
    (f) => /\.(ts|tsx|mts|cts|js|jsx)$/.test(f) && !f.startsWith(DICT_DIR + path.sep),
  );
  for (const f of srcFiles) {
    const raw = fs.readFileSync(f, 'utf8');
    const code = stripComments(raw);
    callFileCache.set(f, code);
    let m;
    callLiteralRe.lastIndex = 0;
    while ((m = callLiteralRe.exec(code))) {
      const literal = m[3].replace(/\\(['"\\])/g, '$1');
      const line = code.slice(0, m.index).split('\n').length;
      callSites.push({ fn: m[1], literal, file: path.relative(repoRoot, f), line });
    }
  }
}
const callLiterals = new Set(callSites.map((c) => c.literal));

// ── 检查结果收集 ────────────────────────────────────────────────────────────
const fatal = [];
const warn = [];
const info = [];

// (1) 占位符不匹配（key 的 {x} 集合 ≠ value 的 {x} 集合）
for (const [key, occ] of occurrences) {
  const final = merged.get(key);
  const keyNames = [...new Set(placeholderNames(key))].sort();
  const valNames = [...new Set(placeholderNames(final.value))].sort();
  if (keyNames.join(',') !== valNames.join(',')) {
    const onlyKey = keyNames.filter((x) => !valNames.includes(x));
    const onlyVal = valNames.filter((x) => !keyNames.includes(x));
    fatal.push({
      check: 'placeholder-mismatch',
      key,
      file: final.file,
      line: final.keyLine,
      detail: [
        onlyKey.length ? `key 里有 value 没有：{${onlyKey.join('} {')}}` : '',
        onlyVal.length ? `value 里有 key 没有：{${onlyVal.join('} {')}}` : '',
      ]
        .filter(Boolean)
        .join('；'),
    });
  }
}

// (2) 模板 key 冲突，两类：
//   (2a) 单位模板 `{m}m` 式：占位符紧跟孤立 h/m/s。现行按数字捕获，其正则
//        若仍能命中另一个**具体字典 key**，说明单位收紧失效，报错。
//   (2b) 任意模板正则命中**未翻译的调用点字面量**——这正是 `Close room` 被
//        `{m}m` 吞掉的判定条件（当时 'Close room' 不在字典里）。exact-first
//        使「命中具体字典 key」无害，那类重叠仅作信息展示（见下）。
for (const tk of templateKeys) {
  const generic = compileGeneric(tk);
  const actual = compileActual(tk);
  const isUnit = generic.source !== actual.source;

  if (isUnit) {
    const liveHits = concreteKeys.filter((ck) => actual.test(ck) && ck !== tk);
    for (const hit of liveHits) {
      fatal.push({
        check: 'template-conflict',
        key: tk,
        file: merged.get(tk).file,
        line: merged.get(tk).keyLine,
        detail: `单位模板的数字正则命中具体 key ${JSON.stringify(hit)}（\`{m}m\` 式冲突）`,
      });
    }
  }
  for (const lit of callLiterals) {
    if (merged.has(lit)) continue; // 精确命中优先，模板不会接管
    if (actual.test(lit)) {
      const loc = callSites.find((c) => c.literal === lit);
      fatal.push({
        check: 'template-conflict',
        key: tk,
        file: merged.get(tk).file,
        line: merged.get(tk).keyLine,
        detail: `模板命中未翻译的调用点字面量 ${JSON.stringify(lit)}${
          loc ? `（${loc.file}:${loc.line}）` : ''
        }`,
      });
    }
  }
}

// (2c) 信息：单位模板在「修复前通用编译」下会命中哪些具体 key —— 量化被
//      数字捕获中和掉的历史风险（`{m}m` → Platform / Create room …）。
const neutralized = [];
for (const tk of templateKeys) {
  const generic = compileGeneric(tk);
  const actual = compileActual(tk);
  if (generic.source === actual.source) continue; // 只看单位模板
  const hits = concreteKeys.filter((ck) => generic.test(ck) && ck !== tk);
  const liveHits = concreteKeys.filter((ck) => actual.test(ck) && ck !== tk);
  neutralized.push({ key: tk, genericHits: hits, liveHits });
}

// (3) 重复 key（同 key 在不同模块重复定义）
//     同值 → 冗余提示；不同值 → 后者静默覆盖前者，属必查错误。
//     若两个页面确实要用同一英文词表达不同含义，正确修法是让调用方各用各的
//     key，而不是在这里登记白名单（白名单会随代码漂移，掩盖真回归）。

for (const [key, list] of occurrences) {
  if (list.length < 2) continue;
  const values = [...new Set(list.map((x) => x.value))];
  const where = list.map((x) => `${x.file}:${x.keyLine}`).join(' + ');
  if (values.length === 1) {
    warn.push({
      check: 'duplicate-key',
      key,
      detail: `同值重复定义（冗余）：${where}`,
    });
    continue;
  }
  fatal.push({
    check: 'duplicate-key',
    key,
    detail: `同 key 不同 value，后者静默覆盖：${where}（值：${values
      .map((v) => JSON.stringify(v))
      .join(' / ')}）`,
  });
}

// (4) 大小写归一化冲突（tr() 用首字母小写表；仅提示，不致命）
const normMap = new Map();
for (const key of allKeys) {
  const nk = key.length === 0 ? key : key[0].toLowerCase() + key.slice(1);
  if (!normMap.has(nk)) normMap.set(nk, []);
  normMap.get(nk).push(key);
}
for (const [nk, keys] of normMap) {
  if (keys.length > 1 && new Set(keys).size > 1) {
    info.push({
      check: 'normalized-collision',
      detail: `首字母归一化后同名 ${JSON.stringify(nk)}：${keys.map((k) => JSON.stringify(k)).join(' / ')}（tr() 仅后定义者生效）`,
    });
  }
}

// (5) 孤儿 key（保守，只报告不删）
//     ⚠️ 动态字典：key 可能来自变量拼接、服务端返回、模板串或测试，字面量搜不到
//     不等于没被引用。故只对「无占位符、固定文本 ≥ 12 字符」的 key 做报告，
//     并列出搜索范围；绝不自动删除。
const ORPHAN_MIN_FIXED = 12;
if (entries.length > 0) {
  const searchRoots = ['apps', 'packages', 'docs', 'scripts']
    .map((g) => path.join(repoRoot, g))
    .filter((d) => fs.existsSync(d));
  const corpusFiles = [];
  for (const root of searchRoots) walkFiles(root, corpusFiles);
  const sourceExt = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|json|md|html|css)$/;
  const outside = corpusFiles.filter(
    (f) => sourceExt.test(f) && !f.startsWith(DICT_DIR + path.sep),
  );
  let corpus = '';
  for (const f of outside) {
    try {
      corpus += '\n' + fs.readFileSync(f, 'utf8');
    } catch {
      /* 忽略二进制/权限问题 */
    }
  }
  const orphanCandidates = [];
  for (const key of allKeys) {
    const names = placeholderNames(key);
    const fixed = key.replace(PLACEHOLDER, '').replace(/\s+/g, ' ').trim();
    if (fixed.length < ORPHAN_MIN_FIXED) continue;
    let found;
    if (names.length === 0) {
      found = corpus.includes(key);
    } else {
      // 模板 key：按固定片段做「有界通配」匹配，容忍运行时拼接
      // （用无捕获组的切分正则，避免把占位符名本身当成搜索片段）
      const segs = key
        .split(/\{[A-Za-z_][A-Za-z0-9_]*\}/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
        .map(escapeRegExp);
      if (segs.length === 0) continue;
      const re = new RegExp(segs.join('[\\s\\S]{0,40}?'));
      found = re.test(corpus);
    }
    if (!found) {
      const def = merged.get(key);
      orphanCandidates.push({ key, file: def.file, line: def.keyLine });
    }
  }
  if (orphanCandidates.length > 0) {
    info.push({
      check: 'orphan-key',
      count: orphanCandidates.length,
      list: orphanCandidates.slice(0, 200),
    });
  }
  info.push({
    check: 'orphan-scope',
    detail: `在 ${outside.length} 个文件中搜索（apps/ packages/ docs/ scripts/，排除 dict/ 自身与依赖/构建产物）`,
  });
}

// (6) 用法错误（保守）：`t('KEY', { ... })` 静态调用里，KEY 的占位符与实参
//     属性名不一致。仅处理字符串字面量首参 + 对象字面量次参；动态实参跳过。
function readVarsKeys(src, start) {
  // start 指向 `{`；返回顶层属性名列表（含 shorthand），或 null 表示解析不了
  let i = start;
  let depth = 0;
  const keys = [];
  let hasSpread = false;
  const n = src.length;
  let expectKey = false;
  while (i < n) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      const q = c;
      i += 1;
      while (i < n && src[i] !== q) {
        if (src[i] === '\\') i += 1;
        i += 1;
      }
      i += 1;
      expectKey = false;
      continue;
    }
    if (c === '{') {
      depth += 1;
      expectKey = depth === 1;
      i += 1;
      continue;
    }
    if (c === '}') {
      depth -= 1;
      i += 1;
      if (depth === 0) return { keys, hasSpread };
      continue;
    }
    if (depth === 1 && c === '.' && src.slice(i, i + 3) === '...') {
      hasSpread = true;
      i += 3;
      continue;
    }
    if (depth === 1 && /[A-Za-z_$]/.test(c) && expectKey) {
      let w = '';
      while (i < n && /[A-Za-z0-9_$]/.test(src[i])) {
        w += src[i];
        i += 1;
      }
      keys.push(w);
      expectKey = false;
      continue;
    }
    if (depth === 1 && (c === ',' || c === '\n')) {
      if (c === ',') expectKey = true;
      i += 1;
      continue;
    }
    i += 1;
  }
  return null;
}

const usageRe = /(?<![\w.$])(?:t|tr|tNode)\(\s*(['"])((?:\\.|(?!\1).)*)\1\s*,/g;
for (const [f, code] of callFileCache) {
  let m;
  usageRe.lastIndex = 0;
  while ((m = usageRe.exec(code))) {
    const literal = m[2].replace(/\\(['"\\])/g, '$1');
    const keyNames = [...new Set(placeholderNames(literal))];
    if (keyNames.length === 0) continue; // 无占位符的 key 传不传 vars 都无害
    let j = usageRe.lastIndex;
    while (j < code.length && /\s/.test(code[j])) j += 1;
    if (code[j] !== '{') continue; // 次参不是对象字面量（可能是变量/undefined），跳过
    const parsed = readVarsKeys(code, j);
    if (!parsed || parsed.hasSpread) continue;
    const provided = new Set(parsed.keys);
    const missing = keyNames.filter((k) => !provided.has(k));
    if (missing.length > 0) {
      const line = code.slice(0, m.index).split('\n').length;
      warn.push({
        check: 't() 用法',
        key: literal,
        detail: `${path.relative(repoRoot, f)}:${line} 未传入 {${missing.join('} {')}}；缺参时 t() 会原样返回 source`,
      });
    }
  }
}

// ── 输出 ────────────────────────────────────────────────────────────────────
const line = (s = '') => console.log(s);

line('i18n 字典检查（apps/web/src/shared/i18n/dict）');
line(
  `读取：${moduleFiles.length} 个 dict 模块 / ${entries.length} 条词条；合并后 ${allKeys.length} 个唯一 key（其中模板 key ${templateKeys.length}）`,
);
if (parseErrors.length > 0) {
  line('');
  line(`⚠ 解析告警（${parseErrors.length}）——若因此漏检请人工复核：`);
  for (const e of parseErrors) line(`    ${e}`);
}

if (fatal.length > 0) {
  line('');
  line(`✗ 必查错误 ${fatal.length} 项：`);
  for (const f of fatal) {
    line(`  [${f.check}] ${JSON.stringify(f.key)}  @ ${f.file}:${f.line}`);
    if (f.detail) line(`      ${f.detail}`);
  }
} else {
  line('');
  line('✓ 必查项全部通过（占位符匹配 / 模板冲突 / 未登记的不同值重复 key）');
}

if (warn.length > 0) {
  line('');
  line(`⚠ 提示 ${warn.length} 项（不阻断）：`);
  for (const w of warn) line(`  [${w.check}] ${JSON.stringify(w.key)} — ${w.detail}`);
}

line('');
line(
  `· 单位模板（信息）：${neutralized.length} 个「数字+单位」模板在修复前通用编译下会命中具体字典 key。`,
);
line('  现行已用数字捕获收紧，精确 key 又优先于模板，故这些重叠不构成运行时冲突；');
line('  列出全部，便于确认 `{m}m` 类风险未回归：');
for (const n of neutralized) {
  line(
    `    ${JSON.stringify(n.key)} → 通用编译命中 ${n.genericHits.length} 个具体 key，现行编译命中 ${n.liveHits.length} 个${
      n.liveHits.length > 0
        ? `（⚠ 现行仍命中：${n.liveHits
            .slice(0, 3)
            .map((x) => JSON.stringify(x))
            .join(', ')}）`
        : ''
    }`,
  );
}

if (info.length > 0) {
  line('');
  line('· 应查项（保守 / 只报告不改）：');
  for (const it of info) {
    if (it.check === 'orphan-key') {
      line('');
      line(`  [orphan-key] ${it.count} 个 key 的固定文本在全仓（dict 之外）搜不到；`);
      line(
        '      孤立 ≠ 未用：key 可能经变量拼接、服务端返回或模板串引用，请人工复核后再决定，切勿据此删除。',
      );
      for (const o of it.list) line(`      ${JSON.stringify(o.key)}  @ ${o.file}:${o.line}`);
      if (it.count > it.list.length) line(`      …另有 ${it.count - it.list.length} 条未展开`);
    } else if (it.check === 'orphan-scope') {
      line(`  [orphan-key] 搜索范围：${it.detail}`);
    } else {
      line(`  [${it.check}] ${it.detail}`);
    }
  }
}

line('');
line('说明：本脚本是静态近似，不能替代运行时测试。t()/tr() 的模板匹配、服务端返回');
line('字符串与变量拼接都无法完全静态枚举；「孤儿 key」「大小写归一化冲突」仅作线索，');
line(
  '不得据此自动删除或改写。模板编译规则改动时，请同步本脚本与 apps/web/test/i18nTemplate.test.ts。',
);

if (fatal.length > 0) process.exit(1);
