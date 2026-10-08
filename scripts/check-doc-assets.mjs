#!/usr/bin/env node
/**
 * check-doc-assets.mjs — docs/qa 证据文档的「引用完整性」门禁。
 *
 * 对应 BACKLOG B15 的可自动化指标：**被引用的图片路径缺失数 = 0**。
 * （体积阈值已被否决：8.5M 不是问题；真正该测的是引用是否都在。）
 *
 * 它做什么：扫 `docs/qa/**` + `tools/visual/**` 里的文档/报告/预览源码，抽出「看起来是仓库内相对路径」
 * 的素材引用，逐一 `stat` 文件是否存在，缺什么列什么。
 *
 * 检测的引用格式（都是 docs/qa 里实际出现的形态，不是凭空假设）：
 *   - `.md`：行内 code span，如 `gg-green-desktop.jpg`、`after/overlap.json`
 *     （证据 README 主要靠这个列清单）；markdown 图片/链接目标 `](path)`；
 *     HTML 属性 src/href。
 *   - `.json`：字符串值，如 "docs/qa/bot-live/01-room-entry.jpg"（仓库根相对）
 *     或 "real-overview-1440.jpg"（相对本文件目录，见 stats-pro/real-result.json）。
 *   - `.mjs` / `.tsx` / `.js` / `.css` / `.html`：字符串字面量与 url(...)。
 *
 * 解析规则：以仓库顶层目录名（docs/apps/packages/scripts/.slim）开头的
 * 引用按仓库根解析；其余按「引用所在文件的目录」解析；解析结果落在仓库
 * 之外的一律跳过（如 /tmp、~、绝对路径）。
 *
 * ── 跳过规则（避免误报；宁可漏报，不可误杀）─────────────────────────────
 *   1. 带 scheme 的 URL（`http://`、`https://` 等）与协议相对 `//host`
 *   2. `#anchor` 片段
 *   3. `data:` URI
 *   4. 通配符 / glob（含 `*` 或 `?`），如 `overview-*`、`desktop-*.jpg`
 *   5. 以 `-` 开头的后缀片段，如 `-900ms.jpg`、`-2x.jpg`、`-pod.jpg`
 *      （它们在正文里补全前一个路径，本身不是路径）
 *   6. 裸扩展名，如 `.jpg`、`.json`、`.md`（docs/qa/README 讲「换 .jpg」这类）
 *   7. 绝对路径 / 家目录（以 `/`、`~` 开头）与 Windows 盘符
 *   8. 含空白、`=`、`$`、`<`、`>`、`{}`、反引号的 token（命令行赋值、占位符）
 *   9. 扩展名不在素材白名单内（图片 + `.json`）。**源码文件名（.mjs/.tsx/
 *      .css/.html/.md）刻意不当素材**：README 正文里大量提到 `table-pod.css`、
 *      `RoundTable.tsx` 这类源码文件名，它们不在 docs/qa 下，误报成本高。
 *  10. 代码文件里的注释内容（行注释 //、块注释、HTML 注释）先剔除再抽取。
 *  11. md 围栏代码块（``` / ~~~）整体剔除，块内的 inline code span 同样不算。
 *  12. `.json` 走 JSON.parse：只认对象/数组里的「值」，所有 key 一律跳过
 *      （`"missing-key.jpg": "x"` 的 key 不是素材引用）。解析失败则整文件跳过
 *      并打 WARN——宁可漏报，也不拿正则去猜 key/value，避免误报。
 *
 * ⚠ 边界（这是「素材完整性门禁」，不是通用链接检查）：不查源码文件名引用、
 *   不展开 glob、不校验 URL 可达性、不校验图片内容；同一 (file, ref) 只记一次。
 *
 * 文件级豁免（EXEMPT，显式清单）：当前已知缺失，每条带原因 + 出处。
 * 设计原则与 audit-docs.mjs 一致：豁免是「显式列出 + 写明原因 + 写明出处」，
 * 不是默认不查；新引用永远会被检查；--strict 下豁免关闭、当前缺失照报。
 *
 * Usage:
 *   node scripts/check-doc-assets.mjs             # 扫描（豁免生效）
 *   node scripts/check-doc-assets.mjs --strict    # 关闭豁免（CI 追平后可切换）
 *   node scripts/check-doc-assets.mjs --selftest  # 自证检测器：存在/缺失/URL/通配/片段…
 *   node scripts/check-doc-assets.mjs --help      # 打印上述边界
 * Exit: 0 = 无（未豁免的）缺失, 1 = 有缺失, 2 = 参数错误。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findRepoRoot } from './lib/repo-root.mjs';

const repoRoot = findRepoRoot(import.meta.url);
const QA_DIR = path.join(repoRoot, 'docs', 'qa');
// 独立预览应用已从 docs/qa 归位到 tools/visual（docs/qa 只留证据截图 + README）。
// 一并纳入扫描：搬走的 preview 源码里的素材引用不会因此脱离门禁。
const VISUAL_DIR = path.join(repoRoot, 'tools', 'visual');

// ---------- 素材白名单 ----------
// 只把「图片 + .json」当素材引用。源码扩展名不进白名单（见头部跳过规则 9）。
const ASSET_EXT_RE = /\.(jpe?g|png|webp|gif|svg|avif|bmp|ico|json)$/i;

// 按扩展名决定如何抽取引用。
const CONTAINING_KIND = {
  '.md': 'md',
  '.json': 'json',
  '.mjs': 'js',
  '.js': 'js',
  '.tsx': 'js',
  '.ts': 'js',
  '.css': 'css',
  '.html': 'html',
};

// 以仓库顶层目录名开头的引用按仓库根解析。
const REPO_TOP = new Set(['docs', 'apps', 'packages', 'scripts', 'tools', '.slim']);

// ---------- 显式文件级豁免清单 ----------
// 每条必须有 reason（为什么不是漏检） + source（出处）。加新条目 = 需要一次明确裁决。
const EXEMPT = [
  {
    file: 'docs/qa/table-motion/README.md',
    ref: 'motion-in-progress.jpg',
    reason: '文件被刻意排除：README 明确写「这两张进行中截图不提交到仓库」，由 fixture 输出到 UAT_OUTPUT（动画时间点无法稳定复现）。属有据不提交，不是漏检',
    source: 'docs/qa/table-motion/README.md:3-8',
  },
  {
    file: 'docs/qa/table-motion/README.md',
    ref: 'reduced-motion-static.jpg',
    reason: '同上：README 明确写「不提交到仓库」，输出到 UAT_OUTPUT',
    source: 'docs/qa/table-motion/README.md:3-8',
  },
];
const exemptionFor = (relFile, ref) =>
  EXEMPT.find((e) => e.file === relFile && e.ref === ref) || null;

// ---------- 抽取 ----------
/** 行号：1-based，按字符下标换算。 */
function lineAt(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text[i] === '\n') line++;
  return line;
}

