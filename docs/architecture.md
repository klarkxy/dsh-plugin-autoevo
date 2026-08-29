# 架构说明

[使用指南](user-guide.md) · [开发者指南](developer-guide.md) · [安全模型](security.md) · [返回 README](../README.md)

## 1. 位置

AutoEvo 是 DSH Agent 工作流里的轻量能力复用层，负责组织本地解析、远端发现、审查证据、用户决策、结果状态与清理记录。

权限、sandbox 和 approval 的强制执行属于 DSH Core；AutoEvo 不创建第二套安全边界，也不会用 warning 或 receipt 覆盖 DSH Core 的决定。包管理、GitHub 协作和代码修改继续走 DSH、pnpm、`git`、`gh` 与现有 Coding Agent。

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
        Host complete bounded union ≤105; model-led queries ≤5 per user turn
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

启动时（`evolutionPreset !== false`）AutoEvo 把 bundled `presets/evolution` 安全物化到 `<dshHome>/.agent-presets/evolution`：staging、校验后原子替换；内容已一致时为 no-op；用户改过或来源不明的目录保留并给出诊断；中断的 staging/backup 可确定性恢复。配置为 `false` 时跳过物化，且永不自动删除已有 preset。

交互概览图（简化表达，细节以上图为准；点击查看 HTML 原图）：

[![AutoEvo 主工作流与两道确认门](assets/flowcharts/autoevo-main-workflow.svg)](assets/flowcharts/autoevo-main-workflow.html)

## 3. DSH 接缝

入口 `src/index.ts` 以 named exports 暴露 `name`、`inject`、`Config`、`apply`，以及 Policy 合同与 Host：`POLICY_VERSION`、`SelectionReceipt`、`ActionCommitment`、`ExecutionLease`、`MechanicalFacts`、`ReviewerRequest`/`ReviewerVerdict`、`VERIFICATION_LAYER_KINDS`、`classifyRuntimeSurface`、`lifecycleStateFor`、`DshSemanticReviewerHost`/`DshSemanticVerifierHost`。独立 semantic verifier 不是安装完成的可信门槛。

Loader 通过 `cordis.patch.yml` 挂载 bundle。carrier bundle 只插入其它包（例如 `@deepseek-ai/dsh-mcp-client`）；`bundle_activation` 以审查冻结的 insert `id`+`name` 认 Fiber，而不是要求存在名为 npm 包名的 Fiber。

主要 required services：

- `tools`：枚举能力并注册发现、补查、密封短名单、恢复、诊断和精确移除工具（`capability_workflow*`、`plugin_remove`）；
- `skills`：按 cwd 与 Agent scope 枚举技能；
- `subprocess`：以 argv、取消信号和输出上限运行 `gh`、`git` 与 DSH CLI；
- `systemPrompt`：仅向能力进化会话注入复用策略合同；
- `agentPresets`：确认父会话使用能力进化 preset，并为受管施工子会话挂载受信任的系统级 Creator preset。

父会话保持决策与治理边界，不在托管源内直接施工。获批的创建/修改由 Host 创建 cwd 精确绑定到单个托管源的短生命周期子会话；DSH Core 以该不可变 cwd 作为 `workspace-write` 根，AutoEvo 再限制发布、插件变更、Cordis 运行时变更、嵌套委派，以及 `pnpm add/update/remove/dlx` 与 `npx`。托管根内落实已声明依赖的 `pnpm install --ignore-scripts`（无包参数）是允许的。提示词不是授权边界。

只读解析与审查依赖 `tools`、`skills`、`subprocess` 与 `systemPrompt`；安装和移除另需 live approval service 和当前 Agent turn。

### 远端发现

- Host 直接调用 `gh api /search/repositories`，每条查询强制带 `topic:dsh-plugin`；不安装 `dsh-find-plugin`，也不回退到无 topic 的全站搜索。
- 结果只接受严格 `owner/repository` 标识、有界摘要和客观可用的非 archived、非 fork 仓库；Host 不再用语义分数淘汰候选。
- Agent 提供查询时 Host 只规范化、校验、加 scope 并执行，从不改写 Agent 短语。Agent 未提供查询且没有待澄清时，Host 可从权威需求派生互补兜底检索短语。
- 五条查询的有界结果完整去重后交给 Agent。匹配分数只决定阅读顺序；用户给出的精确仓库固定置顶，不会被旧候选或池容量挤掉。
- 空结果视为没有可复用插件：Agent 在对话里说明后，由 `capability_workflow_resume` 记录新建或停止。
- 只有用户在对话里选中、并由 resume 记入回执的仓库才进入 exact-commit 审查门禁。

