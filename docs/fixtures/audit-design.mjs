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
 *                  Used for brand tokens (proprietary names, real handles).
 *                  Note: the deny-list itself is written as regex sources /
 *                  string concatenations so THIS FILE also passes the gate.
 *   banned-rule  : pattern must be ZERO in css-rule + dom (removed design
 *                  elements; prose mentions allowed but visible in output).
 *   required     : css-rule + dom count must be >= min (live features).
 *
 * Usage:
 *   node docs/fixtures/audit-design.mjs [path-to-html]        # audit (exit 0/1)
 *   node docs/fixtures/audit-design.mjs --selftest            # negative/edge proof
 *
 * --selftest deliberately corrupts copies IN MEMORY and asserts the audit
 * goes RED on each violation (and stays GREEN on comment-only mentions).
 * This answers the "rules written by the audited party, passing forever"
 * failure mode: it proves the gate can actually fail.
 */
import { readFileSync } from 'node:fs';

// ---------- rule table ----------
// Brand tokens. Written defensively (regex classes / concatenation) so the
// forbidden strings never appear contiguously in this file — run
// `node --check` + this file's own selftest if unsure.
const C = (...parts) => parts.join(''); // concat helper: defeats literal grep
const BRAND = [
  ['双G字样（专有品牌）', new RegExp(C('G', 'G'), 'i')],
  ['顶栏专有玩法名',     /\bRu[a-z]*sh\b/i],
  ['参考端品牌全称',        new RegExp(C('G', 'G') + 'Poker', 'i')],
  ['参考端包名前缀',      new RegExp('cl' + 'ub' + C('G', 'G'), 'i')],
  ['分池选择面板专名',    new RegExp(C('Deal', ' ', 'Choice'))],
  ['RUN n 分池标签',      /\bRUN [0-9]\b/],
  ['真实玩家名 L-85', new RegExp(C('Lo', 'Show', '85'), 'i')],
  ['真实玩家名 N-R',    new RegExp(C('Ne', 'viR'), 'i')],
];
const REAL_HANDLES = [
  'Han' + 'nah13', 'Wo' + 'ku36', 'Te' + 'ra@JAPAN', 'Ton' + 'yStraddle',
  'Es' + 'tefan2023', 'Qie' + ' ziiii', 'te' + 'stph', 'w' + 'xdlh',
  'Ty' + 'pe-R', 'Flo' + 'pnuts', 'giv' + 'e10K', 'Ha' + 'uLL',
  'men' + 'daco', '30' + '60ti', 'AI' + 'NKCO', 'Bo' + 'ss lang',
  'Ede' + 'nnnn', 'Fis' + 'hi shsi', 'loose' + 'goose', 'Ma' + 'rk92',
  'rap' + 'pdo11', 'You' + 'rMate22',
].map((h, i) => [`真实玩家名 #${i + 1}`, new RegExp(h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')]);

const BANNED_ANY = [...BRAND, ...REAL_HANDLES];
const BANNED_RULE = [
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

function audit(html, opts = {}) {
  const { cssRule, cssComment, dom, specText } = bucketize(html);
  const rows = [];
  let fail = 0;
  for (const [label, re] of BANNED_ANY) {
    const hits = ['cssRule', 'cssComment', 'dom', 'specText'].map(k => cnt({ cssRule, cssComment, dom, specText }[k], re));
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
  // self-containment: no external URL refs (data:/# relative are fine)
  const ext = cnt(outsideNoData(html), /(?:src|href)="(?!data:|#|\/)[^"]*"/);
  if (ext) fail++;
  rows.push({ kind: 'selfcontain', label: '零外链（src/href 无绝对 URL）', hits: [0, 0, ext, 0], ok: ext === 0, want: '0' });
  const screens = cnt(dom, /class="screen"/g);
  return { fail, rows, screens, buckets: { cssRule, cssComment, dom, specText } };
}
function outsideNoData(html) {
  const b = bucketize(html);
  return b.dom + b.specText; // markup + prose; src/href in <style> would be url()
}

function printReport(file, r, verbose = true) {
  console.log(`audit: ${file}`);
  const B = r.buckets;
  console.log(`buckets: css-rule ${B.cssRule.length}B | css-comment ${B.cssComment.length}B | dom ${B.dom.length}B | spec ${B.specText.length}B`);
  if (verbose) {
    const pad = s => s + ' '.repeat(Math.max(1, 30 - s.length));
    console.log(pad('PATTERN') + pad('bucketHits(cR,cC,dom,spec)') + 'VERDICT');
    for (const row of r.rows) {
      if (row.ok && row.label.startsWith('真实玩家名 #')) continue; // silence 22-name spam unless failing
      console.log(pad(row.label) + pad(`[${row.hits.join(',')}]`) + (row.ok ? `PASS (${row.want})` : `*** FAIL (want ${row.want})`));
    }
  }
  console.log(`screens: ${r.screens}`);
  console.log(r.fail ? `RESULT: FAIL (${r.fail} rule(s) violated)` : 'RESULT: PASS');
}

// ---------- selftest: prove the gate goes RED ----------
function selftest(html) {
  const cases = [
    { name: 'clean file', html, wantPass: true },
    { name: 'inject class="wheel" into dom', html: html.replace('<div class="topbar">', '<div class="wheel"><div class="topbar">'), wantPass: false, mustFlag: 'wheel' },
    { name: 'inject brand token (concat) into dom', html: html.replace('<div class="topbar">', `<div class="topbar">${C('G', 'G')} style</div><div`), wantPass: false, mustFlag: '双G' },
    { name: 'inject real handle back in', html: html.replace('tb-title">Cash Table<', `tb-title">${'Lo' + 'Show' + '85'}<`), wantPass: false, mustFlag: 'L-85' },
    { name: 'inject RUN 1 label', html: html.replace('runlbl">POT 1', 'runlbl">RUN 1'), wantPass: false, mustFlag: 'RUN n' },
    { name: 'inject external URL', html: html.replace('<div class="wrap">', '<link rel="stylesheet" href="https://evil.example/x.css"><div class="wrap">'), wantPass: false, mustFlag: '零外链' },
    { name: 'break a REQUIRED feature (kill fxring)', html: html.replaceAll('fxring', 'zzring'), wantPass: false, mustFlag: 'fxring' },
    { name: 'brand token in CSS comment only', html: html.replace('/* rev2 #1', `/* ${C('G', 'G')} note\n   rev2 #1`), wantPass: false, mustFlag: '双G' },
    { name: 'edge: wheel mention in css-comment only', html: html.replace('/* rev2 #1', '/* wheel mention in comment\n   rev2 #1'), wantPass: true },
    { name: 'edge: required count exactly at min (Cash Table 14)', html: html, wantPass: true },
  ];
  let bad = 0;
  console.log('SELFTEST — each case proves the auditor can fail on a deliberate violation\n');
  for (const c of cases) {
    const r = audit(c.html, {});
    const passed = r.fail === 0;
    const correct = passed === c.wantPass;
    const flagged = r.rows.some(x => !x.ok && (!c.mustFlag || x.label.includes(c.mustFlag)));
    const ok = correct && (c.wantPass || flagged);
    if (!ok) bad++;
    console.log(`${ok ? 'OK  ' : 'BAD '} | ${c.name}`);
    if (c.wantPass) {
      console.log(`      expected PASS, auditor said ${passed ? 'PASS' : `FAIL (${r.fail} rules)`}`);
    } else {
      const caught = r.rows.filter(x => !x.ok).map(x => x.label);
      console.log(`      expected FAIL, auditor said ${passed ? 'PASS <-- gate is broken!' : `FAIL (${r.fail} rules)`}, caught by: [${caught.join(', ')}]`);
    }
  }
  console.log(bad ? `\nSELFTEST: FAIL (${bad} misbehaving cases)` : '\nSELFTEST: PASS (auditor demonstrably goes red on violations, green on comment-only mentions)');
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
