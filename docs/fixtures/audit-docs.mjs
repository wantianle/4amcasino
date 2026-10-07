#!/usr/bin/env node
/**
 * audit-docs.mjs — docs/fixtures 下设计文档（规格稿 / mockup / deck）的轻量品牌门禁。
 *
 * 为什么不是 audit-design.mjs：主门禁的 REQUIRED（fxring/cface/座位数…）与
 * .pname 白名单是「复刻牌桌 deck」专属判据，拿它扫文档会产生大量校准噪声；
 * 它的零外链检查还会把合法的 ../media/ 相对链接误判为外链。
 * 本门禁只跑两类规则（用户裁决的口径）：
 *   1) 品牌词 banned-any ：双 G 品牌、顶栏专有玩法名、参考端全称、参考端包名
 *      前缀、分池面板专名、分池标签（实际 token 见 BRAND_TOKENS，全部运行时
 *      C() 构造——本文件不出现连写或塞空格的品牌字面量，工具自身保持 grep-clean）。
 *      规则字母间 \s* + 词边界，rev4 演示过的「字母间塞空格」绕过在这里同样会红。
 *   2) 真实玩家名 blacklist：24 个已登记 handle，同样空格容忍。
 *      诚实边界：这是黑名单，不是「任意真名」检测——文档没有 .pname 槽位可
 *      做白名单；新真名需先登记再被抓住（deck 的白名单方案不适用于自由文档）。
 *
 * 素材文件名豁免（裁决：输入素材真实名不改）：扫描前把「含 gg- 的路径 token」
 * 整体遮蔽，如 ../media/gg-reference/gg-desktop-现金桌.png、clubgg-mobile-*.jpg、
 * gg-l0-visual-baseline.html、docs/plans/…-gg-….md，以及文件名里内嵌的分池面板专名（跑马系列截图）。
 * ⚠ 注意 data: URI 不遮蔽——它渲染给用户看（favicon 里的品牌文字必须能被抓）。
 *
 * 文件级豁免（EXEMPT，显式清单）：判据夹具按旧裁决保留原样，见下方 EXEMPT 表。
 * ⚠ 设计原则：豁免是「显式列出的文件 + 写明原因 + 写明出处」，不是默认不扫——
 *   新增文件永远会被全查；被豁免的文件在 --strict 下仍然照扫照 FAIL。
 *   selftest 里有负例证明这两条。
 *
 * Usage:
 *   node docs/fixtures/audit-docs.mjs                  # 默认：扫本目录全部 *.html（豁免生效）
 *   node docs/fixtures/audit-docs.mjs [file ...]       # 指定文件（豁免仍按清单生效）
 *   node docs/fixtures/audit-docs.mjs --strict         # 关闭文件级豁免（夹具也照 FAIL）
 *   node docs/fixtures/audit-docs.mjs --selftest [html] # 注入负例 + 豁免路径证明
 * Exit: 0 = clean, 1 = violation, 2 = bad args.
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SELFTEST_BASE = 'gg-layout-anim-spec.html'; // 干净、非豁免、有 <body> 锚点

// ---------- 显式文件级豁免清单 ----------
// 每条必须有 reason（为什么合法）+ source（裁决出处）。加新条目 = 需要一次明确裁决。
const EXEMPT = [
  {
    file: 'gg-l0-visual-baseline.html',
    reason: '判据夹具（L0 视觉基线）：内容故意保留参考端原样作对照基线，清词会破坏其基线判据用途',
    source: '旧裁决「不动 l0/l1：判据夹具」（见 gg-layout-anim-spec.html §08 诚实清单）；用户裁决 B（2026-10-07）：不清，保留原样',
  },
  {
    file: 'gg-l1-phone-geometry.html',
    reason: '判据夹具（L1 手机几何）：同 l0，几何量测基线，清词会破坏其基线判据用途',
    source: '旧裁决「不动 l0/l1：判据夹具」（见 gg-layout-anim-spec.html §08 诚实清单）；用户裁决 B（2026-10-07）：不清，保留原样',
  },
];
const exemptionFor = name => EXEMPT.find(e => e.file === name) || null;

// ---------- helpers ----------
const C = (...parts) => parts.join(''); // concat helper: defeats literal grep
function spaced(token) {
  const letters = [...token.replace(/\s+/g, '')].map(ch =>
    ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp('\\b' + letters.join('\\s*') + '\\b', 'i');
}
const SPACED = t => [...t].join(' '); // runtime spaced text for selftest payloads

// ---------- rule table ----------
const BRAND_TOKENS = [
  ['双G品牌字样',      C('G', 'G')],
  ['顶栏专有玩法名',   C('Ru', 'sh')],
  ['参考端品牌全称',    C('G', 'G') + 'Poker'],
  ['参考端包名前缀',    'cl' + 'ub' + C('G', 'G')],
  ['分池选择面板专名',  C('Deal', ' ', 'Choice')],
];
const HANDLES = [
  'Han' + 'nah13', 'Wo' + 'ku36', 'Te' + 'ra@JAPAN', 'Ton' + 'yStraddle',
  'Es' + 'tefan2023', 'Qie' + ' ziiii', 'te' + 'stph', 'w' + 'xdlh',
  'Ty' + 'pe-R', 'Flo' + 'pnuts', 'giv' + 'e10K', 'Ha' + 'uLL',
  'men' + 'daco', '30' + '60ti', 'AI' + 'NKCO', 'Bo' + 'ss lang',
  'Ede' + 'nnnn', 'Fis' + 'hi shsi', 'loose' + 'goose', 'Ma' + 'rk92',
  'rap' + 'pdo11', 'You' + 'rMate22',
  C('Lo', 'Show', '85'), C('Ne', 'viR'),
];
const BANNED = [
  ...BRAND_TOKENS.map(([label, tok]) => [label, spaced(tok)]),
  ['RUN n 分池标签', /\bR\s*U\s*N\s+[0-9]\b/],
  ...HANDLES.map((h, i) => [`真实玩家名 #${i + 1}`, spaced(h)]),
];

// 素材路径豁免：任何含 gg- 的无空格 token（路径/文件名）整体遮蔽。
// 覆盖 clubgg-*（gg- 出现在 club 之后）。⚠ 大小写敏感：素材文件名全是小写 gg-；
// 若连大写变体也遮，展示文案里的品牌字面就永远抓不到（假阴性）。
const ASSET_PATH_RE = /[A-Za-z0-9_.\u4e00-\u9fff/-]*gg-[A-Za-z0-9_.\u4e00-\u9fff/-]*/g;