发现结果先进入无 interrupt 的模型控制检查点：模型看到完整的有界候选卡、Host 验证身份、派生匹配信号、命中查询、topics、标记为不可信数据的仓库摘要、已尝试查询和剩余预算；可补查，也可随时从池中密封 1–5 项。只有这 1–5 项会把精确 commit 缓存到当前工作区，并从本地 Git 对象读取有界的 `package.json`、README 与 DSH manifest 预览；合集仓库会按有效 DSH bundle 子目录展开，外部文本仍是不可信数据。密封后候选的可见集合与 Host 接受集合完全一致，远端身份绑定 `repository + commit + packagePath`。Gate 1 后用户可从中选择 1–3 项进入 exact-commit 正式审查；比较其它候选时用只读 `navigation`；Gate 2 的最终动作仍绑定新鲜用户回合、精确 review、commitment/lease 和独立 DSH approval。

正式审查与发现预览严格分离。Host 对精确 GitHub commit 或托管本地 HEAD 只执行一次 `npm pack --ignore-scripts`，流式验证 tgz 路径与条目类型并审查其中的完整文件内容；`ReviewRecord` 同时绑定条目清单、tgz SHA-256 和 owned root。安装只接受该 `file:` 产物，批准前与目标 profile 写入前都会复算 hash，且通过 DSH/pnpm 安装时继续设置 `ignore-scripts`。因此 `maxFiles` / `maxRepositoryBytes` 只约束候选预览，不决定安装包能否被审查或安装。

## 4. 数据与状态

Host 持久状态默认位于 `<dshHome>/autoevo/`，托管源码默认位于当前会话工作区 `.autoevo/sources/`（分别可用 `stateDir` / `sourceDir` 覆盖）：

```text
<workspace>/.autoevo/
├─ .gitignore
├─ cache/git/<repository-hash>.git
└─ sources/<id>/

<dshHome>/autoevo/
├─ source-control/<id>.json
├─ workflows/<id>.json
├─ resolutions/<id>.json
├─ reviews/<id>.json
├─ installations/<id>.json
├─ review-artifacts/review-<uuid>/
│  └─ <package>.tgz
└─ verifications/<uuid>/
   ├─ observer.cordis.yml
   └─ tool-roundtrip.jsonl
```

`cache/git` 是可删除、可重建的传输缓存：预览与正式审查从中读取精确 commit，并在选中 `packagePath` 上创建临时稀疏 worktree。它不产生安装授权，也不是 review/install authority；唯一安装权威仍是 `<dshHome>/autoevo/review-artifacts` 下经审查和哈希绑定的 tgz。

`StateStore` 用临时文件加原子 rename 写 JSON receipt，ID 使用受限格式。任何 DSH Profile 变更前先写 `installState: unknown`、`installOutcome: pending` 的 provisional installation receipt；最终 receipt 写入失败时，persistent 安装保留恢复锚点，绝不谎报未安装。

### Receipt 与绑定

- Resolution receipt 记录 `authorization` 与远端发现是否完整。
- Interrupt 绑定 owner session、服务 boot、签发回合水位和不可变候选/审查摘要。
- Workflow 记录持久化候选快照、审查计划、队列、已审候选、候选到 review 的映射和失败摘要。
- 内部 receipt 记录 composition 摘要、所需目录摘要和施工会话身份；Agent 只看到 `verified` / `unavailable`。
- 只读 `navigation` 携带快照内候选 ID，但不产生授权回执。

`AgentWorkflowViewV2` 是唯一模型展示协议：公开语义状态、事实与证据、剩余预算、硬约束、候选作用域动作和可用工具，不公开内部图节点或规定回答句式。相同无效调用指纹在同一用户回合第二次后断路，但不消费 interrupt 或授权。失败后的 `capability_workflow_diagnose` 只读取关联记录，按失败事件限制调用，并脱敏路径、URL、原始 stderr 与施工会话正文。

