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

## 2. 提交前（关键）

提交前除了日常命令，**必须**跑一次干净树验证：

```bash
npm run check:clean-tree
```

它做的事：用 `git archive HEAD` 把**提交态**源码导出到临时目录 → 为它链好依赖
（第三方依赖复用本仓安装，`@4am/*` 指向临时树自己）→ 在临时树上跑
`npm run typecheck` → **无论成功失败都清理临时目录**。

也就是说，即使你的工作区里还有一堆未提交、甚至坏掉的改动，`check:clean-tree`
检查的也始终是 HEAD 这一份提交。**如果它红了，就不能提交 / 不能推送。**

一条命令串起全部检查：

```bash
npm run check:all            # = check:diff && check:tracked && check:links && check:clean-tree
```

> `check:clean-tree` 会完整跑一遍全 workspace 类型检查，明显比其它几个慢
> （本机实测约 15s）。只改文档 / 提交信息时可以单独跑前三个。

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

## 4. 为什么不能只看工作区 typecheck

`tsc` 读的是磁盘上的文件，它不知道 git。工作区里可能有：

- 新建但**还没 `git add`** 的源文件 → 提交后不存在，编译失败；
- 已改但**只提交了一半**的配套改动 → 提交态自相矛盾；
- 工作区完整、但 `git add` 进去的是**损坏/半截**的内容。

`check-clean-tree` 从 HEAD 重新导出一棵树来验证，绕开了这些陷阱；
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
| `npm run check:all` | 上面四项串联 | 提交 / 推送前 |
