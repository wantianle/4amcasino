#!/usr/bin/env node
/**
 * audit-design.mjs — machine-checkable audit for the cash-table replication mockup.
 *
 * Splits the design HTML into four buckets so "grep says N hits" is no longer
 * ambiguous:
 *   css-rule     : real CSS declarations (comments stripped)
 *   css-comment  : comments inside <style> (documentation)
 *   dom          : markup OUTSIDE the <div class="spec"> explainer block
 *   spec-text    : the <div class="spec"> documentation block (prose)
 *
 * Rule kinds:
 *   banned-any   : pattern must be ZERO across ALL four buckets.
 *                  Brand tokens (proprietary names, real handles). All brand
 *                  patterns are SPACING-TOLERANT (letters joined by \s* in
 *                  a word-boundary regex), so letter-spaced decorations
 *                  count as hits — the rev4 audit missed exactly this bypass.
 *                  Note: the deny-list itself is written as string
 *                  concatenations + a spaced() builder so THIS FILE also
 *                  passes the gate (no contiguous forbidden token appears).
 *   banned-rule  : pattern must be ZERO in css-rule + dom (removed design
 *                  elements incl. dead styles like the rim decoration).
 *   required     : css-rule + dom count must be >= min (live features).
 *   whitelist    : seat-name slots (.pname) must match an allow-list
 *                  (Player N / End of Demo). This is the honest fix for the
 *                  blacklist blind spot: an unregistered real
 *                  handle passes a 22-name blacklist but fails a whitelist. SCOPE BOUNDARY: the whitelist covers .pname
 *                  name slots only; other text areas are covered by the
 *                  spacing-tolerant brand blacklist, not by arbitrary-name
 *                  detection (there is no such thing as a generic
 *                  "looks like a real name" gate without false positives).
 *
 * Usage:
 *   node docs/fixtures/audit-design.mjs [path-to-html]        # audit (exit 0/1)
 *   node docs/fixtures/audit-design.mjs --selftest [html]     # negative/edge proof
 *
 * --selftest deliberately corrupts copies IN MEMORY and asserts the audit
 * goes RED on each violation (and stays GREEN on benign/boundary content),
 * including the two bypasses the reviewer demonstrated: letter-spaced brand
 * text and an unregistered handle injected into a seat name.
 */
import { readFileSync } from 'node:fs';

