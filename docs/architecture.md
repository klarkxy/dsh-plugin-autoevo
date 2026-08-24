# 架构说明

[使用指南](user-guide.md) · [开发者指南](developer-guide.md) · [安全模型](security.md) · [返回 README](../README.md)

## 1. 位置

AutoEvo 是 DSH Agent 工作流里的 `Capability Reuse Layer`。它把本地解析、远端发现、审查凭据、批准安装、真实验证和精确清理串成闭环。包管理、GitHub 协作和代码修改继续走 DSH、pnpm、`git`、`gh` 与现有 Coding Agent。

## 2. 运行结构

```text
User task
   │
   ▼
capability_workflow
   ├─ resolve_local
   └─ discover_remote
                  │
        AgentWorkflowViewV2: discovering
        Host pool ≤20; model refine ≤2 rounds / ≤5 supplemental queries
                  │ model seals 1–5 candidate IDs with present
                  ▼
                 Gate 1 (sealed real snapshot shortlist)
                                  │ user picks candidate IDs
                                  ▼
                 review selected remotes
                                  │
                                  ▼
                 INTERRUPT await_confirmation (review conclusion)
                                  │ compare another: navigation + candidate IDs
                                  │ install/modify/create/stop: LLM decision + bound candidate ID
                       ▼
                 Host authentic-turn and workflow-boundary validation
                       │
                  full/use ─────┴───── modify/create (managed git source)
                       │                       │
                       ▼                       ▼
                 install_verify          current-session work + local re-review
                       │                       │
                 approval once          normalized tgz + explicit confirmation
                       │                       │
                       └─────────── use_this ──┘
                                  │
                    still patching / reinstall ──► same workflow resume
                                  │
                                  ▼
                      Host mechanical verification
         tool_roundtrip: Host-attested fixture execute → verified
         bundle_activation: load reviewed bundle, no Agent turn → activated
           (carrier patches count the insert id+name Fiber, not the npm package name)
         manual_runtime persistent: no Host spawn → awaiting_user_test
         (temporary manual_runtime is rejected before approval)
                                  │
                                  ▼
                           plugin_remove
```

启动时（`evolutionPreset !== false`）AutoEvo 把 bundled `presets/evolution`（V14）安全物化到 `<dshHome>/.agent-presets/evolution`：staging、backup、校验后原子替换；精确当前 V14 为 no-op；未改过的 V13 可升级到 V14；未知或用户改过的内容保留并诊断；中断的 staging/backup 可确定性恢复。配置为 `false` 时跳过安装，且永不自动删除。

## 3. DSH 接缝

入口 `src/index.ts` 以 named exports 暴露 `name`、`inject`、`Config`、`apply`，以及 Policy V8 合同与 Host：`POLICY_VERSION`、`SelectionReceipt`、`ActionCommitment`、`ExecutionLease`、`MechanicalFacts`、`ReviewerRequest`/`ReviewerVerdict`、`VERIFICATION_LAYER_KINDS`、`classifyRuntimeSurface`、`lifecycleStateFor`。`DshSemanticReviewerHost` / `DshSemanticVerifierHost` 仍导出以保持兼容，但独立 semantic verifier 不是安装完成的可信门槛。Loader 通过 `cordis.patch.yml` 挂载 bundle。carrier bundle 只插入其它包（例如 `@deepseek-ai/dsh-mcp-client`）；`bundle_activation` 以审查冻结的 insert `id`+`name` 认 Fiber，而不是要求存在名为 npm 包名的 Fiber。主要 required services：

- `tools`：枚举能力并注册发现、补查、密封短名单、恢复、诊断和精确移除工具（`capability_workflow*`、`plugin_remove`）；
- `skills`：按 cwd 与 Agent scope 枚举技能；
- `subprocess`：以 argv、取消信号和输出上限运行 `gh`、`git` 与 DSH CLI；
- `systemPrompt`：注入固定复用策略。
- `agentPresets`：可选地确认当前会话确实使用能力进化 preset，并在施工前验证父会话施工目录；不会创建子 Agent；
- 当前会话的文件、shell 与工具调用仍受 DSH scope 和 AutoEvo `ExecutionGuard` 共同约束。

`tools` 同时承载最终执行门禁。父会话保留创造模式的 inspect / define / run / mount 与委托工具，只拒绝直接装卸。进入托管施工阶段后，只允许托管仓库文件读写、shell 测试、todo、两个官方 Creator skill 与三个 `cordis_inspect_*` 只读工具，其它能力 fail closed。提示词不是授权边界。

只读解析与审查依赖 `tools`、`skills`、`subprocess` 与 `systemPrompt`。安装和移除另需 live approval service 和当前 Agent turn。

