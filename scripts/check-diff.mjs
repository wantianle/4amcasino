#!/usr/bin/env node
// check-diff — 检查工作区与暂存区的 diff 是否含有空白错误 / 冲突标记。
//
//   node scripts/check-diff.mjs
//
// 仓库根按「脚本自身位置」定位（而非 process.cwd()），因此
// `node <worktree>/scripts/check-diff.mjs` 与 `cd <worktree> && node scripts/check-diff.mjs`
// 检查的是同一棵 worktree，结果一致。
//
// 幂等、只读、可重复运行。任何一处有问题即以非零码退出。

import { spawnSync } from 'node:child_process';
import { findRepoRoot } from './lib/repo-root.mjs';

const repoRoot = findRepoRoot(import.meta.url);

/** @param {string[]} args */
function git(args) {
  return spawnSync('git', ['-C', repoRoot, ...args], { encoding: 'utf8' });
}

/** @type {Array<[string, string[]]>} */
const targets = [
  ['工作区  git diff --check', ['diff', '--check']],
  ['暂存区  git diff --cached --check', ['diff', '--cached', '--check']],
];

let failed = false;

for (const [label, args] of targets) {
  const r = git(args);
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
  if (r.status === 0 && out === '') {
    console.log(`✓ ${label}：无空白错误 / 冲突标记`);
  } else {
    failed = true;
    console.log(`✗ ${label}：`);
    console.log(out || `(git 退出码 ${r.status})`);
    console.log('');
  }
}

if (failed) {
  console.error('check-diff 失败：提交前请修复上面的空白错误或冲突标记。');
  process.exit(1);
}

console.log('\ncheck-diff 通过。');