/** 代码文件先剔除注释（保留换行，行号不乱）。md 不调用本函数。 */
function stripComments(text, kind) {
  const blank = (s) => s.replace(/[^\n]/g, ' ');
  let out = text;
  if (kind === 'js' || kind === 'css') {
    out = out.replace(/\/\*[\s\S]*?\*\//g, blank);
  }
  if (kind === 'js') {
    // 行注释：`//` 且前面不是 `:`（避免吃 `http://`）
    out = out.replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length));
  }
  if (kind === 'html') {
    out = out.replace(/<!--[\s\S]*?-->/g, blank);
  }
  return out;
}

/**
 * 显式剔除 md 围栏代码块（``` / ~~~），内容整体置空但保留换行（行号不乱）。
 * 围栏内的 inline code span 也因此不再被抽取——与头部「跳过围栏代码」的声明一致。
 */
function stripFencedBlocks(text) {
  const lines = text.split('\n');
  let fence = null;
  for (let i = 0; i < lines.length; i++) {
    const open = lines[i].match(/^\s*(`{3,}|~{3,})/);
    if (fence === null) {
      if (open) {
        fence = open[1][0];
        lines[i] = ' '.repeat(lines[i].length);
      }
      continue;
    }
    // 已在围栏内：整行置空；遇到同字符的闭合围栏则结束
    const close = lines[i].match(/^\s*(`{3,}|~{3,})\s*$/);
    lines[i] = ' '.repeat(lines[i].length);
    if (close && close[1][0] === fence) fence = null;
  }
  return lines.join('\n');
}

