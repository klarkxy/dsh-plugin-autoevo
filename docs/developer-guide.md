# AutoEvo 开发者指南

[English](developer-guide.en.md) | 中文 · [返回 README](../README.md)

本指南面向维护 AutoEvo、扩展 Host 接缝、修复工作流或验证安装语义的开发者。状态机与安全不变量分别以[架构说明](architecture.md)和[安全模型](security.md)为权威。

## 1. 本地环境

- Node.js `^22.19.0 || ^24.0.0`；CI 覆盖两个受支持的主版本。
- pnpm；CI 当前使用 `10.29.2`。
- Git；远端审查和 live GitHub discovery E2E 还需要 GitHub CLI。
- Host DSH CLI（打包验收与 E2E）不要加进仓库根依赖，否则 `npx @deepseek-ai/dsh` 会命中过期 CLI。CI 在 runner 临时目录安装验收基线 `@deepseek-ai/dsh@0.1.1-rc.2`（Cordis `4.0.1`）并通过 `DSH_PACKAGE_ROOT` 指向它；本地可用 `>=0.1.0-rc.6 <0.2.0` 范围内的 DSH，发版证据须注明实际版本。
- Windows / PowerShell 是完整支持与主要实测环境。Linux/macOS 只承诺 build/import smoke；核心流程使用 argv runner，不能依赖交互式 shell 副作用。

初始化并运行日常验收：

```powershell
pnpm install --frozen-lockfile
pnpm check
```

常用门：

| 命令 | 覆盖范围 | 何时使用 |
| --- | --- | --- |
| `pnpm lint` | flat 配置 `eslint.config.mjs`，`eslint src tests` | 快速语法/规范检查 |
| `pnpm typecheck` | `tsc --noEmit` | 公共类型或合同变化 |
| `pnpm test` | 全部 Vitest 单元与集成测试 | 逻辑变更 |
| `pnpm build` | 用 tsdown 重建 `lib/` | 源码或导出变化 |
| `pnpm check:fast` | lint、typecheck、Vitest、build | 提交前快速反馈门 |
| `pnpm test:acceptance` | Loader smoke、打包验收、local/adversarial offline E2E | 集中的 DSH 运行时验收 |
| `pnpm check` | `check:fast` 加 `test:acceptance` | 日常完整合入门 |
| `pnpm check:release` | `check` 加 live marketplace E2E 和 pack dry-run | 发布候选 |
| `pnpm pack:dry-run` | 检查发布包内容 | 文档、exports 或 files 变化 |

live E2E 会访问外部 GitHub，缺少网络或认证时不应冒充离线通过。

## 2. 文档职责

| 文档 | 唯一职责 | 需要更新的触发条件 |
| --- | --- | --- |
| [README](../README.md) | 价值、安装、快速体验、状态边界和导航 | 版本、安装命令、最低基线或入口变化 |
| [使用指南](user-guide.md) | 用户可观察流程、选择、状态、恢复和卸载 | UI/行为、用户动作或结果语义变化 |
| 本指南 | 本地开发、代码入口、测试、调试、贡献 | 脚本、目录、开发/发布流程变化 |
| [架构说明](architecture.md) | 状态机、数据布局、运行时接缝 | 合同、存储或注入关系变化 |
| [安全模型](security.md) | 信任边界、安装门槛、验证与删除不变量 | 权限、审查、验证、清理边界变化 |

不要把完整流程复制到多个文件；其它文档只保留一句摘要和链接。

交互流程图在 `docs/assets/flowcharts/`，并随发布包提供：流程变化时，编辑同目录的 `*.workflow.json` / `*.lifecycle.json` 规格（英文版为 `-en` 后缀同名文件），用 archify 重新 `deliver` 生成 HTML，再在浏览器打开 HTML 用 Export → SVG 覆盖同名 `.svg`。不要直接手改 HTML 或 SVG。

## 3. 仓库结构

```text
src/
├─ index.ts                    # Cordis/DSH 入口与服务装配
├─ config.ts                   # 公开配置 schema 与默认值
├─ contracts.ts                # Policy V13 公共合同、review/install receipts
├─ service.ts                  # CapabilityEvolutionService 装配；实现拆分为下列 service-*.ts
├─ service-resolution.ts       # 解析、候选池进出与授权流转
├─ service-review.ts           # 审查编排与重验证
├─ service-modification.ts     # 修改 blocker 与 WorkOrder 派生
├─ service-semantic-review.ts  # 独立 semantic reviewer 编排
├─ service-managed-work.ts     # 托管 create/modify 执行与 receipt
├─ semantic-host.ts            # semantic 会话 Host 装配与输入校验
├─ internal-utils.ts           # 共享小工具（类型守卫、路径 containment 等）
├─ workflow/                   # 图引擎、生命周期映射、Agent 展示协议
├─ resolver/                   # 本地/已装来源、intent、lineage 与 profile ownership
├─ discovery/                  # scoped GitHub 发现与归一化
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
tests/helpers/                 # 共享测试夹具（临时目录、运行时配置、记录构造）
tests/*.mjs                    # Loader、打包和 E2E acceptance
lib/                           # tsdown 生成且提交/发布的运行产物
```

