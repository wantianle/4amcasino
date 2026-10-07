#!/usr/bin/env node
// shrink-images — 把目录里的「大 PNG 截图」压成小 JPEG，专治证据图撑爆 agent 上下文。
//
//   node scripts/shrink-images.mjs [dir...]        # 默认 docs/qa
//   node scripts/shrink-images.mjs docs/qa foo/bar
//
// 规则（简单、可重复运行）：
//   - 只处理 > MIN_BYTES 的 PNG（默认 80KB），小图/已压过的图不动；
//   - 等比缩到最宽 MAX_W（默认 1600px），再编码为 JPEG 质量 85；
//   - 同名换扩展名（a.png → a.jpg），并删除原 PNG；
//   - 非 PNG（jpg/webp/gif）一律跳过，避免二次有损。
//
// 依赖系统 ffmpeg（本机已装）。输出每张图的前后大小与重命名，便于核对引用。
//
// 背景：截图脚本（apps/web/test/browser/*.mjs）现已默认直接输出 JPEG（质量 85），
// 本命令是给「历史遗留 / 外部脚本拍的大 PNG」兜底用的一条命令。

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { findRepoRoot } from './lib/repo-root.mjs';

const MIN_BYTES = Number(process.env.MIN_BYTES ?? 80 * 1024);
const MAX_W = Number(process.env.MAX_W ?? 1600);
const QUALITY = Number(process.env.QUALITY ?? 85);

const repoRoot = findRepoRoot(import.meta.url);
const args = process.argv.slice(2);
const dirs = (args.length ? args : ['docs/qa']).map((d) => path.resolve(repoRoot, d));

function which(cmd) {
  const r = spawnSync('sh', ['-c', `command -v ${cmd}`], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : '';
}
const ffmpeg = which('ffmpeg');
if (!ffmpeg) {
  console.error('✗ 未找到 ffmpeg，无法压缩图片。');
  process.exit(1);
}

/** @param {string} dir @returns {string[]} */
function walk(dir, acc = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === 'dist' || e.name === '.git') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (e.isFile() && e.name.toLowerCase().endsWith('.png')) acc.push(p);
  }
  return acc;
}

let totalOld = 0;
let totalNew = 0;
let count = 0;

for (const dir of dirs) {
  for (const src of walk(dir)) {
    const oldBytes = fs.statSync(src).size;
    if (oldBytes < MIN_BYTES) continue;
    const dst = src.slice(0, -4) + '.jpg';
    const filter = `scale='min(${MAX_W},iw)':-2`;
    // quality 85 对应 ffmpeg 的 -q:v 3 左右
    const r = spawnSync(
      ffmpeg,
      ['-hide_banner', '-loglevel', 'error', '-y', '-i', src, '-vf', filter, '-q:v', '3', dst],
      { encoding: 'utf8' },
    );
    if (r.status !== 0) {
      console.error(`✗ ${path.relative(repoRoot, src)} 转换失败：${r.stderr}`);
      continue;
    }
    const newBytes = fs.statSync(dst).size;
    const rel = path.relative(process.cwd(), src);
    const shown = rel.startsWith('..') ? src : rel;
    if (newBytes >= oldBytes) {
      // JPEG 反而更大（如小色块/已优化的 PNG）：保留原图，避免越压越大。
      fs.unlinkSync(dst);
      console.log(`  ${shown}  ${(oldBytes / 1024).toFixed(0)}K  跳过（JPEG 更大）`);
      continue;
    }
    fs.unlinkSync(src);
    totalOld += oldBytes;
    totalNew += newBytes;
    count += 1;
    console.log(`  ${shown}  ${(oldBytes / 1024).toFixed(0)}K -> ${(newBytes / 1024).toFixed(0)}K`);
  }
}

if (count === 0) {
  console.log(`没有需要压缩的 PNG（阈值 ${(MIN_BYTES / 1024).toFixed(0)}K）。`);
} else {
  console.log(
    `\n压缩 ${count} 张：${(totalOld / 1048576).toFixed(2)}MB -> ${(totalNew / 1048576).toFixed(2)}MB ` +
      `(${(totalNew / totalOld).toFixed(2)}x)`,
  );
  console.log('提示：扩展名已变为 .jpg，请同步更新引用这些图片的 md/json/脚本。');
}