/**
 * JSON 专用抽取：先用 JSON.parse 定权（只认对象/数组里的「值」，跳过所有 key），
 * 再用正则回到原文定位行号。解析失败时返回 parseError，由调用方跳过并告警。
 * 这样 `"missing-key.jpg": "x"` 的 key 不会被当引用；`"docs\/qa\/a.jpg"` 的转义
 * 路径也会经 JSON.parse 还原为正常路径。
 * @returns {{rows:{ref:string,line:number}[], parseError:string|null}}
 */
function extractJsonCandidates(text) {
  const rows = [];
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { rows, parseError: err.message };
  }
  const values = new Set();
  const collect = (v) => {
    if (typeof v === 'string') values.add(v);
    else if (Array.isArray(v)) v.forEach(collect);
    else if (v && typeof v === 'object') Object.values(v).forEach(collect);
  };
  collect(parsed);
  // 字符串字面量；紧跟 `:` 的是 key，跳过
  const re = /"((?:[^"\\\n]|\\.)*)"\s*(:)?/g;
  let m;
  while ((m = re.exec(text))) {
    if (m[2] === ':') continue; // key
    let logical;
    try {
      logical = JSON.parse('"' + m[1] + '"');
    } catch {
      logical = m[1];
    }
    if (!values.has(logical)) continue; // 不是解析出来的值（如注释残片）
    rows.push({ ref: logical.trim(), line: lineAt(text, m.index + 1) });
  }
  return { rows, parseError: null };
}

