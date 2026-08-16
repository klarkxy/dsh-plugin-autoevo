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
   └─ local miss ──► find_dsh_plugin (current Agent scope)
                         │ absent
                         ▼
                    script-install dsh-find-plugin (approval)
                         │ installed, no valid result
                         ▼
                    no reusable candidate ──► scratch_ready
                                  │
                         finder hit
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
              tool/call + tool/result + completed final answer
                                  │
                                  ▼
                           plugin_remove
```

动态 Cordis 新建入口还有一条执行门禁。带 Agent 身份的 `cordis_define(kind:new)` 首先要求 `agentPresets.serviceFor(agent, "autoevoEvolutionMode")` 返回 AutoEvo 的精确模式标记（owner `dsh-plugin-autoevo` + 协议版本）。标记只由 scoped 导出 `dsh-plugin-autoevo/evolution-mode` 在 preset isolate realm 内发布；preset id 本身不是授权依据。

模式外调用会被拒绝，并引导切换到用户 preset **能力进化**（id `evolution`）。模式内再在 `tools/pre-execute` 预留一次性 `scratch_ready` 权限，并在 monotonic guard 做最终校验；成功的 `tools/result` 消费权限，失败结果恢复权限。状态优先级固定为 `reuse_required > modify_required > review_required > scratch_ready`。

权限只保存在当前进程中，以 Agent 身份和当前 resolution generation 隔离；旧状态记录只能读取，不能恢复创建权限，较晚完成的旧解析或旧 review 也不能覆盖当前授权。

启动时（`evolutionPreset !== false`）AutoEvo 把 bundled `presets/evolution` 安全物化到 `<dshHome>/.agent-presets/evolution`：首次写入 staging 后原子 rename；同版本同 hash 为 no-op；仅在已有目录具备有效 AutoEvo manifest 且文件集与 hash 完全一致时升级；用户修改、外来同名目录、缺文件或多余文件一律保留并诊断。配置为 `false` 时跳过安装与升级，且永不自动删除。

## 3. DSH 接缝

入口 [src/index.ts](../src/index.ts) 以 named exports 暴露 `name`、`inject`、`Config`、`apply`。Loader 通过 `cordis.patch.yml` 挂载 bundle。四个 required services：

- `tools`：枚举能力并注册四个高层工具；
- `skills`：按 cwd 与 Agent scope 枚举技能；
- `subprocess`：以 argv、取消信号和输出上限运行 `gh`、`git` 与 DSH CLI；
- `systemPrompt`：注入固定复用策略。

`tools` 同时承载新建门禁。它只识别带 Agent 身份、结构化的 `cordis_define` 且 `plugin.kind = "new"`，不会猜测普通文件、shell、Git 或无 Agent 的内部调用意图；`plugin.kind = "existing"` 也直接放行。

只读解析与审查依赖 `tools`、`skills`、`subprocess` 与 `systemPrompt`。安装和移除另需 live approval service 和当前 Agent turn。

远端发现是一条分层链路。AutoEvo 先用 `ctx.tools.get('find_dsh_plugin', scope)` 判断当前 Agent 是否允许调用专用搜索插件；命中时通过 `ctx.tools.execute` 做 nested dispatch，因此沿用 DSH 的 restriction、guard、policy、取消信号与事件记录。AutoEvo 只从结果中接受严格的 `https://github.com/owner/repository` 和有界摘要，不采用其 `install` 命令或说明文本；finder 摘要的仓库名、名称、描述、topics 或 package name 还必须覆盖至少一个需求领域锚点，把需求关键词夹在一串其它 Agent/CLI 名称里的热门仓库视为一眼无关。市场工具未安装时，不跑裸 `gh` 搜索，也不把市场当成能力候选再审一遍；AutoEvo 在一次性批准后执行 `dsh plugin add --save-exact dsh-find-plugin`（`market_required`），等待 Cordis 热加载完成后就在当前解析中继续搜索；只有热加载失败才要求重启后重试。市场已装但没有相关命中，视为没有可复用插件。无论候选来自哪一层，保留下来的候选都必须经过同一套 `plugin_review` exact-commit 门禁。

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

