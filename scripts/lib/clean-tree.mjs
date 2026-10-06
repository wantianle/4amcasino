// clean-tree — 把「提交态」源码导出到临时树并链好依赖，供各 check 脚本复用。
//
//   import { withCleanTree } from './lib/clean-tree.mjs';
//
// 为什么需要：工作区可以同时包含「改了但没提交」的文件，于是工作区检查通过，
// 而真正被提交的那棵树是坏的（漏 add、只提交一半）。本模块用 `git archive HEAD`
// 导出**提交态**源码到临时目录，为它链好 node_modules（第三方依赖指向本仓安装，
// @4am/* 指向临时树自己），再把临时树交给回调；无论成功失败都清理。
//
// 依赖按「脚本自身位置」定位的仓库根，故 `node <worktree>/scripts/x.mjs` 与
// `cd <worktree> && node scripts/x.mjs` 行为一致，均针对该 worktree 的 HEAD。

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findRepoRoot } from './repo-root.mjs';

/**
 * 在仓库根执行 git。
 * @param {string[]} args
 * @param {import('node:child_process').SpawnSyncOptions} [opts]
 * @returns {string}
 */
export function git(args, opts = {}) {
  const r = spawnSync('git', args, { encoding: 'utf8', ...opts });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} 失败：${r.stderr || r.status}`);
  return r.stdout ?? '';
}

/** @param {string} target @param {string} linkPath */
function link(target, linkPath) {
  try {
    fs.symlinkSync(target, linkPath);
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
  }
}

/**
 * 导出 HEAD 到临时树、链好依赖后执行 `run`；无论成败都清理临时目录。
 * `run` 返回的退出码作为整个脚本的退出码。
 * @param {string} scriptUrl 传入 `import.meta.url`
 * @param {(ctx: { tmp: string, head: string, repoRoot: string }) => number} run
 * @param {string} [ref] 要验证的 ref，默认 HEAD
 * @returns {number} 退出码
 */
export function withCleanTree(scriptUrl, run, ref = 'HEAD') {
  const repoRoot = findRepoRoot(scriptUrl);
  const head = git(['rev-parse', '--short', ref], { cwd: repoRoot }).trim();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), '4am-clean-tree-'));

  /** 删除临时目录（幂等） */
  function cleanup() {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* 尽力而为 */
    }
  }
  const onSigint = () => {
    cleanup();
    process.exit(130);
  };
  process.on('SIGINT', onSigint);

  try {
    // 1. 导出提交内容（不含工作区未提交改动，天然排除 ignored 文件）
    const archive = spawnSync(
      'bash',
      ['-c', `git archive ${JSON.stringify(ref)} | tar -x -C ${JSON.stringify(tmp)}`],
      { encoding: 'utf8', cwd: repoRoot },
    );
    if (archive.status !== 0) {
      throw new Error(`导出 HEAD 失败：${archive.stderr || archive.status}`);
    }
    console.log(`→ 已导出 HEAD (${head}) 到 ${tmp}（repo: ${repoRoot}）`);

    // 2. 链接依赖：第三方依赖复用本仓安装；@4am/* 指向临时树的 packages/apps
    const tmpNM = path.join(tmp, 'node_modules');
    fs.mkdirSync(tmpNM, { recursive: true });

    const srcNM = path.join(repoRoot, 'node_modules');
    if (!fs.existsSync(srcNM)) {
      throw new Error(`缺少 ${srcNM}，请先在仓库根目录运行 npm install`);
    }
    for (const entry of fs.readdirSync(srcNM)) {
      if (entry === '@4am') continue;
      link(path.join(srcNM, entry), path.join(tmpNM, entry));
    }

    const tmpAt4am = path.join(tmpNM, '@4am');
    fs.mkdirSync(tmpAt4am, { recursive: true });
    for (const group of ['packages', 'apps']) {
      const base = path.join(tmp, group);
      if (!fs.existsSync(base)) continue;
      for (const dir of fs.readdirSync(base)) {
        const pkgJson = path.join(base, dir, 'package.json');
        if (!fs.existsSync(pkgJson)) continue;
        const name = JSON.parse(fs.readFileSync(pkgJson, 'utf8')).name;
        if (typeof name === 'string' && name.startsWith('@4am/')) {
          link(path.join(base, dir), path.join(tmpAt4am, name.slice('@4am/'.length)));
        }
      }
    }
    console.log('→ 已为本仓依赖与 @4am/* 建立软链');

    return run({ tmp, head, repoRoot });
  } finally {
    process.removeListener('SIGINT', onSigint);
    cleanup();
    console.log(`→ 已清理临时目录 ${tmp}`);
  }
}
