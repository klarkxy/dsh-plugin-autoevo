# AutoEvo

[English](README.en.md) | 中文

> 进化永不停歇。

<p align="center">
  <img src="docs/assets/persona.jpg" alt="AutoEvo" width="420">
</p>

缺能力？搜现成的，审过就装，装上就打。能升级就升级，从零写是认输。

`dsh-plugin-autoevo` 是 DeepSeek Harness 里的部署与升级武装：给 Agent 找插件、验插件、打进 profile、再给半成品加装。

声呐搜货，核堆供能，鱼雷部署，洲际导弹升级。弹药是社区已经写好的能力。

`Resolve → Search → Review → Deploy → Verify → Upgrade`

## 上膛

```powershell
dsh plugin --profile web add github:klarkxy/dsh-plugin-autoevo
```

装完重启 DSH。bundle 只在进程启动时进膛。

本仓库当弹药库：

```powershell
pnpm install
pnpm build
pnpm exec dsh plugin --profile web add --save-exact "link:<absolute-path-to-this-repo>"
```

`link:` 只认这份可信 checkout。别人的插件一律打成 owned `file:...tgz` 再上架。

## 武装

| 装备 | 干什么 | 开火条件 |
|---|---|---|
| `capability_resolve` | 先翻本地武装，再搜社区弹药 | 只读 |
| `plugin_review` | 拆开 exact commit 验货 | 只读 |
| `plugin_install` | 批准后部署，跑真实任务验膛 | 需批准 |
| `plugin_remove` | 按 receipt 精确拆弹 | 需批准 |

模型只摸得到这四件。

部署门槛：`full + use`，风险 `low` / `medium`，兼容 `compatible` / `unknown`，manifest 必须有 `dsh.bundle.patch`。临时试用进隔离 home，看到真实 `tool/call` 和成功 `tool/result` 才算打响。`partial` 先改、先测、再重审，然后加装。

## 开打

```powershell
npx @deepseek-ai/dsh@0.1.0-rc.6 web
```

http://127.0.0.1:3080 填 Key，另开终端上膛，重启，然后丢给她：

> 我需要能算科学计数法的 DSH 插件。先搜现成的，有就装。

她该先拔 `capability_resolve`。GitHub 搜货走本机已登录的 `gh`。

## 基线

`0.1.0` · DSH `0.1.0-rc.6` · Cordis `4.0.1` · Node.js `>=22.19.0 \|\| >=24`

```powershell
pnpm check
```

[架构](docs/architecture.md) · [安全](docs/security.md)

## 许可

SATA，见 [LICENSE](./LICENSE)。