`StateStore` 用临时文件加原子 rename 写 JSON receipt。ID 使用受限格式。任何 DSH Profile 变更前先写 `installState: unknown` 的 provisional installation receipt；最终 receipt 写入失败时，temporary trial 会补偿清理，persistent 安装则保留恢复锚点，绝不谎报未安装。

V3 resolution receipt 记录 `authorization` 与远端发现是否完整。远端候选按仓库归组，以该 GitHub review 及其本地改进 lineage 的最新结果为准：任一 `use` 要求复用，任一 `modify` 要求继续修改，存在未审候选则继续审查，只有全部为 `skip` 才可从零创建。运行时一次性权限不写入 receipt，也不跨 Agent 或进程恢复。

Review receipt 绑定策略版本、需求、来源身份、GitHub exact commit 或本地 base commit/status、已检查文件的 blob/content hash、material manifest facts，以及实际 DSH runtime 版本和兼容性。安装前重新审查并比较这些材料。请求 ref 可以从分支名收成同一个 SHA；内容、manifest 或 runtime 兼容性变化会使凭据过期。

## 5. 状态语义

- `installState`：`installed`、`not_installed` 或 `unknown`。持久安装命令异常后必须读取 Profile dependency 协调状态；读取也失败时保持 `unknown` 并要求恢复，不能断言未安装。
- `installed`：兼容旧回执的布尔投影；仅 `installState: installed` 为 true。
- `loaded`：隔离子进程退出成功，可信 observer 至少看到一个预期工具的真实调用。
- `verified`：每个预期工具都有 call-id 匹配的成功 `tool/result`，DSH 会话给出以 `turn/end: completed` 收口的最终回答，并且可选预期文本匹配。
- `restartRequired`：常驻 Profile 已写入依赖，新进程加载新 bundle。
- `removed`：临时 owned trial 已删除，或持久安装 receipt 已完成 remove。

临时安装带验证任务。验证失败会删除 trial，并在 installation receipt 上写下 `removed: true`。

## 6. 部分适配

GitHub review 为 `partial/modify` 时，Agent 从精确 commit 建立 workspace 内 Git checkout，做最小修改并运行原测试，再用 `source_kind=local + base_review_id` 重审。Local review 绑定除 `.git` 与 `node_modules` 外的完整文件集，包括二进制。symlink、特殊文件或触及文件/字节上限的快照记为 `skip`。

本地快照成为 `full/use` 之后才能安装。批准后，安装器把已审查字节复制到 owned snapshot，比较完整路径/hash/size，再用 `npm pack --ignore-scripts` 生成 tgz，复核 snapshot 后交给 DSH 的是 owned `file:...tgz`。temporary artifact 随 trial 清理；persistent artifact 随 receipt 驱动的 remove 清理。

只有当本地修改具备许可证、fit 为 `full` 且已 `verified` 时，贡献建议才会标为可建议。实际提交前先完成当前任务、检查 diff 里的用户特定内容，并取得这一次 fork/push/PR 的明确批准。

## 7. 实现入口

- [src/resolver/local.ts](../src/resolver/local.ts)：本地工具、技能和 tool-search 桥。
- [src/creation-guard.ts](../src/creation-guard.ts)：动态 Cordis 新建调用的一次性运行时授权与并发预留。
- [src/discovery/remote.ts](../src/discovery/remote.ts)：`find_dsh_plugin` 优先与内置 `gh` 回退编排、候选归一化和来源记录。
- [src/github/discovery.ts](../src/github/discovery.ts)：有界 GitHub 候选搜索。
- [src/review/review.ts](../src/review/review.ts)：exact snapshot、manifest/fit/security 派生事实。
- [src/lifecycle/install.ts](../src/lifecycle/install.ts)：批准、重验证、状态机和失败清理。
- [src/lifecycle/snapshot.ts](../src/lifecycle/snapshot.ts)：完整本地文件绑定、owned snapshot 与固定 tgz。
- [src/lifecycle/launcher.ts](../src/lifecycle/launcher.ts)：DSH CLI 与隔离验证进程。
- [src/verification-observer.ts](../src/verification-observer.ts)：记录工具名/callId 往返，以及完成轮最终回答的 hash 和可选预期文本匹配结果；不记录模型正文。
- [src/lifecycle/remove.ts](../src/lifecycle/remove.ts)：receipt 驱动的精确移除。