远端发现由 Host 直接调用 `gh api /search/repositories`，每条查询都强制带上 `topic:dsh-plugin`。结果只接受严格 `owner/repository` 标识和有界摘要；仓库名、名称、描述、topics 或 package name 还必须覆盖至少一个需求领域锚点，把需求关键词夹在一串其它 Agent/CLI 名称里的热门仓库视为一眼无关。不安装 `dsh-find-plugin`，也不回退到无 topic 的全站 GitHub 搜索。空结果视为没有可复用插件；Agent 在对话里说明后，由 `capability_workflow_resume` 记录新建或停止。只有用户在对话里选中、并由 resume 记入回执的仓库才进入同一套 exact-commit 审查门禁。不要用 `ask_user` 在搜完后立刻弹窗。旧回执里的 `market_required` / `marketplace-setup` 只可读，不再新签发。

发现结果先进入无 interrupt 的模型控制检查点。模型只看 Host 验证身份、派生匹配信号、标记为不可信数据的仓库摘要、已尝试查询和剩余预算；可补查，也可随时从池中密封 1–5 项。密封后候选的可见集合与 Host 接受集合完全一致。Gate 1 后用户要比较其它候选时用只读 `navigation`；Gate 2 的最终动作仍绑定新鲜用户回合、精确 review、commitment/lease 和独立 DSH approval。

## 4. 数据与状态

Host 持久状态默认继续位于 `<dshHome>/autoevo/`，托管源码默认位于当前会话工作区 `.autoevo/sources/`（分别可用 `stateDir` / `sourceDir` 覆盖）：

```text
<workspace>/.autoevo/
├─ .gitignore
└─ sources/<id>/

<dshHome>/autoevo/
├─ source-control/<id>.json
├─ workflows/<id>.json
├─ resolutions/<id>.json
├─ reviews/<id>.json
├─ installations/<id>.json
├─ trials/<installation-id>/dsh-home/
│  └─ preflight-dsh-home/profiles/autoevo-verify/  # 一次性最小 DSH，仅 dsh-base + 候选包
└─ verifications/<uuid>/
   ├─ observer.cordis.yml
   └─ tool-roundtrip.jsonl
```

`StateStore` 用临时文件加原子 rename 写 JSON receipt。ID 使用受限格式。任何 DSH Profile 变更前先写 `installState: unknown`、`installOutcome: pending` 的 provisional installation receipt；最终 receipt 写入失败时，temporary trial 会补偿清理，persistent 安装则保留恢复锚点，绝不谎报未安装。

社区质量筛选与上报不在主线；完整实现留在 `community-quality` 分支。

V2 resolution receipt 记录 `authorization` 与远端发现是否完整。interrupt 绑定 owner session、服务 boot、签发回合水位和不可变候选/审查摘要。Workflow schema V2 持久化候选快照、固定/自适应审查计划、队列、已审候选、候选到 review 的映射和失败摘要；可选的有界 Creator 执行记录保持旧 JSON 兼容。内部 receipt 记录 composition 摘要、所需目录摘要和施工会话身份；为兼容旧 JSON，`childSessionId` 字段当前存放父会话身份。Agent 只看到 `verified` / `unavailable`。只读 `navigation` 携带快照内候选 ID，但不产生授权回执。

`AgentWorkflowViewV2` 是唯一模型展示协议：公开语义状态、事实与证据、剩余预算、硬约束、候选作用域动作和可用工具，不公开内部图节点或规定回答句式。Policy V8 的 resolution、review、receipt、commitment 和 lease 不跨 policy 复用；不兼容的持久状态一律 fail closed。相同无效调用指纹在同一用户回合第二次后断路，但不消费 interrupt 或授权。失败后的 `capability_workflow_diagnose` 只读取关联记录，按失败事件限制为两次调用、八个探针，并脱敏路径、URL、原始 stderr 与施工会话正文。

Policy V3 起，最终副作用确认由 LLM 解释新鲜用户回合并提交结构化 `decision`；Host 不再用关键词或正则重做语义理解。`use_this` / `modify_this` 必须携带该 action 当前允许的 `candidate_id`，Host 只从工作流的 candidate→review 绑定解析精确 review，不接受模型提供 repository、path、review id 或 install spec。Host 仍验证 owner session、boot、interrupt、回合水位、快照 digest、可用 action、候选集合、防重放、review identity 和后续 DSH approval。

Policy V8：新 resolution / review / workflow / receipt 使用 `POLICY_VERSION = 8`。任何 policy 不匹配的持久记录都不得恢复或执行其中的 decision、interrupt、selection receipt、reviewer/verification verdict、commitment 或 lease；Host 只返回 `policy_restart_required` 并要求新建 V8 discovery。这是 fail-closed 防御，不是旧用户迁移功能。内部 graph cursor 不变；公开 `lifecycleState` 映射为 `searched -> selected -> reviewing -> approved|rejected|uncertain|skipped -> awaiting_confirmation -> committed -> leased -> executing -> verified|activated|awaiting_user_test|recovery_required`，外加 `modify_authorized`、`create_authorized`、`stopped`、`interrupted`，并保留 `restart_required` / `market_restart_required` / `market_setup_required` / `reuse_local` 等互不合并的终态。简单 UI 主操作为 `use_this` / `search_more`；`modify_this` / `create_new` / `stop` 放在 advanced/recovery。

