# Dynamic Cordis runtime rules

Choose the owner of the data and effect:

- Host: files, subprocesses, networking, Agents, durable Host lifecycle, and model Tools.
- Client: page layout, visible UI, local interaction, current page state, Slots, and theme.
- Both: Host obtains owned data and exposes a package-private JSON RPC; Client renders it.

Inspect the exact selected Service, Event, Builtin, Tool, or Slot contract before coding. Do not assume global `window`, `document`, `fetch`, timers, imports, JSX, TypeScript, or an undeclared service.

Dynamic code is a plain JavaScript function body returning a Cordis Plugin. Put effects inside `apply()`. Use `ctx.get(name)` for optional services. Declare `inject` only for hard dependencies and use the lifecycle API (`ctx.on`, `ctx.effect`, returned disposers) so stop/update removes every contribution.

For private Client-to-Host data, register a package-private Host handler and call it from Client through the confirmed host bridge. Arguments and returns must be lossless JSON; never expose Services, live context objects, React elements, or other runtime objects.

For an Event, inspect its listener signature and mode. A Waterfall listener calls and returns `next()` unless intentionally terminating the chain. For a model Tool, inspect the registered Tool schema first, avoid name conflicts, and verify a real call/result after activation.

Packages are immutable versions under a stable Plugin id. Use `run` for first activation or restarting a package, `update` to switch to a different package when a current package exists, and an explicit `run` of `currentPackageId` for rollback.
