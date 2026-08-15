# AutoEvo

English | [中文](README.md)

> Evolution continues.

<p align="center">
  <img src="docs/assets/persona.jpg" alt="AutoEvo" width="420">
</p>

Need a capability? Hunt an existing plugin, inspect it, load it, fire it. Upgrade what is almost enough. Writing from scratch is surrender.

`dsh-plugin-autoevo` is the deploy-and-upgrade rig inside DeepSeek Harness. It arms an Agent with community plugins: find, review, slam into a profile, then kit out the ones that are only halfway there.

Sonar hunts. The reactor feeds. Torpedoes deploy. ICBMs upgrade. The ammunition is work other people already shipped.

`Resolve → Search → Review → Deploy → Verify → Upgrade`

## Load

```powershell
dsh plugin --profile web add github:klarkxy/dsh-plugin-autoevo
```

Restart DSH. Bundles chamber only at process start.

From this checkout:

```powershell
pnpm install
pnpm build
pnpm exec dsh plugin --profile web add --save-exact "link:<absolute-path-to-this-repo>"
```

`link:` is for this trusted checkout only. Third-party plugins are packed into owned `file:...tgz` rounds.

## Arsenal

| Gear | Job | Trigger |
|---|---|---|
| `capability_resolve` | Inventory local arms, then hunt community ammo | read-only |
| `plugin_review` | Crack an exact commit and inspect | read-only |
| `plugin_install` | Deploy after approval, prove it with a live task | approval |
| `plugin_remove` | Extract one installation by receipt | approval |

The model only gets these four.

Deploy gate: `full + use`, risk `low` / `medium`, compatibility `compatible` / `unknown`, manifest must declare `dsh.bundle.patch`. Temporary trials run in an isolated home. A real `tool/call` plus a successful `tool/result` is the only proof that counts. `partial` gets patched, tested, re-reviewed, then kitted on.

## Fire

```powershell
npx @deepseek-ai/dsh@0.1.0-rc.6 web
```

Open http://127.0.0.1:3080, add a key, load AutoEvo in another terminal, restart, then throw this at her:

> I need a DSH plugin that can evaluate scientific notation. Find an existing one and install it.

She should draw `capability_resolve` first. GitHub hunting uses the `gh` login already on the machine.

## Baseline

`0.1.0` · DSH `0.1.0-rc.6` · Cordis `4.0.1` · Node.js `>=22.19.0 \|\| >=24`

```powershell
pnpm check
```

[Architecture](docs/architecture.md) · [Security](docs/security.md)

## License

SATA. See [LICENSE](./LICENSE).
