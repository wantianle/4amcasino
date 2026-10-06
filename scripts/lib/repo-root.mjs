// repo-root — 按「脚本自身位置」定位仓库根，而不是 process.cwd()。
//
//   import { findRepoRoot } from './lib/repo-root.mjs';
//
// 背景：worktree 场景下，`node <worktree>/scripts/x.mjs` 若从主仓 cwd 启动，
// 基于 cwd 的仓库根会解析到**主仓**，于是脚本检查的是主仓，给出与
// `cd <worktree> && node scripts/x.mjs` 不一致、且具有误导性的结果。
//
// 本模块从脚本文件自身向上找「同时含 package.json 与 .git」的目录作为仓库根。
// worktree 的 .git 是一个文件（gitdir 指回主仓），existsSync 同样成立。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 从脚本自身位置向上定位仓库根（realpath）。
 * @param {string} scriptUrl 传入 `import.meta.url`
 * @returns {string} 仓库根 realpath
 */
export function findRepoRoot(scriptUrl) {
  let dir = path.dirname(fileURLToPath(scriptUrl));
  for (;;) {
    const hasPkg = fs.existsSync(path.join(dir, 'package.json'));
    const hasGit = fs.existsSync(path.join(dir, '.git'));
    if (hasPkg && hasGit) return fs.realpathSync(dir);
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error(
        `无法从 ${scriptUrl} 向上找到仓库根（需同时存在 package.json 与 .git）`,
      );
    }
    dir = parent;
  }
}
