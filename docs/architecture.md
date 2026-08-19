# 架构说明

## 1. 位置

AutoEvo 是 DSH Agent 工作流里的 `Capability Reuse Layer`。它把本地解析、远端发现、审查凭据、批准安装、真实验证和精确清理串成闭环。包管理、GitHub 协作和代码修改继续走 DSH、pnpm、`git`、`gh` 与现有 Coding Agent。

## 2. 运行结构

```text
User task
   │
   ▼
capability_workflow
   ├─ resolve_local
   ├─ strict full local ──► interrupt-bound local recommendation
   └─ partial/none ───────► discover_remote / ensure_market
                                  │
                 INTERRUPT await_selection (snapshot-bound shortlist, max 3)
                                  │ Agent maps natural language to candidate IDs
                                  ▼
                 capability_workflow_resume + navigation
                                  │ fixed or adaptive review plan
                                  ▼
                 review_github batch (concurrency 2, optional third)
                                  │
                                  ▼
                 INTERRUPT await_confirmation (review-derived actions)
                       │ compare another: navigation + candidate IDs
                       │ side effect: LLM decision + bound candidate ID
                       ▼
                 Host authentic-turn and workflow-boundary validation
                       │
                  full/use ─────┴───── modify/create (managed git source child)
                       │                       │
                       ▼                       ▼
                 install_verify          workspace-write child + local re-review
                       │                       │
                 approval once          normalized tgz + explicit confirmation
                       │                       │
                       └─────────── use_this ──┘
                                  │
                    still patching / reinstall ──► same workflow resume
                                  │
                                  ▼
                      isolated DSH child Agent
         tools: tool/call + tool/result + completed final answer
         no tools: child exit 0 + completed-turn (load verification)
                                  │
                                  ▼
                           plugin_remove
```

父会话执行层拒绝 write/edit、shell、Cordis mutation、委托与直接 plugin 装卸。`create_new` / `modify_this` 只在 Host 拉起的托管 git 源子会话中继续（`sourceDir` 默认 `<stateDir>/sources`，sandbox 模式 `workspace-write`）。父会话不得 `cordis_define(kind:new)`。Windows 上为完整性导向的部分隔离。

托管子会话创建完成后，父取消信号不再依赖 DSH 的 creation-only signal，而由 AutoEvo 监听并立即调用 owned `AgentHandle.dispose()`。取消后的编辑以独立 cleanup timeout 创建 WIP checkpoint；workflow 转到 `recovery_required`，随后验证干净工作树并释放 source lock。runner 区分 cancel、timeout 与 executable lookup failure。

启动时（`evolutionPreset !== false`）AutoEvo 把 bundled `presets/evolution`（V9）在排他迁移锁下安全物化到 `<dshHome>/.agent-presets/evolution`：staging、backup、校验后原子替换；精确 V9 为 no-op；已知 pristine v1–v8 升级；未知或用户改过的内容保留并诊断；中断的 staging/backup 可确定性恢复。配置为 `false` 时跳过安装与升级，且永不自动删除。

## 3. DSH 接缝

入口 [src/index.ts](../src/index.ts) 以 named exports 暴露 `name`、`inject`、`Config`、`apply`，以及 Policy V5 合同与 Host：`POLICY_VERSION`、`SelectionReceipt`、`ActionCommitment`、`ExecutionLease`、`MechanicalFacts`、`ReviewerRequest`/`ReviewerVerdict`、`VerificationVerdict`、`DshSemanticReviewerHost`、`DshSemanticVerifierHost`、`lifecycleStateFor`。Loader 通过 `cordis.patch.yml` 挂载 bundle。主要 required services：

- `tools`：枚举能力并注册三个高层工具（`capability_workflow`、`capability_workflow_resume`、`plugin_remove`）；
- `skills`：按 cwd 与 Agent scope 枚举技能；
- `subprocess`：以 argv、取消信号和输出上限运行 `gh`、`git` 与 DSH CLI；
- `systemPrompt`：注入固定复用策略。
- `agents` / `agentPresets`：由 Host 建立并验证 `code` 子会话所有权；
- `sandbox` / `sandboxPolicy` / `fs`：对子会话的真实 `workspace-write` 文件与 shell 边界做启动探测。

`tools` 同时承载最终执行门禁。父会话的 `cordis_define(kind=new)` 永远拒绝；父会话也以 allowlist 拒绝写文件、shell、Cordis 修改、委派和直接装卸。modify/create 只能由 Host 建立受管子会话；提示词不是授权边界。

只读解析与审查依赖 `tools`、`skills`、`subprocess` 与 `systemPrompt`。安装和移除另需 live approval service 和当前 Agent turn。

