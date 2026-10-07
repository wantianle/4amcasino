# docs/qa 证据图

本目录是各类 UAT / 自检的截图证据，供人工目视验收。

## 约定：默认小图

- 截图脚本（`apps/web/test/browser/*.mjs`、`apps/server/test/historyE2E.mjs`）
  **默认直接输出 JPEG（质量 85）**，单张约 30–150KB。新写截图脚本请沿用 `.jpg` 输出，
  不要再用大 PNG——曾有一条 agent 会话因反复读 ~1.4MB 的 PNG 自检、累积到 73MB
  被模型网关以 `Request payload is too large` 拒绝。
- 兜底：目录里若残留大 PNG，一条命令压缩（依赖系统 `ffmpeg`）：

  ```sh
  npm run shots:shrink                 # 默认压 docs/qa
  npm run shots:shrink -- dir1 dir2    # 也可指定目录
  ```

  它会等比缩到最宽 1600px、转 JPEG 质量 85、同名换 `.jpg` 并删除原 PNG
  （扩展名会变，需同步更新引用它的 md/json/脚本）。

## 参考素材不压

`docs/media/gg-reference/**` 是视觉复刻时量取颜色 / 尺寸的**原始依据**，
保持原图，不做有损压缩。
