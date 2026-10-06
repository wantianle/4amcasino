#!/usr/bin/env node
// check-build — 在一份「只含提交内容」的干净导出里跑真实构建。
//
//   node scripts/check-build.mjs [ref]     # ref 可省略，默认 HEAD
//
// 为什么需要：`tsc` 不做模块/资源解析（不解析 CSS、静态资源、package exports
// 里的资源），于是「import 了一个不存在的 .css」这类坏提交能通过 typecheck。
// 曾真实漏网：某提交 check-clean-tree 通过，但 apps/web 的 `vite build` 失败
// （Could not resolve "./arena.css"）。本脚本在与 check-clean-tree 相同的
// 提交态导出树、相同依赖软链机制上跑 `npm run build:all`（vite build + esbuild），
// 让真实的资源/CSS/CDN 依赖解析暴露出来。
//
// 与 check-clean-tree 拆开的原因：构建明显更慢（vite build 本机约 12s），而
// typecheck 更适合频繁跑。取舍：日常只跑 check-clean-tree，提交/推送前用
// check:all 把两者都跑到。
//
// 仓库根按「脚本自身位置」定位，故与 cwd 无关。
//
// 幂等、可重复运行、失败自清理。有问题时以非零码退出。

import { spawnSync } from 'node:child_process';
import { withCleanTree } from './lib/clean-tree.mjs';

const ref = process.argv[2] ?? 'HEAD';
const code = withCleanTree(
  import.meta.url,
  ({ tmp, head }) => {
    console.log(`→ 在 ${head} 上运行 npm run build:all（vite build + esbuild）…\n`);
    const r = spawnSync('npm', ['run', 'build:all'], { cwd: tmp, stdio: 'inherit' });
    return typeof r.status === 'number' ? r.status : 1;
  },
  ref,
);

if (code === 0) {
  console.log('\ncheck-build 通过：HEAD 的提交内容可真实构建。');
} else {
  console.error('\ncheck-build 失败：HEAD 的提交内容无法构建（资源 / CSS / 模块解析可能有问题）。');
}
process.exit(code);