### 授权与跨版本规则

- 最终副作用确认由 LLM 解释新鲜用户回合并提交结构化 `decision`；Host 不用关键词或正则重做语义理解。
- `use_this` / `modify_this` 必须携带该 action 当前允许的 `candidate_id`；Host 只从工作流的 candidate→review 绑定解析精确 review，不接受模型提供的 repository、path、review id 或 install spec。
- Host 仍验证 owner session、boot、interrupt、回合水位、快照 digest、可用 action、候选集合、防重放、review identity 和后续 DSH approval。
- 当前 Policy 为 V13（`POLICY_VERSION = 13`）。任何旧 Policy 的未完成记录都不得恢复或执行其 decision、interrupt、receipt、verdict、commitment 或 lease，Host 要求从当前顶层用户原文重开；已完成安装与历史 receipt 仍可读取和显式删除。

### 验证与安装语义

MechanicalFacts 只用于展示与路由。显式 OR 条件才会启动独立的 Host-owned semantic reviewer；reviewer 不能铸造 commitment、lease、endpoint 或用户决定。机械验证完全由 Host 驱动，不把验证任务交给普通模型。

三层结果严格区分，三者都是非失败完成态，但后二者不得冒充功能已验证：

| Layer | 结果 | 语义 |
| --- | --- | --- |
| `tool_roundtrip` passed | `verified` | Host-attested fixture 经 `ToolRuntime.execute`，预期工具全部覆盖且成功 |
| `bundle_activation` passed | `activated` | 审查 bundle 已加载，无工具往返 |
| `manual_runtime` persistent | `awaiting_user_test` | 无 Host spawn，等待用户人工测试 |

- 第三方默认没有 Host attestation，通常进入 `manual_runtime` / persistent；包清单 safe/risk 或候选自报不得升级为 `tool_roundtrip`。
- `manual_runtime` 的 temporary 必须在安装与批准副作用前拒绝。
- `taskResultMatchedExpectation` 只是诊断字段，不是 verified 真值。

同一 review / source / layer / fixture 不能重复安装或验证；modify 最多两次，重复失败后给出人类决策或诊断出口，不得原样循环。用户在新的顶层消息明确要求清理并重来时，completed 的 `installed` / `restart_required` / `activated` / `awaiting_user_test` 可通过精确工作流归属和一次性批准清理后生成全新 workflow；故障 `recovery_required` 仍使用 sealed interrupt 协议，两条路径不得混同。

Review receipt 绑定 Policy 版本、需求、来源身份、GitHub exact commit 或本地 base commit/status、已检查文件的 blob/content hash、material manifest facts，以及实际 DSH runtime 版本和兼容性。安装前重新审查并比较这些材料；请求 ref 可以从分支名收成同一个 SHA，内容、manifest 或 runtime 兼容性变化会使凭据过期。

## 5. 状态语义

- `installState`：`installed`、`not_installed` 或 `unknown`。
- `installOutcome`：`pending | verified | activated | awaiting_user_test | failed_absent | recovery_required`。前三个完成态中，只有 `verified` 表示功能已验证。
- `installed`：兼容旧调用方的布尔投影；非失败完成态且精确 profile 来源匹配后为 true。
- `loaded`：Host 证明 bundle 已加载；`tool_roundtrip` 还要求 Host 执行了预期工具。
- `verified`：仅当 Host `tool_roundtrip` passed。模型不得自行判断 success；`taskResultMatchedExpectation` 只作诊断。
- `activated`：Host `bundle_activation` passed，bundle 已加载但没有工具往返，不得称为功能已验证。
- `awaiting_user_test`：Host `manual_runtime` persistent，`pending_user_test`。自然提示用户到目标客户端/profile 手动测试；不要固定话术，也不要在闲聊中反复追问。
- `restartRequired`：非失败完成态已成立，但当前进程的 Loader 热加载无法完整完成；仅此时要求新进程加载 bundle。
- `removed`：临时 owned trial 已删除，或持久安装 receipt 已完成 remove。

用户可见安装一律持久化，公开决策不接受 `retention`。标准流程不创建私有预检 profile；安装、脚本与包管理器行为交给 DSH 的正常权限、sandbox 和 approval 规则。