/** 从文本抽取候选引用（尚未过滤）。@returns {{ref:string,line:number}[]} */
function extractCandidates(text, kind) {
  const rows = [];
  const push = (raw, index) => {
    const ref = String(raw ?? '').trim();
    if (!ref) return;
    rows.push({ ref, line: lineAt(text, index) });
  };
  if (kind === 'md') {
    for (const m of text.matchAll(/`([^`\n]+)`/g)) push(m[1], m.index + 1);
    // markdown 图片/链接目标，去掉可选 title：![x](a.png "t")
    for (const m of text.matchAll(/!?\[[^\]]*\]\(([^)\n]+)\)/g)) {
      const target = m[1].replace(/\s+["'][^"']*["']\s*$/, '').trim();
      push(target, m.index + m[0].indexOf('(') + 1);
    }
    for (const m of text.matchAll(/(?:src|href)\s*=\s*["']([^"']+)["']/gi)) push(m[1], m.index);
    return rows;
  }
  // json / js / css / html：字符串字面量 + url(...)
  for (const m of text.matchAll(/"((?:[^"\\\n]|\\.)*)"/g)) push(m[1], m.index + 1);
  for (const m of text.matchAll(/'((?:[^'\\\n]|\\.)*)'/g)) push(m[1], m.index + 1);
  for (const m of text.matchAll(/`((?:[^`\\\n]|\\.)*)`/g)) push(m[1], m.index + 1);
  for (const m of text.matchAll(/url\(\s*["']?([^"')]+?)["']?\s*\)/gi)) push(m[1], m.index);
  return rows;
}

/**
 * 判定一个候选是否算「仓库内相对路径素材引用」。
 * @returns {string|null} 规范化后的引用，或 null（跳过）
 */
function asRepoRelativeRef(raw) {
  const t = String(raw ?? '').trim();
  if (!t) return null;
  if (t.includes('://')) return null; // 1. URL
  if (t.startsWith('//')) return null; // 1. 协议相对
  if (t.startsWith('#')) return null; // 2. anchor
  if (t.startsWith('data:')) return null; // 3. data URI
  if (/[*?]/.test(t)) return null; // 4. 通配符
  if (t.startsWith('-')) return null; // 5. 后缀片段
  if (/^\.(?!\.?\/)/.test(t)) return null; // 6. 裸扩展名（.jpg），但放行 ./ 与 ../
  if (t.startsWith('/') || t.startsWith('~')) return null; // 7. 绝对 / 家目录
  if (/^[A-Za-z]:[\\/]/.test(t)) return null; // 7. Windows 盘符
  if (/[\s<>${}`=\\=]/.test(t)) return null; // 8. 空白 / 占位 / env / 赋值
  if (!ASSET_EXT_RE.test(t)) return null; // 9. 非素材扩展名
  return t;
}

/** 解析引用 → 绝对路径；落在仓库外返回 null。 */
function resolveRef(containingAbs, ref) {
  const first = ref.split('/')[0];
  const base = REPO_TOP.has(first) ? repoRoot : path.dirname(containingAbs);
  const target = path.normalize(path.join(base, ...ref.split('/')));
  const rootWithSep = repoRoot.endsWith(path.sep) ? repoRoot : repoRoot + path.sep;
  if (target !== repoRoot && !target.startsWith(rootWithSep)) return null; // 出仓库
  return target;
}

/** 扫一段文本（供 selftest 与真实文件共用）。 */
function scanText(relFile, absFile, text, kind) {
  let clean = stripComments(text, kind); // 注释内容先剔除（保留换行，行号不乱）
  if (kind === 'md') clean = stripFencedBlocks(clean); // 围栏代码块整体剔除

  let candidates;
  let warn = null;
  if (kind === 'json') {
    const res = extractJsonCandidates(clean);
    candidates = res.rows;
    if (res.parseError) {
      warn = `JSON 解析失败，跳过该文件（宁可漏报）：${res.parseError}`;
    }
  } else {
    candidates = extractCandidates(clean, kind);
  }

  const rows = [];
  const seen = new Set(); // 去重：同一 (file, ref) 只记一次（CSS url() 与字符串会重复命中）
  let skipped = 0;
  for (const { ref: raw, line } of candidates) {
    const ref = asRepoRelativeRef(raw);
    if (!ref) {
      skipped++;
      continue;
    }
    if (seen.has(ref)) continue;
    seen.add(ref);
    const target = resolveRef(absFile, ref);
    if (!target) {
      skipped++;
      continue;
    }
    const exists = fs.existsSync(target);
    const exempt = exists ? null : exemptionFor(relFile, ref);
    rows.push({ file: relFile, line, ref, target, exists, exempt, raw });
  }
  return { rows, skipped, warn };
}

// ---------- 发现 ----------
function discoverFiles(dir) {
  const out = [];
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (CONTAINING_KIND[path.extname(entry.name).toLowerCase()]) out.push(p);
    }
  };
  walk(dir);
  return out.sort();
}

// ---------- 报告 ----------
function rel(p) {
  return path.relative(repoRoot, p).split(path.sep).join('/');
}

function runScan({ strict = false } = {}) {
  if (!fs.existsSync(QA_DIR)) {
    console.error(`REFUSE: no such directory ${QA_DIR}`);
    process.exit(2);
  }
  const scanDirs = [QA_DIR, VISUAL_DIR].filter((d) => fs.existsSync(d));
  const files = scanDirs.flatMap((d) => discoverFiles(d)).sort();
  let refs = 0;
  let skipped = 0;
  const missing = [];
  const warnings = [];
  for (const abs of files) {
    const kind = CONTAINING_KIND[path.extname(abs).toLowerCase()];
    const text = fs.readFileSync(abs, 'utf8');
    const relFile = rel(abs);
    const { rows, skipped: s, warn } = scanText(relFile, abs, text, kind);
    refs += rows.length;
    skipped += s;
    if (warn) warnings.push(`${relFile}: ${warn}`);
    for (const r of rows) if (!r.exists) missing.push(r);
  }
  for (const w of warnings) console.log(`WARN ${w}`);

  const scanLabel = scanDirs.map((d) => `${rel(d)}/**`).join(' + ');
  console.log(`check-doc-assets: scan ${scanLabel}  (${files.length} files, ${refs} asset refs, ${skipped} tokens skipped)`);
  if (!missing.length) {
    console.log('✓ 所有被引用的素材路径都存在');
    return { refs, missing: [], active: [] };
  }

  const active = [];
  console.log(`\n缺失引用 ${missing.length} 处：`);
  for (const m of missing) {
    const ex = strict ? null : m.exempt;
    if (!ex) active.push(m);
    const tag = ex ? '  [EXEMPT]' : '  *** MISSING';
    console.log(`${tag} ${m.file}:${m.line}  →  ${m.ref}`);
    if (ex) {
      console.log(`            reason: ${ex.reason}`);
      console.log(`            source: ${ex.source}`);
    }
  }
  const exemptCount = missing.length - active.length;
  console.log(
    `\nSUMMARY: ${refs} refs, ${missing.length} missing` +
      (strict ? ' (strict: exemptions OFF)' : ` (${exemptCount} exempt, ${active.length} active)`) +
      (active.length ? ' → FAIL' : ' → PASS (all missing are documented exemptions)'),
  );
  return { refs, missing, active };
}

function printHelp() {
  console.log(`check-doc-assets — docs/qa 证据文档「引用完整性」门禁

扫描 docs/qa/** 与 tools/visual/** 下 ${Object.keys(CONTAINING_KIND).join(' / ')} 里的素材引用并 stat 存在性。
素材扩展名白名单：图片（jpg/jpeg/png/webp/gif/svg/avif/bmp/ico）+ .json。
解析：docs/apps/packages/scripts/.slim 开头 → 仓库根；其余 → 引用所在文件目录；出仓库则跳过。

跳过规则（宁可漏报）：URL、协议相对 //、#anchor、data: URI、通配符 * ?、
后缀片段 -xxx.jpg、裸扩展名 .jpg、绝对/家目录、Windows 盘符、含空白/占位/env/赋值符、
非素材扩展名（源码文件名刻意不查）、代码文件注释内容、md 围栏代码块。
.json 用 JSON.parse 只扫「值」、跳过所有 key；解析失败整文件跳过并打 WARN。
边界：这是「素材完整性门禁」——不查源码文件名引用、不展开 glob、不校验 URL 可达性。
同一 (file, ref) 只记一次。

选项：
  --strict     关闭文件级豁免，把当前已知缺失也判为失败
  --selftest   内置用例自证检测器（存在/缺失/URL/通配/片段/豁免）
  --help       本说明
Exit: 0 = 无（未豁免）缺失, 1 = 有缺失, 2 = 参数错误。`);
}

// ---------- selftest ----------
function selftest() {
  const caseList = [
    {
      name: '存在的素材 → 命中且 exists=true',
      want: (r) => r.rows.length === 1 && r.rows[0].exists === true,
      text: '`01-flop.jpg`',
      kind: 'md',
      file: 'docs/qa/run-equity/README.md',
    },
    {
      name: '缺失的素材 → 命中且 exists=false（门禁变红的能力）',
      want: (r) => r.rows.length === 1 && r.rows[0].exists === false,
      text: '`unreleased-shot.jpg`',
      kind: 'md',
      file: 'docs/qa/zz-scratch/README.md',
    },
    {
      name: 'URL → 跳过，不产生引用',
      want: (r) => r.rows.length === 0 && r.skipped >= 1,
      text: '![x](https://example.com/a.jpg) `https://example.com/b.png`',
      kind: 'md',
      file: 'docs/qa/run-equity/README.md',
    },
    {
      name: '通配符 glob → 跳过',
      want: (r) => r.rows.length === 0,
      text: '`overview-*.jpg` `desktop-*.jpg`',
      kind: 'md',
      file: 'docs/qa/run-equity/README.md',
    },
    {
      name: '后缀片段（-900ms.jpg / -2x.jpg）→ 跳过，只留完整路径',
      want: (r) => r.rows.length === 1 && r.rows.every((x) => !x.ref.startsWith('-')),
      text: '`after-acting-phase-000ms.jpg` ... `-900ms.jpg` / `-2x.jpg`',
      kind: 'md',
      file: 'docs/qa/glow-border/README.md',
    },
    {
      name: '裸扩展名 / anchor → 跳过',
      want: (r) => r.rows.length === 0,
      text: '换 `.jpg`，见 [x](#sec) 与 `#anchor`',
      kind: 'md',
      file: 'docs/qa/run-equity/README.md',
    },
    {
      name: 'data: URI → 跳过',
      want: (r) => r.rows.length === 0,
      text: '<img src="data:image/png;base64,AAA.png">',
      kind: 'html',
      file: 'docs/qa/x/index.html',
    },
    {
      name: '仓库根相对（docs/qa/...）→ 命中且 exists=true',
      want: (r) => r.rows.length === 1 && r.rows[0].exists === true,
      text: '"docs/qa/run-equity/00-reveal.jpg"',
      kind: 'json',
      file: 'docs/qa/zz-scratch/report.json',
    },
    {
      name: '相对本文件目录（real-*.jpg）→ 命中且 exists=true',
      want: (r) => r.rows.length === 1 && r.rows[0].exists === true,
      text: '"real-overview-1440.jpg"',
      kind: 'json',
      file: 'docs/qa/stats-pro/real-result.json',
    },
    {
      name: 'JSON 里的 http base / 非素材字符串 → 跳过',
      want: (r) => r.rows.length === 0,
      text: '{"base": "http://127.0.0.1:8797", "note": "hello world"}',
      kind: 'json',
      file: 'docs/qa/zz-scratch/report.json',
    },
    {
      name: '绝对路径 /tmp 与 ~ → 跳过',
      want: (r) => r.rows.length === 0,
      text: '`LLM_PER_REQUEST_FILE=/tmp/baseline.json` `~/x.jpg`',
      kind: 'md',
      file: 'docs/qa/run-equity/README.md',
    },
    {
      name: '代码注释里的示例路径 → 剔除后跳过',
      want: (r) => r.rows.length === 0,
      text: 'const a = 1; // "example/missing.jpg"\n/* "other/gone.png" */',
      kind: 'js',
      file: 'docs/qa/zz-scratch/helper.mjs',
    },
    {
      name: '源码文件名不当素材（.css/.tsx）→ 跳过',
      run: () => {
        const s = scanText('docs/qa/glow-border/README.md', path.join(QA_DIR, 'glow-border', 'README.md'), '见 `table-pod.css` 与 `RoundTable.tsx`', 'md');
        return { ok: s.rows.length === 0, detail: `rows=${s.rows.length}, skipped=${s.skipped}` };
      },
    },
    {
      name: '豁免生效：清单内缺失不算 active',
      run: () => {
        const r = scanText('docs/qa/table-motion/README.md', path.join(QA_DIR, 'table-motion', 'README.md'), '`motion-in-progress.jpg`', 'md');
        const row = r.rows[0];
        return { ok: !!row && !row.exists && !!row.exempt, detail: `exempt=${!!row?.exempt}` };
      },
    },
    {
      name: '豁免是显式的：未列出的缺失不会有豁免',
      run: () => {
        const r = scanText('docs/qa/table-skins/README.md', path.join(QA_DIR, 'table-skins', 'README.md'), '`never-committed-anywhere.jpg`', 'md');
        const row = r.rows[0];
        return { ok: !!row && !row.exists && !row.exempt, detail: `exempt=${!!row?.exempt}` };
      },
    },
    {
      name: '每条豁免都带 reason + source（后人可查出处）',
      run: () => {
        const ok = EXEMPT.every((e) => e.reason?.length > 10 && e.source?.length > 5);
        return { ok, detail: `${EXEMPT.length} 条` };
      },
    },
    // --- 审查补的边界用例 ---
    {
      name: 'JSON 键名以 .jpg 结尾 → 不是引用，不报（问题 1 回归）',
      want: (r) => r.rows.length === 0,
      text: '{"missing-key.jpg": "not an asset value"}',
      kind: 'json',
      file: 'docs/qa/zz-scratch/report.json',
    },
    {
      name: 'JSON 转义路径 \\/ → JSON.parse 还原后命中且 exists=true',
      want: (r) => r.rows.length === 1 && r.rows[0].exists === true,
      text: '{"screenshots":["docs\\/qa\\/run-equity\\/00-reveal.jpg"]}',
      kind: 'json',
      file: 'docs/qa/zz-scratch/report.json',
    },
    {
      name: 'JSON 解析失败 → 整文件跳过并打 WARN（宁可漏报）',
      want: (r) => r.rows.length === 0 && !!r.warn,
      text: '{ this is : not json ]',
      kind: 'json',
      file: 'docs/qa/zz-scratch/broken.json',
    },
    {
      name: 'md 围栏代码块（含块内 inline code span）→ 不报',
      want: (r) => ({
        ok: r.rows.length === 1 && r.rows[0].ref === '01-flop.jpg',
        detail: `rows=[${r.rows.map((x) => x.ref).join(',')}]`,
      }),
      text: '```md\n`missing-in-fence.jpg`\n```\n围栏外见 `01-flop.jpg`',
      kind: 'md',
      file: 'docs/qa/run-equity/README.md',
    },
    {
      name: 'Markdown 图片路径 ![](path) 本地存在 → 命中且 exists=true',
      want: (r) => r.rows.length === 1 && r.rows[0].exists === true,
      text: '![flop](01-flop.jpg)',
      kind: 'md',
      file: 'docs/qa/run-equity/README.md',
    },
    {
      name: 'Markdown 图片路径 ![](path) 本地缺失 → 命中且 exists=false',
      want: (r) => r.rows.length === 1 && r.rows[0].exists === false,
      text: '![gone](gone-shot.jpg)',
      kind: 'md',
      file: 'docs/qa/run-equity/README.md',
    },
    {
      name: 'CSS url() 本地存在 → 命中且 exists=true',
      want: (r) => r.rows.length === 1 && r.rows[0].exists === true,
      text: '.a{background:url(01-flop.jpg)}',
      kind: 'css',
      file: 'docs/qa/run-equity/README.md',
    },
    {
      name: 'CSS url() 本地缺失 → 命中且 exists=false',
      want: (r) => r.rows.length === 1 && r.rows[0].exists === false,
      text: '.a{background:url(gone-css.jpg)}',
      kind: 'css',
      file: 'docs/qa/run-equity/README.md',
    },
    {
      name: 'CSS url("x") 引号 + 字符串规则重复命中 → 去重为 1 条',
      want: (r) => r.rows.length === 1,
      text: '.a{background:url("01-flop.jpg")}',
      kind: 'css',
      file: 'docs/qa/run-equity/README.md',
    },
    {
      name: '../ 逃出仓库 → 跳过（出仓库即不计）',
      want: (r) => r.rows.length === 0,
      text: '`../../../../etc/passwd.jpg`',
      kind: 'md',
      file: 'docs/qa/run-equity/README.md',
    },
    {
      name: 'HTML 注释里的路径 → 剔除后跳过',
      want: (r) => r.rows.length === 0,
      text: '<!-- <img src="missing.jpg"> -->',
      kind: 'html',
      file: 'docs/qa/zz-scratch/index.html',
    },
    {
      name: '未知参数 → exit 2',
      run: () => {
        const res = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--bogus'], { encoding: 'utf8' });
        return { ok: res.status === 2, detail: `status=${res.status}` };
      },
    },
  ];

  let bad = 0;
  console.log('SELFTEST — check-doc-assets 必须：存在→绿、缺失→红、URL/通配/片段/注释→跳过、豁免显式\n');
  for (const c of caseList) {
    let passed;
    let detail = '';
    if (c.run) {
      const res = c.run();
      passed = res.ok;
      detail = res.detail || '';
    } else {
      const probe = c.file;
      const abs = path.join(repoRoot, ...probe.split('/'));
      const r = scanText(probe, abs, c.text, c.kind);
      const v = c.want(r);
      passed = typeof v === 'boolean' ? v : v.ok;
      detail = (typeof v === 'object' && v.detail) || `rows=${r.rows.length}, skipped=${r.skipped}`;
    }
    if (!passed) bad++;
    console.log(`${passed ? 'OK  ' : 'BAD '} | ${c.name}`);
    console.log(`      ${detail}`);
  }
  console.log(bad ? `\nSELFTEST: FAIL (${bad} 个用例不符)` : '\nSELFTEST: PASS（存在/缺失/URL/通配/片段/注释/豁免 判定均符合预期）');
  process.exit(bad ? 1 : 0);
}

// ---------- main ----------
const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  printHelp();
  process.exit(0);
} else if (args.includes('--selftest')) {
  selftest();
} else {
  const strict = args.includes('--strict') || args.includes('--no-exempt');
  const unknown = args.filter((a) => a !== '--strict' && a !== '--no-exempt');
  if (unknown.length) {
    console.error(`REFUSE: unknown args ${unknown.join(' ')}（用 --help 看用法）`);
    process.exit(2);
  }
  const { active } = runScan({ strict });
  process.exit(active.length ? 1 : 0);
}
