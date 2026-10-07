#!/usr/bin/env node
/**
 * audit-docs.mjs — 早期设计文档（规格稿 / 主题 mockup）的轻量品牌门禁。
 *
 * 为什么不是 audit-design.mjs：主门禁的 REQUIRED（fxring/cface/座位数…）与
 * .pname 白名单是「复刻牌桌 deck」专属判据，拿它扫文档会产生大量校准噪声；
 * 它的零外链检查还会把合法的 ../media/ 相对链接误判为外链。
 * 本门禁只跑两类规则（用户裁决的口径）：
 *   1) 品牌词 banned-any ：GG / Rush / GGPoker / clubgg / Deal Choice / RUN n
 *      —— 全部空格容忍（字母间 \s*，词边界），rev4 的 "R U S H" 绕过在这里同样会红。
 *   2) 真实玩家名 blacklist：24 个已登记 handle，同样空格容忍。
 *      诚实边界：这是黑名单，不是「任意真名」检测——文档没有 .pname 槽位可
 *      做白名单；新真名需先登记再被抓住（deck 的白名单方案不适用于自由文档）。
 *
 * 素材文件名豁免（裁决：输入素材真实名不改）：扫描前把「含 gg- 的路径 token」
 * 整体遮蔽，如 ../media/gg-reference/gg-desktop-现金桌.png、clubgg-mobile-*.jpg、
 * gg-l0-visual-baseline.html、docs/plans/…-gg-….md、gg-跑马-03-DealChoice面板.png。
 * ⚠ 注意 data: URI 不遮蔽——它渲染给用户看（favicon 里的 GG 文字必须能被抓）。
 *
 * Usage:
 *   node docs/fixtures/audit-docs.mjs [file ...]      # 默认扫两份早期文档
 *   node docs/fixtures/audit-docs.mjs --selftest      # 注入负例，证明门禁会红
 * Exit: 0 = clean, 1 = violation, 2 = bad args.
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_TARGETS = ['gg-layout-anim-spec.html', 'gg-l5-theme-mockup.html'];

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
  ['专有玩法名 Rush',   C('Ru', 'sh')],
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
// 若连 "GG-" 也遮，展示文案里的大写品牌就永远抓不到（假阴性）。
const ASSET_PATH_RE = /[A-Za-z0-9_.\u4e00-\u9fff/-]*gg-[A-Za-z0-9_.\u4e00-\u9fff/-]*/g;

// data: URI 先百分号解码再扫：%3EGG%3C 里 E 是 word 字符，编码形态下 \bG\s*G\b
// 不成立（rev4 盘点就漏了 favicon 这一处）；解码后 >GG< 正常命中。
// ⚠ 边界要吃到闭合双引号：真实 favicon 的 URI 内含空格与单引号
// （viewBox='0 0 32 32'），按空白截断会把 GG 留在未解码的后半段。
function decodeDataUris(text) {
  return text.replace(/data:[^"]*/g, m => {
    try { return decodeURIComponent(m); } catch { return m; }
  });
}

function maskAssets(text) {
  return text.replace(ASSET_PATH_RE, '?');
}

function auditDoc(file) {
  const raw = readFileSync(file, 'utf8');
  const text = maskAssets(decodeDataUris(raw));
  const rows = [];
  let fail = 0;
  for (const [label, re] of BANNED) {
    const m = text.match(new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g'));
    if (m) fail++;
    rows.push({ label, hits: m ? m.length : 0, ok: !m });
  }
  return { file, fail, rows };
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

// ---------- selftest: prove the gate goes RED ----------
function selftest(baseFile) {
  const html = readFileSync(baseFile, 'utf8');
  const inject = (marker, tag) => ({ html: html.replace('<body>', `<body><div>${tag}</div>`), marker });
  const cases = [
    { name: 'clean default targets', files: null, wantPass: true },
    { name: 'inject "Deal Choice" panel name', ...inject('分池选择面板专名', C('Deal', ' ', 'Choice')), wantPass: false },
    { name: 'inject letter-spaced Rush (rev4 bypass class)', ...inject('专有玩法名 Rush', SPACED(C('R', 'U', 'S', 'H'))), wantPass: false },
    { name: 'inject spaced registered handle (NeviR)', ...inject('真实玩家名', SPACED(C('Ne', 'viR'))), wantPass: false },
    { name: 'inject RUN 2 label', ...inject('RUN n 分池标签', 'RUN 2'), wantPass: false },
    { name: 'inject GG inside data: URI (favicon class, NOT masked)', html: html.replace('<body>', `<body><link href="data:image/svg+xml,%3E${C('G', 'G')}%3C">`), wantPass: false },
    { name: 'edge: asset path ../media/gg-reference/gg-desktop-*.png stays green (mask proof)', html: html.replace('<body>', `<body><img src="../media/gg-reference/${C('gg', '-')}${'desktop'}-${'现金桌'}.png">`), wantPass: true },
    { name: 'edge: clubgg-* material filename stays green (mask proof)', html: html.replace('<body>', `<body><p>${'cl' + 'ub' + C('gg', '-') + 'mobile-截图.jpg'}</p>`), wantPass: true },
    { name: 'edge: docs/plans/…-gg-….md path stays green (mask proof)', html: html.replace('<body>', `<body><p>docs/plans/2026-10-06-${C('gg', '-') + 'table-reference'}.md:27</p>`), wantPass: true },
  ];
  let bad = 0;
  console.log('SELFTEST — audit-docs must go red on brand tokens/handles, stay green on masked asset paths\n');
  for (const c of cases) {
    let r;
    if (c.files === null) {
      r = DEFAULT_TARGETS.map(f => auditDoc(path.join(HERE, f))).find(x => x.fail) || { fail: 0, rows: [] };
    } else {
      r = auditDocWithHtml(baseFile, c.html);
    }
    const passed = r.fail === 0;
    const ok = passed === c.wantPass;
    if (!ok) bad++;
    console.log(`${ok ? 'OK  ' : 'BAD '} | ${c.name}`);
    console.log(`      expected ${c.wantPass ? 'PASS' : 'FAIL'}, gate said ${passed ? 'PASS' : 'FAIL: ' + r.rows.filter(x => !x.ok).map(x => x.label).join(', ')}`);
  }
  console.log(bad ? `\nSELFTEST: FAIL (${bad} misbehaving cases)` : '\nSELFTEST: PASS (red on violations incl. spacing bypass & data-URI GG, green on masked asset filenames)');
  process.exit(bad ? 1 : 0);
}

function auditDocWithHtml(file, html) {
  const text = maskAssets(decodeDataUris(html));
  const rows = [];
  let fail = 0;
  for (const [label, re] of BANNED) {
    const m = text.match(new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g'));
    if (m) fail++;
    rows.push({ label, hits: m ? m.length : 0, ok: !m });
  }
  return { file, fail, rows };
}

// ---------- main ----------
const args = process.argv.slice(2);
if (args[0] === '--selftest') {
  const base = args[1] ? path.resolve(args[1]) : path.join(HERE, DEFAULT_TARGETS[0]);
  if (!existsSync(base)) { console.error(`REFUSE: no such file ${base}`); process.exit(2); }
  selftest(base);
} else {
  const files = (args.length ? args : DEFAULT_TARGETS.map(f => path.join(HERE, f))).map(f => path.resolve(f));
  for (const f of files) {
    if (!existsSync(f)) { console.error(`REFUSE: no such file ${f}`); process.exit(2); }
  }
  let fail = 0;
  for (const f of files) {
    const r = auditDoc(f);
    printReport(r);
    fail += r.fail;
  }
  process.exit(fail ? 1 : 0);
}
