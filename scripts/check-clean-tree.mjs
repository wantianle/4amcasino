#!/usr/bin/env node
// check-clean-tree — 在一份「只含提交内容」的干净导出里跑 typecheck。
//
//   node scripts/check-clean-tree.mjs
//
// 为什么不能只看工作区：工作区可以同时包含「改了但没提交」的文件，于是
// 工作区 typecheck 通过，而真正被提交的那棵树是坏的（漏 add、只提交了一半）。
// 本脚本用 `git archive HEAD` 导出**提交态**源码到临时目录，为它链好
// node_modules（第三方依赖指向本仓安装，@4am/* 指向临时树自己），跑 typecheck，
// 最后无论成功失败都清理临时目录。
//
// 幂等、可重复运行、失败自清理。有问题时以非零码退出。

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function git(args, opts = {}) {
  const r = spawnSync('git', args, { encoding: 'utf8', ...opts });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} 失败：${r.stderr || r.status}`);
  return r.stdout ?? '';
}

const repoRoot = fs.realpathSync(git(['rev-parse', '--show-toplevel']).trim());
const head = git(['rev-parse', '--short', 'HEAD']).trim();

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), '4am-clean-tree-'));

/** 删除临时目录（幂等） */
function cleanup() {
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* 尽力而为 */
  }
}

process.on('SIGINT', () => {
  cleanup();
  process.exit(130);
});

/** @param {string} target @param {string} linkPath */
function link(target, linkPath) {
  try {
    fs.symlinkSync(target, linkPath);
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
  }
}

try {
  // 1. 导出提交内容（不含工作区未提交改动，天然排除 ignored 文件）
  const archive = spawnSync('bash', ['-c', `git archive HEAD | tar -x -C ${JSON.stringify(tmp)}`], {
    encoding: 'utf8',
  });
  if (archive.status !== 0) {
    throw new Error(`导出 HEAD 失败：${archive.stderr || archive.status}`);
  }
  console.log(`→ 已导出 HEAD (${head}) 到 ${tmp}`);

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

  // 3. 在提交态上跑 typecheck
  console.log(`→ 在 ${head} 上运行 npm run typecheck …\n`);
  const r = spawnSync('npm', ['run', 'typecheck'], { cwd: tmp, stdio: 'inherit' });
  process.exitCode = typeof r.status === 'number' ? r.status : 1;

  if (process.exitCode === 0) {
    console.log(`\ncheck-clean-tree 通过：HEAD (${head}) 可类型检查。`);
  } else {
    console.error(`\ncheck-clean-tree 失败：HEAD (${head}) 的提交内容无法通过 typecheck。`);
  }
} finally {
  cleanup();
  console.log(`→ 已清理临时目录 ${tmp}`);
}