// data: URI 先百分号解码再扫：%3EGG%3C 里 E 是 word 字符，编码形态下 \bG\s*G\b
// 不成立（rev4 盘点就漏了 favicon 这一处）；解码后品牌字面正常命中。
// ⚠ 边界要吃到闭合双引号：真实 favicon 的 URI 内含空格与单引号
// （viewBox='0 0 32 32'），按空白截断会把品牌字面留在未解码的后半段。
function decodeDataUris(text) {
  return text.replace(/data:[^"]*/g, m => {
    try { return decodeURIComponent(m); } catch { return m; }
  });
}

function maskAssets(text) {
  return text.replace(ASSET_PATH_RE, '?');
}

function scanText(text) {
  const rows = [];
  let fail = 0;
  for (const [label, re] of BANNED) {
    const m = text.match(new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g'));
    if (m) fail++;
    rows.push({ label, hits: m ? m.length : 0, ok: !m });
  }
  return { fail, rows };
}

function auditDoc(file) {
  const raw = readFileSync(file, 'utf8');
  return { file, ...scanText(maskAssets(decodeDataUris(raw))) };
}

function auditDocWithHtml(file, html) {
  return { file, ...scanText(maskAssets(decodeDataUris(html))) };
}

function discoverHtml() {
  return readdirSync(HERE).filter(f => f.endsWith('.html')).sort();
}

function printReport(r) {
  console.log(`audit-docs: ${r.file}`);
  const bad = r.rows.filter(x => !x.ok);
  if (!bad.length) {
    console.log(`  ${r.rows.length} rules (brand + handles, spacing-tolerant, asset paths masked) — all clean`);
  } else {
    for (const x of bad) console.log(`  *** FAIL ${x.label}: ${x.hits} hit(s) after asset-path masking`);
  }
  console.log(r.fail ? `RESULT: FAIL (${r.fail} rule(s))` : 'RESULT: PASS');
}

// ---------- selftest: prove the gate goes RED, and exemptions are explicit ----------
function selftest(baseFile) {
  const html = readFileSync(baseFile, 'utf8');
  const inject = tag => html.replace('<body>', `<body><div>${tag}</div>`);
  const cases = [
    { name: 'clean default run (all html, exemptions applied)', runDefault: true, wantPass: true },
    { name: 'inject 分池面板专名 literal', html: inject(C('Deal', ' ', 'Choice')), wantPass: false },
    { name: 'inject letter-spaced brand deco (rev4 bypass class)', html: inject(SPACED(C('R', 'U', 'S', 'H'))), wantPass: false },
    { name: 'inject spaced registered handle (registered #24, split-token form)', html: inject(SPACED(C('Ne', 'viR'))), wantPass: false },
    { name: 'inject RUN-n label', html: inject(C('RUN', ' ', '2')), wantPass: false },
    { name: 'inject brand token inside data: URI (favicon class, NOT masked)', html: inject(`<link href="data:image/svg+xml,%3E${C('G', 'G')}%3C">`), wantPass: false },
    { name: 'edge: asset path ../media/gg-reference/gg-desktop-*.png stays green (mask proof)', html: inject(`<img src="../media/gg-reference/${C('gg', '-')}${'desktop'}-${'现金桌'}.png">`), wantPass: true },
    { name: 'edge: clubgg-* material filename stays green (mask proof)', html: inject(`<p>${'cl' + 'ub' + C('gg', '-') + 'mobile-截图.jpg'}</p>`), wantPass: true },
    { name: 'edge: docs/plans/…-gg-….md path stays green (mask proof)', html: inject(`<p>docs/plans/2026-10-06-${C('gg', '-') + 'table-reference'}.md:27</p>`), wantPass: true },
    // --- 豁免路径证明：豁免是显式生效，不是"这些文件永远不查" ---
    {
      name: 'exemption is load-bearing: 夹具在清单内 AND 其内容照扫照 FAIL',
      check: () => {
        const name = EXEMPT[0].file; // gg-l0-visual-baseline.html
        const listed = !!exemptionFor(name);
        const strictFail = auditDoc(path.join(HERE, name)).fail > 0;
        return { ok: listed && strictFail, detail: `listed=${listed}, content still fails under strict=${strictFail}` };
      },
    },
    {
      name: 'same content under a NON-listed name FAILs (新文件不会自动豁免)',
      check: () => {
        const r = auditDocWithHtml('some-future-doc.html', readFileSync(path.join(HERE, EXEMPT[0].file), 'utf8'));
        return { ok: r.fail > 0, detail: `violations found under unlisted name: ${r.rows.filter(x => !x.ok).map(x => x.label).join(', ')}` };
      },
    },
    {
      name: 'exemptionFor() only answers for listed names (无默认豁免)',
      check: () => {
        const known = EXEMPT.every(e => !!exemptionFor(e.file));
        const unknown = !exemptionFor('gg-l9-new-anything.html');
        return { ok: known && unknown, detail: `all listed resolve=${known}, unlisted resolves none=${unknown}` };
      },
    },
    {
      name: 'every exemption entry carries reason + source (后人可查裁决出处)',
      check: () => {
        const ok = EXEMPT.every(e => e.reason?.length > 10 && e.source?.length > 10);
        return { ok, detail: `${EXEMPT.length} entries all carry reason+source` };
      },
    },
  ];
  let bad = 0;
  console.log('SELFTEST — audit-docs must go red on violations, green on masked paths, and exemptions must be explicit\n');
  for (const c of cases) {
    let passed, detail = '';
    if (c.runDefault) {
      const r = runScan({ strict: false });
      passed = r.fail === 0;
      detail = `${r.scanned} scanned, ${r.exempted.length} exempt`;
    } else if (c.check) {
      const res = c.check();
      passed = res.ok; detail = res.detail;
    } else {
      const r = auditDocWithHtml(baseFile, c.html);
      passed = r.fail === 0;
      detail = passed ? '' : 'caught by: ' + r.rows.filter(x => !x.ok).map(x => x.label).join(', ');
    }
    const want = c.wantPass ?? false; // check-cases default to "must be true"
    const ok = c.check ? passed : (passed === want);
    if (!ok) bad++;
    console.log(`${ok ? 'OK  ' : 'BAD '} | ${c.name}`);
    console.log(`      ${c.check ? `check=${passed}` : `expected ${want ? 'PASS' : 'FAIL'}, gate said ${passed ? 'PASS' : 'FAIL'}`}${detail ? ' | ' + detail : ''}`);
  }
  console.log(bad ? `\nSELFTEST: FAIL (${bad} misbehaving cases)` : '\nSELFTEST: PASS (red on violations incl. spacing bypass & data-URI brand text; green on masked asset paths; exemptions explicit + strict-recheckable)');
  process.exit(bad ? 1 : 0);
}

// ---------- runner ----------
function runScan({ positional = [], strict = false }) {
  // positional: 按 CWD 解析（用户手敲的路径）；auto-discovered: 按脚本目录 HERE 解析（裸文件名）
  const targets = positional.length
    ? positional.map(f => path.resolve(f))
    : discoverHtml().map(f => path.join(HERE, f));
  for (const f of targets) {
    if (!existsSync(f)) { console.error(`REFUSE: no such file ${f}`); process.exit(2); }
  }
  const label = positional.length ? `${targets.length} file(s), explicit` : `all ${targets.length} *.html in docs/fixtures (auto-discovered)`;
  console.log(`scan scope: ${label}${strict ? '  [STRICT: file-level exemptions OFF]' : ''}`);
  for (const t of targets) console.log(`  · ${path.basename(t)}`);
  let fail = 0, scanned = 0;
  const exempted = [];
  for (const f of targets) {
    const base = path.basename(f);
    const ex = !strict && exemptionFor(base);
    if (ex) {
      console.log(`audit-docs: ${f}\n  EXEMPT (judgement fixture, kept as-is) — ${ex.reason}\n  source: ${ex.source}`);
      exempted.push(base);
      continue;
    }
    const r = auditDoc(f);
    printReport(r);
    fail += r.fail;
    scanned++;
  }
  // stale 豁免卫生检查：清单里列了但文件已不存在 → 该删条目了
  for (const e of EXEMPT) {
    if (!existsSync(path.join(HERE, e.file))) console.log(`*** WARN stale exemption entry (file gone): ${e.file}`);
  }
  console.log(`SUMMARY: ${scanned} scanned, ${exempted.length} exempted, ${fail ? `FAIL (${fail} rule violation(s))` : 'PASS'}`);
  return { fail, scanned, exempted };
}

// ---------- main ----------
const args = process.argv.slice(2);
if (args[0] === '--selftest') {
  const base = args[1] ? path.resolve(args[1]) : path.join(HERE, SELFTEST_BASE);
  if (!existsSync(base)) { console.error(`REFUSE: no such file ${base}`); process.exit(2); }
  selftest(base);
} else {
  const strict = args.includes('--strict') || args.includes('--no-exempt');
  const positional = args.filter(a => !a.startsWith('--'));
  const { fail } = runScan({ positional, strict });
  process.exit(fail ? 1 : 0);
}
