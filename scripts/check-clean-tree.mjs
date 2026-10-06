#!/usr/bin/env node
// check-clean-tree — 在一份「只含提交内容」的干净导出里跑 typecheck。
//
//   node scripts/check-clean-tree.mjs [ref]     # ref 可省略，默认 HEAD
//
// 为什么不能只看工作区：工作区可以同时包含「改了但没提交」的文件，于是
// 工作区 typecheck 通过，而真正被提交的那棵树是坏的（漏 add、只提交了一半）。
// 本脚本用 `git archive HEAD` 导出**提交态**源码到临时目录，为它链好
// node_modules（第三方依赖指向本仓安装，@4am/* 指向临时树自己），跑 typecheck，
// 最后无论成功失败都清理临时目录。
//
// 注意：本脚本只做 typecheck。CSS / 静态资源 / CDN 依赖的解析 `tsc` 看不见，
// 由 check-build.mjs 在同一套导出机制上跑真实构建覆盖。
//
// 仓库根按「脚本自身位置」定位，故 `node <worktree>/scripts/check-clean-tree.mjs`
// 与 `cd <worktree> && node scripts/check-clean-tree.mjs` 针对同一棵 worktree。
//
// 幂等、可重复运行、失败自清理。有问题时以非零码退出。

import { spawnSync } from 'node:child_process';
import { withCleanTree } from './lib/clean-tree.mjs';

const ref = process.argv[2] ?? 'HEAD';
const code = withCleanTree(
  import.meta.url,
  ({ tmp, head }) => {
    console.log(`→ 在 ${head} 上运行 npm run typecheck …\n`);
    const r = spawnSync('npm', ['run', 'typecheck'], { cwd: tmp, stdio: 'inherit' });
    return typeof r.status === 'number' ? r.status : 1;
  },
  ref,
);

if (code === 0) {
  console.log('\ncheck-clean-tree 通过：HEAD 的提交内容可类型检查。');
} else {
  console.error('\ncheck-clean-tree 失败：HEAD 的提交内容无法通过 typecheck。');
}
process.exit(code);
