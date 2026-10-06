#!/usr/bin/env node
// check-tracked — 捕捉「已被型检范围覆盖、但 git 不知道」的文件。
//
//   node scripts/check-tracked.mjs
//
// 两类问题：
//   1. 落在某个 tsconfig `include` 目录内、但未被 git 跟踪的源文件
//      （常见于新建文件忘了 `git add`）。
//   2. 已被 git 跟踪、但工作区里已被删除的文件
//      （可能是误删，也可能是 `git rm` 前漏了操作）。
//
// 幂等、只读、可重复运行。有问题时以非零码退出。

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const SOURCE_EXT = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);

/** @param {string[]} args @returns {string[]} */
function gitLines(args) {
  const r = spawnSync('git', args, { encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(' ')} 失败：${r.stderr || r.status}`);
  }
  return (r.stdout ?? '').split('\n').filter(Boolean);
}

const repoRoot = gitLines(['rev-parse', '--show-toplevel'])[0];
if (!repoRoot) throw new Error('无法确定 git 仓库根目录');
process.chdir(repoRoot);

const tracked = new Set(gitLines(['ls-files']));
const untracked = gitLines(['ls-files', '--others', '--exclude-standard']);
const deleted = gitLines(['ls-files', '--deleted']);

// —— 收集所有 workspace 级 tsconfig 的 include 目录 ——
const tsconfigs = [];
for (const group of ['apps', 'packages']) {
  const base = path.join(repoRoot, group);
  if (!fs.existsSync(base)) continue;
  for (const entry of fs.readdirSync(base)) {
    const cfg = path.join(base, entry, 'tsconfig.json');
    if (fs.existsSync(cfg)) tsconfigs.push(cfg);
  }
}
// 根级 tsconfig.json（若有）
const rootCfg = path.join(repoRoot, 'tsconfig.json');
if (fs.existsSync(rootCfg)) tsconfigs.push(rootCfg);

/** @param {string} dir @param {Set<string>} acc */
function walk(dir, acc) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === 'dist' || e.name === '.git') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (e.isFile() && SOURCE_EXT.has(path.extname(e.name))) acc.add(p);
  }
}

/** include 范围内的绝对路径集合 */
const inScope = new Set();
for (const cfg of tsconfigs) {
  let json;
  try {
    json = JSON.parse(fs.readFileSync(cfg, 'utf8'));
  } catch {
    continue;
  }
  const includes = Array.isArray(json.include) ? json.include : [];
  for (const inc of includes) {
    // 仅支持直接目录名（本仓库的 include 都是 "src" / "test" 这种字面量）
    if (typeof inc !== 'string' || /[*?]/.test(inc)) continue;
    const abs = path.resolve(path.dirname(cfg), inc);
    if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) walk(abs, inScope);
  }
}

const untrackedInScope = untracked
  .map((p) => path.resolve(repoRoot, p))
  .filter((abs) => inScope.has(abs));

let failed = false;

if (untrackedInScope.length > 0) {
  failed = true;
  console.log('✗ 未被 git 跟踪、但落在 tsconfig include 范围内的源文件：');
  for (const f of untrackedInScope) console.log(`    ${path.relative(repoRoot, f)}`);
  console.log('  → 若属于本次改动，请 `git add` 后再提交。\n');
} else {
  console.log('✓ 没有「include 范围内却未跟踪」的源文件');
}

if (deleted.length > 0) {
  failed = true;
  console.log('✗ 已被 git 跟踪、但工作区里已删除的文件：');
  for (const f of deleted) console.log(`    ${f}`);
  console.log('  → 若非有意删除，请恢复；若确为删除，注意它是否已被 `git add` 记录。\n');
} else {
  console.log('✓ 没有「已跟踪却被删除」的文件');
}

if (failed) process.exit(1);

console.log('\ncheck-tracked 通过。');
