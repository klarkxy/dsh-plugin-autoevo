# AutoEvo 开发者指南

[English](developer-guide.en.md) | 中文 · [返回 README](../README.md)

本指南面向维护 AutoEvo、扩展其 Host 接缝、修复工作流或验证安装语义的开发者。它记录开发流程和源码入口；Policy 状态机与安全不变量仍分别以[架构说明](architecture.md)和[安全模型](security.md)为权威。

## 1. 本地环境

要求：

- Node.js `>=22.19.0 || >=24.0.0`；CI 使用 Node 24。
- pnpm；CI 当前使用 `10.29.2`。
- Git；远端审查和 live marketplace E2E 还需要可用的 GitHub CLI。
- Windows / PowerShell 是主要实测环境，但核心流程使用 argv runner，不能依赖交互式 shell 副作用。

初始化并运行日常验收：

```powershell
pnpm install --frozen-lockfile
pnpm check
```

常用门：

| 命令 | 覆盖范围 | 何时使用 |
| --- | --- | --- |
| `pnpm lint` | `src/`、`tests/` TypeScript lint | 快速语法/规范检查 |
| `pnpm typecheck` | `tsc --noEmit` | 公共类型或合同变化 |
| `pnpm test` | 全部 Vitest 单元与集成测试 | 逻辑变更 |
| `pnpm build` | 用 tsdown 重建 `lib/` | 源码或导出变化 |
| `pnpm check:fast` | lint、typecheck、Vitest、build、Loader smoke、打包验收 | 提交前快速完整门 |
| `pnpm check` | `check:fast` 加 local/adversarial offline E2E | 日常合入门 |
| `pnpm check:release` | `check` 加 live marketplace E2E 和 pack dry-run | 发布候选 |
| `pnpm pack:dry-run` | 检查发布包内容 | 文档、exports 或 files 变化 |

live E2E 会访问外部市场或 GitHub，不应在缺少网络/认证时冒充离线通过。

## 2. 文档职责

| 文档 | 唯一职责 | 需要更新的触发条件 |
| --- | --- | --- |
| [README](../README.md) | 价值、安装、一次快速体验、状态边界和导航 | 版本、安装命令、最低基线或入口变化 |
| [使用指南](user-guide.md) | 用户可观察流程、选择、状态、恢复和卸载 | UI/行为、用户动作或结果语义变化 |
| 本指南 | 本地开发、代码入口、测试、调试、贡献 | 脚本、目录、开发/发布流程变化 |
| [架构说明](architecture.md) | Policy、状态机、数据布局、运行时接缝 | 合同、图、存储或注入关系变化 |
| [安全模型](security.md) | 信任边界、安装门槛、验证与删除不变量 | 权限、审查、验证、清理边界变化 |
| [真实样例](real-world-samples.md) | 夹具、证据等级与清理责任 | 样例或权威证据变化 |

不要复制完整流程到多个文件。其它文档只保留一句摘要和链接；样例的 `real-live-passed` / `implemented` / `planned` 标签不得改写成一般产品保证。

## 3. 仓库结构

```text
src/
├─ index.ts                    # Cordis/DSH 入口与服务装配
├─ config.ts                   # 公开配置 schema 与默认值
├─ contracts.ts                # Policy V8 公共合同、review/install receipts
├─ workflow/                   # 图引擎、生命周期映射、Agent 展示协议
├─ resolver/                   # 本地/已装来源、intent、lineage 与 profile ownership
├─ discovery/                  # find_dsh_plugin 发现与归一化
├─ review/                     # exact snapshot 与机械审查事实
├─ lifecycle/                  # install/snapshot/launcher/remove/recovery
├─ source-manager.ts           # 托管 Git 源、锁、commit 与 source receipt
├─ creation-guard.ts           # 新鲜用户回合、session/boot/interrupt 绑定
├─ execution-guard.ts          # 工具执行层授权边界
└─ host-verification-driver.ts # 三层 Host 验证选择与执行

presets/evolution/             # 托管的「能力进化」用户 preset
skills/autoevo-plugin-creator/ # 随包的 Agent 指导与参考，不是授权边界
tests/unit/                    # 合同、状态与 fail-closed 回归
tests/integration/             # 托管 create/modify/evolve 闭环
tests/*.mjs                    # Loader、打包和 E2E acceptance
lib/                           # tsdown 生成且提交/发布的运行产物
```