`src/workflow/engine.ts` 是薄 façade；引擎实现按继承链拆分为 `engine-core.ts`、`engine-driver.ts`、`engine-recovery.ts`、`engine-resume.ts`，候选快照在 `candidates.ts`，selection receipt / commitment / lease 铸造在 `grants.ts`。

`lib/` 是生成目录，但仓库会跟踪并发布它。不要直接编辑 `lib/`；修改 `src/` 后运行 `pnpm build`，并把生成差异一起审查。

## 4. 运行时入口

包是 ESM。默认入口 `lib/index.js`（源码 `src/index.ts`）；子路径导出 `./evolution-mode`、`./verification-observer`；`cordis.patch.yml` 以 `id: autoevo` 挂载 bundle，并传入 `dshHome` / `stateDir`。

`apply()` 负责：

1. 规范化 `Config`；
2. 建立 `StateStore`、runner、`CreationGuard`、`ExecutionGuard` 与 `CapabilityEvolutionService`；
3. 安全物化 `presets/evolution`；
4. 注入固定复用策略和工具执行 hooks；
5. 注册 `capability_workflow*`、`capability_versions` / `capability_rollback` / `capability_adopt` / `capability_updates` 与 `plugin_remove`。

提示词与 preset 是行为指导，不是权限边界。AutoEvo 的 receipts、fresh-turn 绑定与 execution guard 只负责工作流一致性和证据；DSH Core 才实际执行权限、sandbox 和 `allowed-once` approval。不要把 AutoEvo warning、receipt 或 status 当作 DSH 授权，也不要把 warning 当成硬阻断。

## 5. 工作流与两道确认门