远端发现是一条分层链路。AutoEvo 先用 `ctx.tools.get('find_dsh_plugin', scope)` 判断当前 Agent 是否允许调用专用搜索插件；命中时通过 `ctx.tools.execute` 做 nested dispatch，因此沿用 DSH 的 restriction、guard、policy、取消信号与事件记录。AutoEvo 只从结果中接受严格的 `https://github.com/owner/repository` 和有界摘要，不采用其 `install` 命令或说明文本；finder 摘要的仓库名、名称、描述、topics 或 package name 还必须覆盖至少一个需求领域锚点，把需求关键词夹在一串其它 Agent/CLI 名称里的热门仓库视为一眼无关。市场工具未安装时，不跑裸 `gh` 搜索，也不把市场当成能力候选再审一遍；AutoEvo 在一次性批准后执行 `dsh plugin add --save-exact dsh-find-plugin`（`market_required`），等待 Cordis 热加载完成后就在当前解析中继续搜索；只有热加载失败才要求重启后重试。市场已装但没有相关命中，视为没有可复用插件；Agent 在对话里说明后，由 `capability_workflow_resume` 记录新建或停止。无论候选来自哪一层，只有用户在对话里选中、并由 resume 记入回执的仓库才进入同一套 exact-commit 审查门禁。不要用 `ask_user` 在搜完后立刻弹窗。

> **V6 覆盖说明：** 上一段的“resume 记入只读选择回执”已被新协议取代。产品名不能单独成为完整匹配；只有严格 `full` 的本地候选可跳过远端发现。远端固定为最多三个稳定候选 ID；Agent 把多选、序号和“另一个”等指代映射为只读 `navigation`，Host 只验证快照成员关系，不产生 DecisionReceipt。选定候选以两路并发审查，adaptive 模式在前两个均不可直接使用时才补审第三个。

## 4. 数据与状态

持久状态在配置的 `stateDir`：

```text
stateDir/
├─ workflows/<id>.json
├─ resolutions/<id>.json
├─ reviews/<id>.json
├─ installations/<id>.json
├─ trials/<installation-id>/dsh-home/
└─ verifications/<uuid>/
   ├─ observer.cordis.yml
   └─ tool-roundtrip.jsonl
```

`StateStore` 用临时文件加原子 rename 写 JSON receipt。ID 使用受限格式。任何 DSH Profile 变更前先写 `installState: unknown`、`installOutcome: pending` 的 provisional installation receipt；最终 receipt 写入失败时，temporary trial 会补偿清理，persistent 安装则保留恢复锚点，绝不谎报未安装。

社区质量筛选与上报不在主线；完整实现留在 `community-quality` 分支。

V2 resolution receipt 记录 `authorization` 与远端发现是否完整。interrupt 绑定 owner session、服务 boot、签发回合水位和不可变候选/审查摘要。Workflow schema V2 持久化候选快照、固定/自适应审查计划、队列、已审候选、候选到 review 的映射和失败摘要。只读 `navigation` 携带快照内候选 ID，但不产生授权回执。

Policy V3 起，最终副作用确认由 LLM 解释新鲜用户回合并提交结构化 `decision`；Host 不再用关键词或正则重做语义理解。`use_this` / `modify_this` 必须携带该 action 当前允许的 `candidate_id`，Host 只从工作流的 candidate→review 绑定解析精确 review，不接受模型提供 repository、path、review id 或 install spec。Host 仍验证 owner session、boot、interrupt、回合水位、快照 digest、可用 action、候选集合、防重放、review identity 和后续 DSH approval。

Policy V5：新 resolution / review / workflow / receipt 使用 `POLICY_VERSION = 5`。未完成的旧 policy workflow 不得恢复或执行旧 decision、interrupt、selection receipt、reviewer/verification verdict、commitment 或 lease；通过 `capability_workflow` 启动时会作废旧未完成记录并开一条新的 V5 discovery，resume 旧 workflow 只返回 `policy_restart_required`（公开 lifecycle 为 `interrupted`），下一步再 start 才会新建 V5。旧 review 仍可读可展示，但不能授权 use/install。内部 graph cursor 不变；公开 `lifecycleState` 映射为 `searched -> selected -> reviewing -> approved|rejected|uncertain|skipped -> awaiting_confirmation -> committed -> leased -> executing -> verified|recovery_required`，外加 `modify_authorized`、`create_authorized`、`stopped`、`interrupted`，并保留 `restart_required` / `market_restart_required` / `market_setup_required` / `reuse_local` 等互不合并的终态。简单 UI 主操作为 `use_this` / `search_more`；`modify_this` / `create_new` / `stop` 放在 advanced/recovery。

MechanicalFacts 只用于展示与路由。显式 OR 条件才会启动独立的 Host-owned semantic reviewer；reviewer 不能铸造 commitment、lease、endpoint 或用户决定。安装成功要求 Host mechanical Loader 证据（call-id 匹配的 tool/call 与成功 tool/result，加上 completed-turn）以及独立 semantic verifier；`taskResultMatchedExpectation` 只是诊断字段，不是 verified 真值。

Review receipt 绑定策略版本、需求、来源身份、GitHub exact commit 或本地 base commit/status、已检查文件的 blob/content hash、material manifest facts，以及实际 DSH runtime 版本和兼容性。安装前重新审查并比较这些材料。请求 ref 可以从分支名收成同一个 SHA；内容、manifest 或 runtime 兼容性变化会使凭据过期。

## 5. 状态语义