交互版（点击查看 HTML 原图）：

[![AutoEvo 安装结果状态机](assets/flowcharts/autoevo-install-outcomes.svg)](assets/flowcharts/autoevo-install-outcomes.html)

## 6. 部分适配

用户选择 `modify` 时，Host 从精确 commit 建立 `sourceDir` 下的普通 Git 仓库和 `autoevo/<workflow-id>` 分支，再把结构化 WorkOrder 交给 cwd 精确绑定到该仓库的受管施工子会话。子会话可编辑、运行有界构建/测试，并在托管根内用无参数的 `pnpm install --ignore-scripts` 落实已声明依赖；`pnpm add/update/remove/dlx`、`npx`、发布、改动 DSH 插件/profile、提交 Git 或逃出托管根仍被拒绝。完成后 Host 校验当前内容、无 hook 提交、重新审查并固定实际安装包。

- Local review 绑定除 `.git` 与 `node_modules` 外的完整文件集，包括二进制。
- 无法形成有效安装描述或快照不完整时不可安装，其余风险与适配差异作为建议展示。
- 本地快照完成重新审查且用户 `use_this` 之后才能安装；`fit`、风险和 reviewer 意见保持建议性质。
- 安装器把审查后的字节复制到 owned snapshot，生成固定 tgz 并把 owned `file:...tgz` 交给 DSH；生命周期脚本是否运行由 DSH 与包管理器的正常规则决定，AutoEvo 不修改 profile 构建白名单。
- persistent artifact 随 receipt 驱动的 remove 清理；同一需求的后续修改继续留在原 resolution；最终安装始终绑定最新 review 与固定内容。

对已装能力的升级复用同一条链路：安装回执经 `reviewId` 指回上游 repository 与 exact commit；Agent 在新的 resolve 里向用户指出该来源，用户选中后按 exact-commit 审查、improve-this、本地重审与固定 tgz 重装，最后按旧回执 `plugin_remove`。从零创建或静态本地插件按普通修复工作升级，不经过新建门禁。

只有当本地修改具备许可证、fit 为 `full` 且已 `verified` 时，贡献建议才会标为可建议。实际提交前先完成当前任务、检查 diff 里的用户特定内容，并取得这一次 fork/push/PR 的明确批准。

## 7. 实现入口

本节只列运行时入口。本地搭建、测试矩阵、调试顺序和发布前检查见[开发者指南](developer-guide.md)。

**Service 装配与 Host 接缝：**

- `src/service.ts`：`CapabilityEvolutionService` 装配，组合下列 resolution / review / modification / semantic-review / managed-work 子模块。
- `src/service-resolution.ts`：resolution 决策回执、显式候选与 next-step 指引。
- `src/service-review.ts`：GitHub / 本地审查编排、冻结规格与改后重审。
- `src/service-modification.ts`：修改阻塞项、验收标准与 WorkOrder 输入。
- `src/service-semantic-review.ts`：ReviewerRequest 铸造、有界审查文件与裁决绑定。
- `src/service-managed-work.ts`：托管施工全周期：Creator 预检、取消保留、modify/create 准备与 finish 收口。
- `src/semantic-host.ts`：semantic 子 Agent 的共享提交门禁与运行器；`DshSemanticReviewerHost` / `DshSemanticVerifierHost` 分别在 `src/semantic-reviewer.ts` / `src/semantic-verifier.ts`。它们不是安装完成的可信门槛。
- `src/creation-guard.ts`：Host 用户回合、session/boot/interrupt 绑定与新建拒绝。
- `src/creator-foundation.ts`：Creator 预检、结构化 WorkOrder、运行期 composition/catalog 验证与有界 receipt。
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

**审查与发现：**

- `src/review/review.ts`：exact snapshot、manifest/fit/security 派生事实。
- `src/resolver/local.ts`：本地工具、技能和 tool-search 桥。
- `src/discovery/remote.ts`：Host 侧 scoped GitHub 发现、候选归一化和来源记录；不回退无 topic 搜索。Agent 未提供查询且无待澄清时，可从权威需求派生互补兜底短语，但不改写 Agent 已给短语。
- `src/github/discovery.ts`：严格 `owner/repository` 标识校验，以及 `topic:dsh-plugin` 的 `gh api` 搜索。
