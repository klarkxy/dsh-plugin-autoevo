# 架构说明

## 1. 位置

AutoEvo 是 DSH Agent 工作流里的 `Capability Reuse Layer`。它把本地解析、远端发现、审查凭据、批准安装、真实验证和精确清理串成闭环。包管理、GitHub 协作和代码修改继续走 DSH、pnpm、`git`、`gh` 与现有 Coding Agent。

## 2. 运行结构

```text
User task
   │
   ▼
capability_resolve
   ├─ ctx.tools.schemas(scope)
   ├─ ctx.systemPrompt.assemble(scope)
   ├─ ctx.skills.list(cwd, scope)
   └─ local miss ──► gh api repository search
                                  │
                                  ▼
                            plugin_review
                     exact commit/tree/blob + local Git snapshot
                                  │
                    full/use ─────┴───── partial/modify
                       │                       │
                       ▼                       ▼
                 plugin_install          Agent edits/tests
                       │                       │
                 approval once          local re-review
                       │                       │
                       └─────────── full/use ──┘
                                  │
                                  ▼
                      isolated DSH child Agent
                    tool/call + tool/result + output
                                  │
                                  ▼
                           plugin_remove
```

## 3. DSH 接缝

入口 [src/index.ts](../src/index.ts) 以 named exports 暴露 `name`、`inject`、`Config`、`apply`。Loader 通过 `cordis.patch.yml` 挂载 bundle。四个 required services：

- `tools`：枚举能力并注册四个高层工具；
- `skills`：按 cwd 与 Agent scope 枚举技能；
- `subprocess`：以 argv、取消信号和输出上限运行 `gh`、`git` 与 DSH CLI；
- `systemPrompt`：注入固定复用策略。

只读解析与审查依赖 `tools`、`skills`、`subprocess` 与 `systemPrompt`。安装和移除另需 live approval service 和当前 Agent turn。

## 4. 数据与状态

持久状态在配置的 `stateDir`：

```text
stateDir/
├─ resolutions/<id>.json
├─ reviews/<id>.json
├─ installations/<id>.json
├─ trials/<installation-id>/dsh-home/
└─ verifications/<uuid>/
   ├─ observer.cordis.yml
   └─ tool-roundtrip.jsonl
```

`StateStore` 用临时文件加原子 rename 写 JSON receipt。ID 使用受限格式。任何 DSH Profile 变更前先写 provisional installation receipt；最终 receipt 写失败时，temporary trial 会补偿清理，persistent 安装保留可恢复记录。

Review receipt 绑定策略版本、需求、来源身份、GitHub exact commit 或本地 base commit/status、已检查文件的 blob/content hash，以及 material manifest facts。安装前重新审查并比较这些材料。请求 ref 可以从分支名收成同一个 SHA；内容或 manifest 变化会使凭据过期。

## 5. 状态语义

- `installed`：DSH Profile 依赖安装命令已经成功。
- `loaded`：隔离子进程退出成功，可信 observer 至少看到一个预期工具的真实调用。
- `verified`：每个预期工具都有 call-id 匹配的成功 `tool/result`，并且 DSH 给出了任务结果。
- `restartRequired`：常驻 Profile 已写入依赖，新进程加载新 bundle。
- `removed`：临时 owned trial 已删除，或持久安装 receipt 已完成 remove。

临时安装带验证任务。验证失败会删除 trial，并在 installation receipt 上写下 `removed: true`。

## 6. 部分适配

GitHub review 为 `partial/modify` 时，Agent 从精确 commit 建立 workspace 内 Git checkout，做最小修改并运行原测试，再用 `source_kind=local + base_review_id` 重审。Local review 绑定除 `.git` 与 `node_modules` 外的完整文件集，包括二进制。symlink、特殊文件或触及文件/字节上限的快照记为 `skip`。

本地快照成为 `full/use` 之后才能安装。批准后，安装器把已审查字节复制到 owned snapshot，比较完整路径/hash/size，再用 `npm pack --ignore-scripts` 生成 tgz，复核 snapshot 后交给 DSH 的是 owned `file:...tgz`。temporary artifact 随 trial 清理；persistent artifact 随 receipt 驱动的 remove 清理。

贡献建议在本地修改具备许可证、full fit 且已经 verified 之后标为可建议。实际提交前先完成当前任务、检查 diff 里的用户特定内容，并取得这一次 fork/push/PR 的明确批准。

## 7. 实现入口

- [src/resolver/local.ts](../src/resolver/local.ts)：本地工具、技能和 tool-search 桥。
- [src/github/discovery.ts](../src/github/discovery.ts)：有界 GitHub 候选搜索。
- [src/review/review.ts](../src/review/review.ts)：exact snapshot、manifest/fit/security 派生事实。
- [src/lifecycle/install.ts](../src/lifecycle/install.ts)：批准、重验证、状态机和失败清理。
- [src/lifecycle/snapshot.ts](../src/lifecycle/snapshot.ts)：完整本地文件绑定、owned snapshot 与固定 tgz。
- [src/lifecycle/launcher.ts](../src/lifecycle/launcher.ts)：DSH CLI 与隔离验证进程。
- [src/verification-observer.ts](../src/verification-observer.ts)：只记录工具名与 callId 的往返 observer。
- [src/lifecycle/remove.ts](../src/lifecycle/remove.ts)：receipt 驱动的精确移除。