- `installState`：`installed`、`not_installed` 或 `unknown`。持久安装命令异常后必须读取 Profile dependency 协调状态；读取也失败时保持 `unknown` 并要求恢复，不能断言未安装。
- `installOutcome`：`pending | verified | failed_absent | recovery_required`；只有 `verified` 可投影为成功。
- `installed`：兼容旧调用方的布尔投影；只有 Loader/runtime 与精确 profile 来源都验证后才为 true。
- `loaded`：隔离子进程退出成功，可信 observer 至少看到一个预期工具的真实调用。
- `verified`：Host mechanical 成功（每个预期工具都有 call-id 匹配的成功 `tool/result`，DSH 会话给出以 `turn/end: completed` 收口的最终回答）并且独立 semantic verifier 给出绑定当前 evidence digest 的 `verified` 裁决。`taskResultMatchedExpectation` 只作诊断，不作为成功门槛。
- `restartRequired`：精确来源与独立子进程验证已通过，但当前进程的 Loader 热加载无法完整完成；仅此时要求新进程加载 bundle。
- `removed`：临时 owned trial 已删除，或持久安装 receipt 已完成 remove。

临时安装带验证任务。验证失败会删除 trial，并在 installation receipt 上写下 `removed: true`。

## 6. 部分适配

GitHub review 为 `modify`（partial、peer 不兼容、或可修 high）时，Host 从精确 commit 建立 `sourceDir` 下的普通 Git 仓库和 `autoevo/<workflow-id>` 分支，再启动 cwd 精确绑定该仓库的 `workspace-write` 子会话。子会话只改源码和运行本地检查；Host 校验 branch/HEAD、Git config/hooks 摘要与工作树后，禁用 hooks 和签名创建本地 commit，再做 local review 与固定 tgz。Local review 绑定除 `.git` 与 `node_modules` 外的完整文件集，包括二进制。symlink、特殊文件或触及文件/字节上限的快照记为 `skip`。

本地快照成为 `full` 且用户 `use_this` 之后才能安装。批准后，安装器把已审查字节复制到 owned snapshot，比较完整路径/hash/size，再用 `npm pack --ignore-scripts` 生成 tgz，复核 snapshot 后交给 DSH 的是 owned `file:...tgz`。temporary artifact 随 trial 清理；persistent artifact 随 receipt 驱动的 remove 清理。同一需求的第二刀补丁必须留在这条 resolution：`base_review_id` 可以是上一刀本地 review，HEAD 可以是 lineage root 的后代提交。安装授权看该 resolution 最新一条匹配的 `use_this` 回执，不依赖当前进程里另一次 resolve。

对已装能力的升级复用同一条链路。安装回执（`installations/<id>.json`）经 `reviewId` 指回上游 repository 与 exact commit；Agent 在新的 resolve 里向用户指出该来源，用户选中后按 exact-commit 审查、improve-this、本地重审与固定 tgz 重装，最后按旧回执 `plugin_remove`。从零创建或静态本地插件按普通修复工作升级，不经过新建门禁。

只有当本地修改具备许可证、fit 为 `full` 且已 `verified` 时，贡献建议才会标为可建议。实际提交前先完成当前任务、检查 diff 里的用户特定内容，并取得这一次 fork/push/PR 的明确批准。

## 7. 实现入口

- [src/resolver/local.ts](../src/resolver/local.ts)：本地工具、技能和 tool-search 桥。
- [src/creation-guard.ts](../src/creation-guard.ts)：Host 用户回合、session/boot/interrupt 绑定与 Cordis 新建拒绝。
- [src/managed-child.ts](../src/managed-child.ts)：Host-owned 子会话、code preset、sandbox 探测和完成回执。
- [src/source-manager.ts](../src/source-manager.ts)：普通 Git 源、排他锁、hookless commit 与来源回执。
- [src/discovery/remote.ts](../src/discovery/remote.ts)：`find_dsh_plugin` 发现、候选归一化和来源记录；市场未安装时申请安装，不回退裸 `gh` 搜索。
- [src/github/discovery.ts](../src/github/discovery.ts)：严格 `owner/repository` 标识校验。
- [src/review/review.ts](../src/review/review.ts)：exact snapshot、manifest/fit/security 派生事实。
- [src/workflow/engine.ts](../src/workflow/engine.ts)：固定图工作流引擎、interrupt/resume、checkpoint。
- [src/lifecycle/install.ts](../src/lifecycle/install.ts)：批准、重验证、状态机和失败清理。
- [src/lifecycle/snapshot.ts](../src/lifecycle/snapshot.ts)：完整本地文件绑定、owned snapshot 与固定 tgz。
- [src/lifecycle/launcher.ts](../src/lifecycle/launcher.ts)：DSH CLI 与隔离验证进程。
- [src/verification-observer.ts](../src/verification-observer.ts)：记录工具名/callId 往返，以及完成轮最终回答的 hash 和可选预期文本匹配结果；不记录模型正文。
- [src/lifecycle/remove.ts](../src/lifecycle/remove.ts)：receipt 驱动的精确移除。