当前 Policy 为 V13。状态机、两道确认门与生命周期映射以[架构说明 §4](architecture.md#4-数据与状态) 为准；这里只列改动工作流时容易踩的边界：

- 内部 graph cursor 与公开 `lifecycleState` 不应混用。模型只看到版本化的 `AgentWorkflowViewV2`；永远不要接受模型自报的 repository、review ID、路径或 install spec，`use_this` / `modify_this` 只绑定密封候选快照中的候选 ID。
- 同回合重复 resume 不获得新授权；防重放失败不会消费当前合法 interrupt。
- DSH `allowed-once` approval 只批准一次副作用，不能替代两道确认门。
- 旧 Policy 的未完成记录（selection、review、commitment、lease）不跨版本恢复；Host fail closed 并要求重新发现。

## 6. Resolver 与来源 lineage

解析顺序是本地优先：当前 Agent 可见工具、技能、桥接能力，再到 Host 侧 `topic:dsh-plugin` GitHub 搜索。远端摘要始终是不可信数据；Host 只做严格 GitHub 仓库标识、客观状态、有界摘要和去重，完整有界结果由 Agent 判断语义相关性。精确仓库置顶；只有 Agent 密封的 1–5 项读取受限预览。

已安装来源必须由 live profile ownership 解析，不能仅凭本地 inventory 推断。replacement 只适用于：

- `github_exact`：profile 中真实依赖精确 GitHub SHA；
- `owned_chain`：AutoEvo installation receipt 能证明当前安装链。

历史 `failed_install` / `reviewed_snapshot` 若状态为 `not_installed` 或 `removed`，经完整重验证、重新认领、重审与冻结后按首次安装处理，不能放宽 `assertReplacementBinding()` 的 live-spec 漂移保护。

`src/resolver/lineage.ts` 与 `SourceManager.validateCompletedSnapshot()` 共同防止任意本地 review 冒充托管来源：receipt、路径、仓库、base commit、review ID、artifact hash、干净 HEAD/branch、Git config/hooks 与 workspace containment 都必须匹配。

## 7. 托管源码生命周期

[![AutoEvo 托管施工流程](assets/flowcharts/autoevo-managed-work.svg)](assets/flowcharts/autoevo-managed-work.html)

默认源码根是 `<workspace>/.autoevo/sources/`。父会话掌握决定与进度，实际施工在 Host-owned、cwd 精确绑定的短生命周期子会话中进行：

1. Host 克隆 exact GitHub commit 或创建脚手架；
2. 写入 sidecar source receipt 并取得 workflow 排他锁；
3. `prepareModify()` / `prepareCreate()` 设置 `pendingPath` 与结构化 WorkOrder；
4. Host 创建子会话，验证不可变 cwd、`workspace-write` 根、父子归属、系统级 Creator preset 和越界探针；
5. 子会话只在托管目录内编辑并运行有界构建/测试，完成结果回到 Host；
6. Host 验证 branch/HEAD、工作树、Git config/hooks；
7. Host 禁用 hooks 与签名创建本地 commit；
8. 重新审查、冻结完整快照并生成 owned tgz；
9. 释放锁或进入安装。

父会话不会把合成 cwd 当作安全边界，也不会直接施工；真正的写入根来自子会话的不可变 cwd。子会话完成或失败后立即释放，决定、重审、安装和发布权限始终留在 Host/父流程。

取消或异常不会复用已取消 signal 做清理。Host 以独立 bounded lifetime checkpoint 有界编辑、验证状态并释放锁；不能把 cancel/timeout 误报成 Git 可执行文件缺失。

## 8. 数据与配置

调试时最常用到的路径：

- `<workspace>/.autoevo/sources/<source-id>/`：托管源码工作树；
- `<dshHome>/autoevo/`：Host receipts（`resolutions/`、`reviews/`、`workflows/`、`installations/`、`source-control/`）与 `artifacts/`、`trials/`、`verifications/`。

完整布局以[架构说明 §4](architecture.md#4-数据与状态) 为准。`StateStore` 用同目录临时文件加原子 rename 写 receipt。任何 profile 变更前先持久化 provisional installation；最终写回失败时必须保留可恢复锚点或补偿清理，不能谎报未安装。

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

安装器的关键顺序（完整实现见 `src/lifecycle/install.ts`）：

1. 验证最新 review、selection receipt、commitment/lease 与 target profile；物化 owned snapshot/tgz 并复核路径、size、hash；
2. 取得 DSH `allowed-once` approval 后写 provisional receipt，通过 DSH 的正常安装路径修改目标 profile，并对账 exact dependency 与可见 package target；
3. 执行 Host 验证与目标进程热加载，写最终 receipt；失败进入 `failed_absent` / `recovery_required`。

三层验证不能互换：

| Layer | 成功 outcome | 可以宣称 |
| --- | --- | --- |
| `tool_roundtrip` | `verified` | Host 执行了所有预期工具并成功返回 |
| `bundle_activation` | `activated` | 审查 bundle 的 Loader/Fiber 已收口 |
| persistent `manual_runtime` | `awaiting_user_test` | 已安装，等待真实客户端测试 |

`loaded` 只表示目标进程 bundle 已加载。AutoEvo 不用私有预检代替 live profile 证据；semantic verifier 与 `taskResultMatchedExpectation` 都不能把结果升级为 `verified`。

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
| 发布包真实入口与隔离 | `tests/packaged-acceptance.mjs`（验证文档/运行资源，并拒绝测试、snapshot、debug 与本地状态残留） |
| 本地/对抗/市场 E2E | `tests/e2e-runner.mjs` |
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

| 步骤 | 检查内容 |
| --- | --- |
| 1 | workflow `status`、cursor、当前 interrupt 与 failure |
| 2 | review 的 exact source、Policy、fit、risk、compatibility 与 installSpec |
| 3 | installation 的 `installState`、`installOutcome`、verification layer、`loaded`、`verified`、`restartRequired` |
| 4 | source receipt 的 review/artifact hash、activeWorkflowId 与 Git 状态 |
| 5 | live profile dependency spec 和 Loader 可见 target |
| 6 | 最后才检查模型是否错误解释用户决定 |

HTTP 200 只证明 Web 服务可访问，不能证明目标插件功能可用；真实功能证据需要看到目标工具 call/result。

`dsh --profile web --help` 等命令可能进入 profile 准备流程并写文件，不能默认当成纯只读诊断。

## 12. 贡献与发布

提交前：

1. 保留现有用户改动，明确本次 owned paths；
2. 运行与变更范围相称的测试；
3. 源码变化后重建并审查 `lib/`；
4. 更新对应的用户、开发、架构、安全或样例文档；
5. 检查 diff 中的凭据、本机路径、账号、私有地址和专有逻辑；
6. `git diff --check`，确认工作树中未混入临时 artifact；
7. 发布时同步 README.md / README.en.md / user-guide.md / user-guide.en.md 安装命令中的发布 tag（`documentation.spec.ts` 会校验一致性）；
8. 发布候选运行 `pnpm check:release` 与 pack 内容检查。

仓库 CI 负责验收，不自动创建 release。发行仅通过 GitHub；commit、push、tag、GitHub release 或上游 PR 都是独立动作，需要维护者明确授权，且 CI 不会发布到 npm。installation receipt 中的 `contributionAdvice.eligible` 只表示可以建议贡献，不是发布授权。

## 参考入口

- [架构说明](architecture.md)
- [安全模型](security.md)
- [使用指南](user-guide.md)
- `src/index.ts`
- `src/contracts.ts`
- `src/workflow/engine-core.ts` 及 `engine-driver.ts` / `engine-recovery.ts` / `engine-resume.ts`（`engine.ts` 为薄 façade）
- `src/lifecycle/install.ts`
- `src/source-manager.ts`
