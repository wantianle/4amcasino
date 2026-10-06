#!/usr/bin/env node
// check-links — 核对 worktree 内跨包软链是否指向「本 worktree」而非主仓。
//
//   node scripts/check-links.mjs
//
// 背景：worktree 的根 node_modules 往往被软链到主仓的 node_modules，
// 于是 `@4am/shared`、`@4am/agent-core` 等 workspace 包会解析回主仓源码，
// 导致「改了本 worktree 的包，却在别处假绿」。
//
// 本脚本从每个 workspace 包的 package.json 出发，按 Node 解析规则求出每个
// `@4am/*` 依赖的真实路径，只要 realpath 落在本 worktree 之外即报错，
// 并打印逐条修复命令。
//
// 幂等、只读、可重复运行。发现问题时以非零码退出。

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

function git(args) {
  const r = spawnSync('git', args, { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} 失败`);
  return (r.stdout ?? '').trim();
}

const repoRoot = fs.realpathSync(git(['rev-parse', '--show-toplevel']));

/** 收集 workspace 包目录（apps/* 与 packages/* 中带 package.json 的目录） */
const workspaceDirs = [];
for (const group of ['apps', 'packages']) {
  const base = path.join(repoRoot, group);
  if (!fs.existsSync(base)) continue;
  for (const entry of fs.readdirSync(base)) {
    const dir = path.join(base, entry);
    if (fs.existsSync(path.join(dir, 'package.json'))) workspaceDirs.push(dir);
  }
}

/**
 * 按 Node 的 node_modules 解析规则，求出一个包的目录真实路径。
 * @param {string} fromDir 发起解析的目录
 * @param {string} spec 依赖名，如 @4am/shared
 * @returns {string|null} realpath 或 null（未解析到）
 */
function resolvePackageDir(fromDir, spec) {
  let dir = fromDir;
  for (;;) {
    const candidate = path.join(dir, 'node_modules', spec);
    if (fs.existsSync(candidate)) {
      try {
        return fs.realpathSync(candidate);
      } catch {
        return null;
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** @param {string} p @returns {boolean} 是否位于本 worktree 内 */
function insideRepo(p) {
  return p === repoRoot || p.startsWith(repoRoot + path.sep);
}

/** 该 @4am 包在本 worktree 里的正确位置 */
function worktreeTarget(spec) {
  const name = spec.slice('@4am/'.length);
  for (const group of ['packages', 'apps']) {
    const p = path.join(repoRoot, group, name);
    if (fs.existsSync(p)) return p;
  }
  return path.join(repoRoot, 'packages', name);
}

const leaks = [];
let checked = 0;

for (const dir of workspaceDirs) {
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  } catch {
    continue;
  }
  const deps = Object.keys(pkg.dependencies ?? {}).filter((d) => d.startsWith('@4am/'));
  for (const dep of deps) {
    checked += 1;
    const resolved = resolvePackageDir(dir, dep);
    if (resolved === null) {
      leaks.push({ dir, dep, resolved: null });
    } else if (!insideRepo(resolved)) {
      leaks.push({ dir, dep, resolved });
    }
  }
}

if (leaks.length === 0) {
  console.log(`✓ 所有 @4am/* 依赖都解析到本 worktree（共核对 ${checked} 条）`);
  console.log(`  本 worktree：${repoRoot}`);
  process.exit(0);
}

console.log(`✗ 发现 ${leaks.length} 条 @4am/* 依赖解析到了本 worktree 之外：\n`);
for (const { dir, dep, resolved } of leaks) {
  const rel = path.relative(repoRoot, dir) || '.';
  console.log(`  [${rel}] ${dep}`);
  console.log(`      → ${resolved ?? '(未解析到)'}`);
}
// 按消费方目录归组，输出可直接执行的修复命令
const byDir = new Map();
for (const { dir, dep } of leaks) {
  if (!byDir.has(dir)) byDir.set(dir, []);
  byDir.get(dir).push(dep);
}

console.log('\n修复方法（在 worktree 根目录执行，逐条建立指向本 worktree 的软链）：\n');
for (const [dir, deps] of byDir) {
  const rel = path.relative(repoRoot, dir) || '.';
  const at4am = path.join(dir, 'node_modules', '@4am');
  // 若 @4am 本身是个指向别处的软链（而非目录），先移除它
  let at4amIsSymlink = false;
  try {
    at4amIsSymlink = fs.lstatSync(at4am).isSymbolicLink();
  } catch {
    /* 不存在则无需处理 */
  }
  if (at4amIsSymlink) console.log(`  rm -f ${rel}/node_modules/@4am`);
  console.log(`  mkdir -p ${rel}/node_modules/@4am`);
  for (const dep of [...new Set(deps)]) {
    const name = dep.slice('@4am/'.length);
    console.log(`  ln -sfn ${worktreeTarget(dep)} ${rel}/node_modules/@4am/${name}`);
  }
}
console.log('\n提示：根 node_modules 若是主仓的软链，请在上述逐包修复后重跑本脚本确认。');
process.exit(1);
