#!/usr/bin/env node
// check-diff — 检查工作区与暂存区的 diff 是否含有空白错误 / 冲突标记。
//
//   node scripts/check-diff.mjs
//
// 幂等、只读、可重复运行。任何一处有问题即以非零码退出。

import { spawnSync } from 'node:child_process';

/** @param {string[]} args */
function git(args) {
  return spawnSync('git', args, { encoding: 'utf8' });
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