`lib/` 是生成目录，但当前仓库会跟踪并发布它。不要直接编辑 `lib/`；修改 `src/` 后运行 `pnpm build`，并把对应生成差异一起审查。

## 4. 运行时入口

包是 ESM：

- 默认入口：`lib/index.js`；源码为 `src/index.ts`。
- 子路径导出：`./evolution-mode`、`./verification-observer`。
- `cordis.patch.yml` 以 `id: autoevo` 挂载 bundle，并传入 `dshHome` / `stateDir`。

`apply()` 负责：

1. 规范化 `Config`；
2. 建立 `StateStore`、runner、`CreationGuard`、`ExecutionGuard` 与 `CapabilityEvolutionService`；
3. 安全物化 `presets/evolution`；
4. 注入固定复用策略和工具执行 hooks；
5. 注册 `capability_workflow*` 与 `plugin_remove`。

提示词与 preset 是行为指导，不是权限边界。真实授权由 workflow receipts、fresh-turn guard、execution guard、ActionCommitment、ExecutionLease 和 DSH `allowed-once` approval 共同约束。

## 5. 工作流与两道确认门

Policy 当前为 V8。旧 Policy 的 selection、review、commitment 或 lease 不会跨版本复用；Host fail closed 并要求重新发现。

```text
bootstrap / resolve
  ↓
model-controlled discovery pool
  ↓ capability_workflow_refine (有界、可选)
  ↓ capability_workflow_present (密封 1–5 个候选)
Gate 1: fresh user selection
  ↓
exact source review
  ↓
Gate 2: fresh structured decision
  ↓
commitment / lease / one-time DSH approval
  ↓
reuse | install | managed modify/create | stop
  ↓
Host verification / recovery / receipt
```

内部 graph cursor 与公开 `lifecycleState` 不应混用。模型只看到版本化的 `AgentWorkflowViewV2`：有界事实、预算、候选作用域动作和合法工具；不能看到可伪造的 repository、review ID 或 install spec 控制面。

关键边界：

- Gate 1 选择只能来自 `capability_workflow_present` 密封的候选快照。
- Gate 2 的最终决定必须来自审查之后的新鲜真实用户回合。
- `use_this` / `modify_this` 绑定当前候选 ID；模型不能自报 review 或路径。
- DSH approval 只授权一次副作用，不能替代 Gate 1/2。
- 同回合重复 resume 不获得新授权；防重放失败不会消费当前合法 interrupt。

## 6. Resolver 与来源 lineage

解析顺序是本地优先：当前 Agent 可见工具、技能、桥接能力，再到 `find_dsh_plugin`。远端 finder 返回的文本始终是不可信数据；Host 只接受严格 GitHub 仓库标识和有界摘要。

已安装来源必须由 live profile ownership 解析，不能仅凭本地 inventory 推断。replacement 只适用于：

- `github_exact`：profile 中真实依赖精确 GitHub SHA；
- `owned_chain`：AutoEvo installation receipt 能证明当前安装链。

历史 `failed_install` / `reviewed_snapshot` 若状态为 `not_installed` 或 `removed`，经完整 revalidation、重新认领、重审与冻结后按首次安装处理，不能放宽 `assertReplacementBinding()` 的 live-spec 漂移保护。

`src/resolver/lineage.ts` 与 `SourceManager.validateCompletedSnapshot()` 共同防止任意本地 review 冒充托管来源：receipt、路径、仓库、base commit、review ID、artifact hash、干净 HEAD/branch、Git config/hooks 与 workspace containment 都必须匹配。

