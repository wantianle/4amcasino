# 开发验证：验证「提交内容」，而不是工作区

这个仓库吃过亏：**工作区 typecheck 通过，但被提交的那棵树是坏的**。

- 一次是改了 A 文件、忘了同步改 B 文件，只提交了 A；
- 一次是 index / 提交里的 `game.ts` 语法损坏，而工作区里是完整的。

两次的共同根因：**验证的是工作区（working tree），不是提交（commit）**。
工作区可以同时包含「改了但没提交」的东西，于是一路绿灯，提交出去的东西却编译不过。

本页说明日常、提交前、以及 worktree 场景下分别该跑什么。

---

## 1. 日常改动

```bash
npm run typecheck            # 全部 workspace 类型检查
npm run test:fast            # 快速测试（跳过重型 eval / bench）
npm run check:diff           # 空白错误 / 冲突标记
npm run check:tracked        # 有没有「该 add 却没跟踪」的源文件
npm run check:links          # worktree 跨包软链是否指向本 worktree
```

这些命令都**幂等、只读、可重复运行**，随手跑没负担。
所有脚本都按**脚本自身位置**定位仓库根（不是 `process.cwd()`），所以
`node <worktree>/scripts/x.mjs` 与 `cd <worktree> && node scripts/x.mjs` 结果一致。

## 2. 提交前（关键）

提交前除了日常命令，**必须**跑干净树验证。分两步：

```bash
npm run check:clean-tree     # 提交态上跑 typecheck
npm run check:build          # 提交态上跑真实构建（vite build + esbuild）
```

它们做的事：用 `git archive HEAD` 把**提交态**源码导出到临时目录 → 为它链好依赖
（第三方依赖复用本仓安装，`@4am/*` 指向临时树自己）→ 分别跑
`npm run typecheck` 与 `npm run build:all` → **无论成功失败都清理临时目录**。

也就是说，即使你的工作区里还有一堆未提交、甚至坏掉的改动，这两个检查检查的也
始终是 HEAD 这一份提交。**如果它们红了，就不能提交 / 不能推送。**

为什么拆成两个：

- `tsc` 不做模块 / 资源解析，看不见「`import './arena.css'` 指向一个不存在的
  文件」这类问题——曾真实漏网：某提交 `check-clean-tree` 通过，但 `apps/web` 的
  `vite build` 失败（`Could not resolve "./arena.css"`）。
- 真实构建能覆盖 CSS、静态资源、package exports / CDN 依赖的解析，但明显更慢
  （本机 `vite build` 约 12s，`typecheck` 约 12s）。拆开后日常只跑
  `check-clean-tree`，提交 / 推送前再跑 `check:build`。

一条命令串起全部检查：

```bash
npm run check:all            # = check:diff && check:tracked && check:links && check:clean-tree && check:build
```

> `check:clean-tree` 与 `check:build` 各自都要重新导出一遍提交态、跑完整
> workspace 检查，本机实测分别约 14s / 18s，合计约 30s。只改文档 / 提交信息时
> 可以只跑前三个。

## 3. worktree 场景：跨包软链必须指向本 worktree

用 `git worktree` 并行开发时，worktree 的 `node_modules` 常常被软链到主仓的
`node_modules`。后果是：

```
apps/web 里 import 的 @4am/shared
  → 沿 node_modules 向上找到「主仓」的 packages/shared
  → 你在本 worktree 改的 packages/shared 根本没参与编译
```

于是本 worktree **假绿**：跨包改动看着通过，其实压根没生效。

检查：

```bash
npm run check:links
```

它从每个 workspace 包的 `package.json` 出发，按 Node 解析规则求出每个 `@4am/*`
依赖的真实路径，只要 realpath 落在本 worktree 之外就报错，并打印可直接执行的、
指向本 worktree 的修复命令。

> 仓库根由**脚本自身位置**决定，所以无论你 `cd` 进哪个 worktree，还是从主仓用
> 绝对路径 `node <worktree>/scripts/check-links.mjs` 调用，检查的都是脚本所在的
> 那棵 worktree，不会误查主仓。

## 4. 为什么不能只看工作区 typecheck

`tsc` 读的是磁盘上的文件，它不知道 git。工作区里可能有：

- 新建但**还没 `git add`** 的源文件 → 提交后不存在，编译失败；
- 已改但**只提交了一半**的配套改动 → 提交态自相矛盾；
- 工作区完整、但 `git add` 进去的是**损坏/半截**的内容。

`check:clean-tree` / `check:build` 从 HEAD 重新导出一棵树来验证，绕开了这些陷阱；
`check:tracked` 则专门盯住前两类「未跟踪 / 被删」的文件差异。

---

## 命令速查

| 命令 | 作用 | 何时跑 |
| --- | --- | --- |
| `npm run typecheck` | 全 workspace 类型检查（工作区） | 随时 |
| `npm run check:diff` | `git diff --check` + `--cached --check` | 随时 / 提交前 |
| `npm run check:tracked` | 未跟踪的 include 源文件、已跟踪却缺失的文件 | 提交前 |
| `npm run check:links` | worktree `@4am/*` 软链是否指向本 worktree | worktree 里随时 |
| `npm run check:clean-tree` | 在 HEAD 的干净导出上跑 typecheck（验证提交） | **提交 / 推送前必须** |
| `npm run check:build` | 在 HEAD 的干净导出上跑真实构建（资源 / CSS / 模块解析） | **提交 / 推送前必须** |
| `npm run check:all` | 上面五项串联 | 提交 / 推送前 |