// ---------- helpers ----------
const C = (...parts) => parts.join(''); // concat helper: defeats literal grep
// spacing-tolerant regex from a plain brand token: letters joined by \s*, word-boundaried, /i
function spaced(token) {
  const letters = [...token.replace(/\s+/g, '')].map(ch =>
    ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp('\\b' + letters.join('\\s*') + '\\b', 'i');
}
// runtime-only spaced decoration text for selftest payloads (keeps THIS file grep-clean)
const SPACED = t => [...t].join(' ');

// ---------- rule table ----------
const BRAND_TOKENS = [
  ['双G品牌字样',        C('G', 'G')],
  ['顶栏专有玩法名',      C('Ru', 'sh')],
  ['参考端品牌全称',      C('G', 'G') + 'Poker'],
  ['参考端包名前缀',      'cl' + 'ub' + C('G', 'G')],
  ['分池选择面板专名',    C('Deal', ' ', 'Choice')],
  ['真实玩家名 L-85',    C('Lo', 'Show', '85')],
  ['真实玩家名 N-R',     C('Ne', 'viR')],
];
const REAL_HANDLES = [
  'Han' + 'nah13', 'Wo' + 'ku36', 'Te' + 'ra@JAPAN', 'Ton' + 'yStraddle',
  'Es' + 'tefan2023', 'Qie' + ' ziiii', 'te' + 'stph', 'w' + 'xdlh',
  'Ty' + 'pe-R', 'Flo' + 'pnuts', 'giv' + 'e10K', 'Ha' + 'uLL',
  'men' + 'daco', '30' + '60ti', 'AI' + 'NKCO', 'Bo' + 'ss lang',
  'Ede' + 'nnnn', 'Fis' + 'hi shsi', 'loose' + 'goose', 'Ma' + 'rk92',
  'rap' + 'pdo11', 'You' + 'rMate22',
];
const BANNED_ANY = [
  ...BRAND_TOKENS.map(([label, tok]) => [label, spaced(tok)]),
  ['RUN n 分池标签', /\bR\s*U\s*N\s+[0-9]\b/],
  ...REAL_HANDLES.map((h, i) => [`真实玩家名 #${i + 1}`, spaced(h)]),
];
const BANNED_RULE = [
  ['rim 装饰文字 rimtext', /rimtext/],
  ['rim 装饰死变量 rim-ink', /rim-ink/],
  ['wheel 滚轮提示', /wheel/],
  ['下划线元素 punder', /punder/],
  ['整 pod 胶囊白闪 glow', /class="glow"/],
  ['负间距 margin-top:-10px', /margin-top:-10px/],
  ['顶栏盲注 $0.10', /\$0\.10/],
  ['旧放射光柱层 fyrays', /fyrays/],
  ['旧整宽 dock 容器 pdock', /pdock/],
  ['旧大泛光层 fxbloom', /fxbloom/],
];
const REQUIRED = [
  ['玩家分色注入 --pc:', /--pc:/g, 60],
  ['行动两段式 CSS .pod.act .av', /\.pod\.act \.av/, 1],
  ['命中爆发层 fxhalo', /fxhalo/, 1],
  ['扩散脉冲环 fxring', /fxring/, 2],
  ['火星粒子容器 fxp', /class="fxp"/, 1],
  ['描金卡 fxcard', /fxcard/, 10],
  ['产品筹码面片 cface', /class="cface"/, 10],
  ['手机阶梯列 pd-ladder', /pd-ladder/, 1],
  ['手机桌壳 p-rail', /p-rail/, 1],
  ['公共牌 68px 宽 (--cw:68)', /--cw:68/, 1],
  ['顶栏中性桌名 Cash Table', /tb-title">Cash Table</, 14],
];
// whitelist: seat-name slots (.pname) — see header SCOPE BOUNDARY note.
// Captures slot content loosely and STRIPS inline tags before the allow test,
// so a tag-wrapped unregistered handle inside a .pname cannot hide from
// extraction (a name that failed extraction would silently drop the slot).
const NAME_SLOT_RE = /<div class="pname">([\s\S]*?)<\/div>/g;
const NAME_ALLOW = /^(?:Player \d+|End of Demo)$/;
const NAME_MIN = 60; // ~92 slots in the current deck

// ---------- bucketing + core audit ----------
function bucketize(html) {
  const styles = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map(m => m[1]);
  const cssAll = styles.join('\n');
  const cssComment = (cssAll.match(/\/\*[\s\S]*?\*\//g) || []).join('\n');
  const cssRule = cssAll.replace(/\/\*[\s\S]*?\*\//g, '');
  const outside = html.replace(/<style>[\s\S]*?<\/style>/g, '');
  const s0 = outside.indexOf('<div class="spec">');
  const s1 = outside.indexOf('<script>', s0);
  const specText = s0 >= 0 ? outside.slice(s0, s1) : '';
  const dom = s0 >= 0 ? outside.slice(0, s0) + outside.slice(s1) : outside;
  return { cssRule, cssComment, dom, specText };
}
const cnt = (s, re) => (s.match(new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g')) || []).length;

function audit(html) {
  const { cssRule, cssComment, dom, specText } = bucketize(html);
  const rows = [];
  let fail = 0;
  for (const [label, re] of BANNED_ANY) {
    const hits = [cssRule, cssComment, dom, specText].map(k => cnt(k, re));
    const total = hits.reduce((a, b) => a + b, 0);
    if (total) fail++;
    rows.push({ kind: 'banned-any', label, hits, ok: total === 0, want: 'all buckets = 0' });
  }
  for (const [label, re] of BANNED_RULE) {
    const a = cnt(cssRule, re) + cnt(dom, re);
    if (a) fail++;
    rows.push({ kind: 'banned-rule', label, hits: [cnt(cssRule, re), 0, cnt(dom, re), 0], ok: a === 0, want: 'rule+dom = 0' });
  }
  for (const [label, re, min] of REQUIRED) {
    const a = cnt(cssRule, re) + cnt(dom, re);
    if (a < min) fail++;
    rows.push({ kind: 'required', label, hits: [cnt(cssRule, re), 0, cnt(dom, re), 0], ok: a >= min, want: `rule+dom >= ${min}` });
  }
  // whitelist over .pname slots (dom bucket only); strip inline tags +
  // normalize spacing so tag-wrapped names cannot escape extraction
  const names = [...dom.matchAll(NAME_SLOT_RE)]
    .map(m => m[1].replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim());
  const badNames = names.filter(n => !NAME_ALLOW.test(n));
  const wlOk = badNames.length === 0 && names.length >= NAME_MIN;
  if (!wlOk) fail++;
  rows.push({ kind: 'whitelist', label: '座位名白名单 .pname', hits: [0, 0, names.length, 0],
    ok: wlOk, want: `>=${NAME_MIN} slots, all matching Player N / End of Demo`,
    detail: badNames.length ? 'offenders: ' + [...new Set(badNames)].slice(0, 5).join(', ') : '' });
  // self-containment: no external URL refs (data:/# relative are fine)
  const ext = cnt(dom + specText, /(?:src|href)="(?!data:|#|\/)[^"]*"/);
  if (ext) fail++;
  rows.push({ kind: 'selfcontain', label: '零外链（src/href 无绝对 URL）', hits: [0, 0, ext, 0], ok: ext === 0, want: '0' });
  const screens = cnt(dom, /class="screen"/g);
  return { fail, rows, screens, nameCount: names.length, buckets: { cssRule, cssComment, dom, specText } };
}

function printReport(file, r) {
  console.log(`audit: ${file}`);
  const B = r.buckets;
  console.log(`buckets: css-rule ${B.cssRule.length}B | css-comment ${B.cssComment.length}B | dom ${B.dom.length}B | spec ${B.specText.length}B`);
  const pad = s => s + ' '.repeat(Math.max(1, 30 - s.length));
  console.log(pad('PATTERN') + pad('bucketHits(cR,cC,dom,spec)') + 'VERDICT');
  for (const row of r.rows) {
    if (row.ok && row.label.startsWith('真实玩家名 #')) continue; // silence 22-name spam unless failing
    console.log(pad(row.label) + pad(`[${row.hits.join(',')}]`) + (row.ok ? `PASS (${row.want})` : `*** FAIL (want ${row.want})`) + (row.detail ? ' | ' + row.detail : ''));
  }
  console.log(`screens: ${r.screens} | .pname slots: ${r.nameCount}`);
  console.log('whitelist scope note: .pname slots only; other text areas covered by spacing-tolerant brand blacklist, not arbitrary-name detection');
  console.log(r.fail ? `RESULT: FAIL (${r.fail} rule(s) violated)` : 'RESULT: PASS');
}

// ---------- selftest: prove the gate goes RED ----------
function selftest(html) {
  const cases = [
    { name: 'clean file', html, wantPass: true },
    { name: 'inject class="wheel" into dom', html: html.replace('<div class="topbar">', '<div class="wheel"><div class="topbar">'), wantPass: false, mustFlag: 'wheel' },
    { name: 'inject brand token (concat) into dom', html: html.replace('<div class="topbar">', `<div class="topbar">${C('G', 'G')} style</div><div`), wantPass: false, mustFlag: '双G' },
    { name: 'inject real handle back in', html: html.replace('tb-title">Cash Table<', `tb-title">${C('Lo', 'Show', '85')}<`), wantPass: false, mustFlag: 'L-85' },
    { name: 'inject RUN-n label', html: html.replace('runlbl">POT 1', 'runlbl">' + C('RUN', ' ', '1')), wantPass: false, mustFlag: 'RUN n' },
    { name: 'inject external URL', html: html.replace('<div class="wrap">', '<link rel="stylesheet" href="https://evil.example/x.css"><div class="wrap">'), wantPass: false, mustFlag: '零外链' },
    { name: 'break a REQUIRED feature (kill fxring)', html: html.replaceAll('fxring', 'zzring'), wantPass: false, mustFlag: 'fxring' },
    { name: 'edge: banned-rule words in css-COMMENT only stay green (bucketing proof)', html: html.replace('/* rev2 #1', `/* wheel rimtext punder note\n   rev2 #1`), wantPass: true },
    { name: 'brand token in CSS comment only', html: html.replace('/* rev2 #1', `/* ${C('G', 'G')} note\n   rev2 #1`), wantPass: false, mustFlag: '双G' },
    // --- rev4b: reviewer-demonstrated bypasses must now go RED ---
    { name: 'inject letter-spaced brand deco into rim (rev4 rimtext bypass)', html: html.replace('<div class="felt">', `<div class="rimtext">${SPACED(C('R', 'U', 'S', 'H'))}</div><div class="felt">`), wantPass: false, mustFlag: '顶栏专有玩法名' },
    { name: 'inject spaced handle into .pname (spacing bypass)', html: html.replace('pname">Player 1<', `pname">${SPACED(C('Lo', 'Show', '85'))}<`), wantPass: false, mustFlag: 'L-85' },
    { name: 'inject rimtext dead style back', html: html.replace('.felt{', '.rimtext{opacity:.5}\n.felt{'), wantPass: false, mustFlag: 'rimtext' },
    { name: 'inject UNREGISTERED real handle into .pname (blacklist blind spot)', html: html.replace('pname">Player 1<', 'pname">' + C('Phil', 'Ivey') + '<'), wantPass: false, mustFlag: '白名单' },
    { name: 'wrap unregistered name in <b> tag inside .pname (tag-wrap bypass)', html: html.replace('pname">Player 1<', 'pname"><b' + C('Phil', 'Ivey') + '</b><'), wantPass: false, mustFlag: '白名单' },
    { name: 'edge: benign word ending in -ush must NOT trip spaced brand rule', html: html.replace('dc-title">Split Options<', 'dc-title">Hush Options<'), wantPass: true },
    { name: 'spaced double-G in spec prose (banned-any covers prose too)', html: html.replace('<div class="spec">', `<div class="spec">${SPACED(C('G', 'G'))}</div>`), wantPass: false, mustFlag: '双G' },
  ];
  let bad = 0;
  console.log('SELFTEST — each case proves the auditor can fail on a deliberate violation\n');
  for (const c of cases) {
    const r = audit(c.html);
    const passed = r.fail === 0;
    const correct = passed === c.wantPass;
    const flagged = r.rows.some(x => !x.ok && (!c.mustFlag || x.label.includes(c.mustFlag) || (x.detail || '').includes(c.mustFlag)));
    const ok = correct && (c.wantPass || flagged);
    if (!ok) bad++;
    console.log(`${ok ? 'OK  ' : 'BAD '} | ${c.name}`);
    console.log(`      expected ${c.wantPass ? 'PASS' : 'FAIL'}, auditor said ${passed ? 'PASS' : `FAIL (${r.fail} rules)`}` +
      (c.wantPass ? '' : `, violation caught by a rule matching "${c.mustFlag}" = ${flagged}`));
  }
  console.log(bad ? `\nSELFTEST: FAIL (${bad} misbehaving cases)` : '\nSELFTEST: PASS (auditor demonstrably goes red on violations incl. spacing-bypass and unregistered names, green on benign content)');
  process.exit(bad ? 1 : 0);
}

// ---------- main ----------
const args = process.argv.slice(2);
if (args[0] === '--selftest') {
  const file = args[1] ?? new URL('./gg-replication-design.html', import.meta.url).pathname;
  selftest(readFileSync(file, 'utf8'));
} else {
  const file = args[0] ?? new URL('./gg-replication-design.html', import.meta.url).pathname;
  const html = readFileSync(file, 'utf8');
  const r = audit(html);
  printReport(file, r);
  if (r.screens !== 21) { console.log(`*** FAIL screens=${r.screens} want 21`); process.exit(1); }
  process.exit(r.fail ? 1 : 0);
}