MechanicalFacts 只用于展示与路由。显式 OR 条件才会启动独立的 Host-owned semantic reviewer；reviewer 不能铸造 commitment、lease、endpoint 或用户决定。机械验证完全由 Host 驱动，不把验证任务交给普通模型，也不把独立 semantic verifier 当作完成门槛。三层结果严格区分：`tool_roundtrip` passed 才是 `verified`；`bundle_activation` passed 是 `activated`；`manual_runtime` persistent 是 `awaiting_user_test`。三者都是非失败完成态，不阻塞正常聊天，但后二者不得冒充功能已验证。第三方默认没有 Host attestation，通常进入 `manual_runtime` / persistent；包清单 safe/risk 或候选自报不得升级为 `tool_roundtrip`。`manual_runtime` 的 temporary 必须在安装与批准副作用前拒绝。`taskResultMatchedExpectation` 只是诊断字段，不是 verified 真值。

同一 review / source / layer / fixture 不能重复安装或验证；modify 最多两次，重复失败后给出人类决策或诊断出口，不得原样循环。用户在新的顶层消息明确要求清理并重来时，completed 的 `installed` / `restart_required` / `activated` / `awaiting_user_test` 可通过精确工作流归属和一次性批准清理后生成全新 workflow。故障 `recovery_required` 仍使用 sealed interrupt 协议；两条路径不得混同。

Review receipt 绑定策略版本、需求、来源身份、GitHub exact commit 或本地 base commit/status、已检查文件的 blob/content hash、material manifest facts，以及实际 DSH runtime 版本和兼容性。安装前重新审查并比较这些材料。请求 ref 可以从分支名收成同一个 SHA；内容、manifest 或 runtime 兼容性变化会使凭据过期。

## 5. 状态语义

- `installState`：`installed`、`not_installed` 或 `unknown`。
- `installOutcome`：`pending | verified | activated | awaiting_user_test | failed_absent | recovery_required`。`verified`、`activated`、`awaiting_user_test` 都是非失败完成态；只有 `verified` 表示功能已验证。
- `installed`：兼容旧调用方的布尔投影；非失败完成态且精确 profile 来源匹配后为 true。
- `loaded`：Host 证明 bundle 已加载；`tool_roundtrip` 还要求 Host 执行了预期工具。
- `verified`：仅当 Host `tool_roundtrip` passed（Host-attested fixture 经 `ToolRuntime.execute`，预期工具全部覆盖且结果成功）。独立 semantic verifier 不是门槛，模型不得自行判断 success。`taskResultMatchedExpectation` 只作诊断。
- `activated`：Host `bundle_activation` passed，bundle 已加载，但没有工具往返，不得称为功能已验证。
- `awaiting_user_test`：Host `manual_runtime` persistent，`pending_user_test`。自然提示用户到目标客户端/profile 手动测试；不要固定话术，也不要在闲聊中反复追问。
- `restartRequired`：非失败完成态已成立，但当前进程的 Loader 热加载无法完整完成；仅此时要求新进程加载 bundle。
- `removed`：临时 owned trial 已删除，或持久安装 receipt 已完成 remove。

临时安装只适用于 Host 能自动验证的层。`manual_runtime` 的 temporary 在批准、物化和安装前就被拒绝。自动层验证失败会删除 trial，并在 installation receipt 上写下 `removed: true`。

## 6. 部分适配

GitHub review 为 `modify`（partial、peer 不兼容、或可修 high）时，Host 从精确 commit 建立 `sourceDir` 下的普通 Git 仓库和 `autoevo/<workflow-id>` 分支，再把结构化 WorkOrder 和受限 cwd 交给当前能力进化会话。当前会话只在托管源内改源码和运行本地检查；`finish_managed_work` 后，Host 校验 branch/HEAD、Git config/hooks 摘要与工作树，禁用 hooks 和签名创建本地 commit，再做 local review 与固定 tgz。Local review 绑定除 `.git` 与 `node_modules` 外的完整文件集，包括二进制。symlink、特殊文件或触及文件/字节上限的快照记为 `skip`。