## 7. 托管源码生命周期

默认源码根是 `<workspace>/.autoevo/sources/`。当前实现采用父会话可见施工：

1. Host 克隆 exact GitHub commit 或创建脚手架；
2. 写入 sidecar source receipt 并取得 workflow 排他锁；
3. `prepareModify()` / `prepareCreate()` 设置 `pendingPath` 与结构化 WorkOrder；
4. 当前能力进化会话只在托管目录内编辑、运行检查；
5. `finish_managed_work` 后，Host 验证 branch/HEAD、工作树、Git config/hooks；
6. Host 禁用 hooks 与签名创建本地 commit；
7. 重新审查、冻结完整快照并生成 owned tgz；
8. 释放锁或进入安装。

运行时不会创建子 Agent。`src/managed-child.ts` 仅保留历史兼容接口，其 `run()` 会明确拒绝旧路径；不要把它当成扩展 API。

取消或异常不会复用已取消 signal 做清理。Host 以独立 bounded lifetime checkpoint 有界编辑、验证状态并释放锁；不能把 cancel/timeout 误报成 Git 可执行文件缺失。

## 8. 数据与配置

默认布局：

```text
<workspace>/.autoevo/
└─ sources/<source-id>/

<dshHome>/autoevo/
├─ resolutions/
├─ reviews/
├─ workflows/
├─ installations/
├─ source-control/
├─ artifacts/
├─ trials/
└─ verifications/
```

`StateStore` 用同目录临时文件加原子 rename 写 receipt。任何 profile 变更前先持久化 provisional installation；最终写回失败时必须保留可恢复锚点或补偿清理，不能谎报未安装。

### `Config`

| 字段 | 默认值 / 作用 |
| --- | --- |
| `dshHome` | `DSH_HOME` 或当前目录 `.dsh` |
| `stateDir` | `<dshHome>/autoevo`；Host receipts 与 artifacts |
| `sourceDir` | 未设置时为当前 workspace `.autoevo/sources` |
| `ghCommand` / `gitCommand` / `dshCommand` | 对应可执行文件名 |
| `dshCommandArgs` | 传给 DSH 的固定前置参数 |
| `maxCandidates` | 1–20，默认 20 |
| `maxFiles` | 4–200，默认 80 |
| `maxRepositoryBytes` | 64 KiB–8 MiB，默认 1 MiB |
| `commandTimeoutMs` | 1–300 秒，默认 30 秒 |
| `forwardedCredentialEnv` | 允许转发的凭据环境变量名，不保存值 |
| `verificationPatchPaths` | 额外验证 patch 的绝对路径列表 |
| `evolutionPreset` | 默认 `true`；`false` 只跳过物化，不自动删除 |

配置边界变化必须同步 `src/config.ts`、公开类型、schema 测试和本指南。

## 9. 审查、安装与验证

审查 receipt 绑定 Policy、需求、精确来源、已检查文件 hash、manifest facts、实际 DSH runtime 与兼容性。安装前重新审查并比较材料。

安装器的关键顺序：

1. 验证最新 review、selection receipt、commitment/lease 和 target profile；
2. 物化 owned snapshot/tgz，并再次比较路径、size、hash；
3. 取得 DSH `allowed-once` approval；
4. 写 provisional installation receipt；
5. 对 persistent 安装执行 exact reviewed bundle 的隔离 headless 预检；
6. 修改 profile，并对账 exact dependency 与可见 package target；
7. 执行 Host 验证与目标进程热加载；
8. 写最终 receipt，或进入 `failed_absent` / `recovery_required`。

三层验证不能互换：