本地快照成为 `full` 且用户 `use_this` 之后才能安装。批准后，安装器把已审查字节复制到 owned snapshot，比较完整路径/hash/size，再用 `npm pack --ignore-scripts` 生成 tgz，复核 snapshot 后交给 DSH 的是 owned `file:...tgz`。temporary artifact 随 trial 清理；persistent artifact 随 receipt 驱动的 remove 清理。同一需求的第二刀补丁必须留在这条 resolution：`base_review_id` 可以是上一刀本地 review，HEAD 可以是 lineage root 的后代提交。安装授权看该 resolution 最新一条匹配的 `use_this` 回执，不依赖当前进程里另一次 resolve。

对已装能力的升级复用同一条链路。安装回执（`installations/<id>.json`）经 `reviewId` 指回上游 repository 与 exact commit；Agent 在新的 resolve 里向用户指出该来源，用户选中后按 exact-commit 审查、improve-this、本地重审与固定 tgz 重装，最后按旧回执 `plugin_remove`。从零创建或静态本地插件按普通修复工作升级，不经过新建门禁。

只有当本地修改具备许可证、fit 为 `full` 且已 `verified` 时，贡献建议才会标为可建议。实际提交前先完成当前任务、检查 diff 里的用户特定内容，并取得这一次 fork/push/PR 的明确批准。

## 7. 实现入口

本节只列运行时与 Policy 入口。本地搭建、测试矩阵、调试顺序和发布前检查见[开发者指南](developer-guide.md)。

**Service 装配与 Host 接缝：**

- `src/service.ts`：`CapabilityEvolutionService` 装配，组合下列 resolution / review / modification / semantic-review / managed-work 子模块。
- `src/service-resolution.ts`：resolution 决策回执、显式候选与 next-step 指引。
- `src/service-review.ts`：GitHub / 本地审查编排、冻结规格与改后重审。
- `src/service-modification.ts`：修改阻塞项、验收标准与 WorkOrder 输入。
- `src/service-semantic-review.ts`：ReviewerRequest 铸造、有界审查文件与裁决绑定。
- `src/service-managed-work.ts`：托管施工全周期：Creator 预检、取消保留、modify/create 准备与 finish 收口。
- `src/semantic-host.ts`：`DshSemanticReviewerHost` / `DshSemanticVerifierHost` 的 DSH 子 Agent 实现与有界注释；不是安装完成的可信门槛。
- `src/creation-guard.ts`：Host 用户回合、session/boot/interrupt 绑定与 Cordis 新建拒绝。
- `src/creator-foundation.ts`：官方 Creator 预检、结构化 WorkOrder、运行期 composition/catalog 验证与有界 receipt。
- `src/managed-child.ts`：历史 Host-owned 子会话兼容接口；运行时不再创建子 Agent。
- `src/internal-utils.ts`：`isRecord`、路径包含判断与 PID 存活探测等共享内部工具。

**工作流引擎：**

- `src/workflow/engine.ts`：`WorkflowEngine` 对外类型，以继承链组合以下分层实现。
- `src/workflow/engine-core.ts`：引擎基类：owner/发现控制断言、interrupt 签发、checkpoint 与视图构建。
- `src/workflow/engine-driver.ts`：start/refine/present/diagnose：发现预算、模型控制检查点与有界诊断。
- `src/workflow/engine-recovery.ts`：completed 清理重开与故障恢复计划。
- `src/workflow/engine-resume.ts`：resume 校验、LLM 决策解析与 candidate→review 绑定。
- `src/workflow/candidates.ts`：候选 ID、快照密封与发现池预算常量。
- `src/workflow/grants.ts`：SelectionReceipt / ActionCommitment / ExecutionLease 铸造。

**生命周期：**

- `src/source-manager.ts`：普通 Git 源、排他锁、hookless commit 与来源回执。
- `src/lifecycle/install.ts`：批准、重验证、状态机和失败清理。
- `src/lifecycle/snapshot.ts`：完整本地文件绑定、owned snapshot 与固定 tgz。
- `src/lifecycle/launcher.ts`：DSH CLI、隔离安装进程，以及 Host `bundle_activation` / `tool_roundtrip` 执行。
- `src/host-verification-driver.ts`：按 frozen runtime-surface 选择验证层；plugin 自报不得铸造 `tool_roundtrip`；`manual_runtime` 不拉起验证子进程。
- `src/verification-observer.ts`：记录 Host 工具名/callId 往返与完成轮 hash；不记录模型正文，也不作为语义成功门槛。
- `src/lifecycle/remove.ts`：receipt 驱动的精确移除。

**审查：**

- `src/review/review.ts`：exact snapshot、manifest/fit/security 派生事实。

**发现：**

- `src/resolver/local.ts`：本地工具、技能和 tool-search 桥。
- `src/discovery/remote.ts`：Host 侧 scoped GitHub 发现、候选归一化和来源记录；不回退无 topic 搜索。
- `src/github/discovery.ts`：严格 `owner/repository` 标识校验，以及 `topic:dsh-plugin` 的 `gh api` 搜索。