| Layer | 成功 outcome | 可以宣称 |
| --- | --- | --- |
| `tool_roundtrip` | `verified` | Host 执行了所有预期工具并成功返回 |
| `bundle_activation` | `activated` | 审查 bundle 的 Loader/Fiber 已收口 |
| persistent `manual_runtime` | `awaiting_user_test` | 已安装，等待真实客户端测试 |

`loaded` 只表示目标进程 bundle 已加载；headless preflight 单独记录，不能证明 live profile。semantic verifier 与 `taskResultMatchedExpectation` 都不能把结果升级为 `verified`。

## 10. 测试矩阵

| 领域 | 主要测试 |
| --- | --- |
| 两道门、新鲜回合、防重放 | `tests/unit/confirmation-gates.spec.ts`、`workflow-engine.spec.ts` |
| 执行层拒绝与父会话范围 | `creation-guard.spec.ts`、`execution-boundaries.spec.ts` |
| 来源 ownership 与 lineage | `lineage.spec.ts`、`profile-resolver.spec.ts`、`source-manager.spec.ts` |
| 安装、替换、对账与恢复 | `install-outcomes.spec.ts` |
| 三层 Host 验证 | `host-verification-driver.spec.ts`、`workflow-lifecycle.spec.ts` |
| 托管创建/修改/升级 | `tests/integration/managed-*.spec.ts` |
| Cordis 加载 | `tests/loader-smoke.mjs` |
| 发布包真实入口 | `tests/packaged-acceptance.mjs` |
| 本地与对抗 E2E | `tests/e2e-runner.mjs` |
| 文档导航与关键语义 | `tests/unit/documentation.spec.ts` |

修复回归时先跑最窄测试，再跑 `pnpm check:fast`；涉及工作流、profile、打包或 Loader 时至少跑 `pnpm check`。发布候选跑 `pnpm check:release`。

## 11. 调试真实 DSH 问题

优先读取持久事实，不要只根据模型总结猜测：

```text
<dshHome>/autoevo/workflows/
<dshHome>/autoevo/reviews/
<dshHome>/autoevo/installations/
<dshHome>/autoevo/source-control/
<dshHome>/profiles/<profile>/package.json
```

检查顺序：

1. workflow `status`、cursor、当前 interrupt 与 failure；
2. review 的 exact source、Policy、fit、risk、compatibility 与 installSpec；
3. installation 的 `installState`、`installOutcome`、verification layer、`loaded`、`verified`、`restartRequired`；
4. source receipt 的 review/artifact hash、activeWorkflowId 与 Git 状态；
5. live profile dependency spec 和 Loader 可见 target；
6. 最后才检查模型是否错误解释用户决定。

HTTP 200 只证明 Web 服务可访问；它不能证明 AutoEvo 工具已加载，更不能证明目标插件功能可用。真实功能证据需要看到目标工具 call/result。

`dsh --profile web --help` 等命令可能进入 profile 准备流程并写文件，不能默认当成纯只读诊断。

## 12. 贡献与发布

提交前：

1. 保留现有用户改动，明确本次 owned paths；
2. 运行与变更范围相称的测试；
3. 源码变化后重建并审查 `lib/`；
4. 更新对应的用户、开发、架构、安全或样例文档；
5. 检查 diff 中的凭据、本机路径、账号、私有地址和专有逻辑；
6. `git diff --check`，确认工作树中未混入临时 artifact；
7. 发布候选运行 `pnpm check:release` 与 pack 内容检查。

仓库 CI 负责验收，不自动创建 release。commit、push、tag、发布或上游 PR 都是独立动作，需要维护者明确授权。AutoEvo installation receipt 中的 `contributionAdvice.eligible` 只表示可以建议贡献，不是发布授权。

## 参考入口

- [架构说明](architecture.md)
- [安全模型](security.md)
- [使用指南](user-guide.md)
- [真实样例目录](real-world-samples.md)
- `src/index.ts`
- `src/contracts.ts`
- `src/workflow/engine.ts`
- `src/lifecycle/install.ts`
- `src/source-manager.ts`
