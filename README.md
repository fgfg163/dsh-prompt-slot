# @fgfg163/dsh-prompt-slot

English | [简体中文](README_ZH.md)

A shared **per-turn injection slot** for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH): other plugins write into the slot, the content can change every turn, and it **does not invalidate the provider prefix cache**.

This is the DSH counterpart of OpenClaw's `before_prompt_build` hook. The underlying model differs, so the implementation differs too.

> Renamed from `dsh-prompt-inject` on 2026-11-15 and namespaced with the author for npm. The service name `ctx.promptInject` is unchanged — it is the API other plugins inject on.

## Why not just use the existing APIs

DSH has four places that can put text into model-visible history, and their cache cost differs by an order of magnitude:

| Where | API | What it lands as | Cache cost |
|---|---|---|---|
| System prompt section | `ctx.systemPrompt.section()` | Rewrites surface system node 0 | **Everything from the first changed token is lost** |
| Dynamic runtime facts | `ctx.systemPrompt.context()` | One user snapshot, **replaced in place** | **Lost from the replacement point** (often mid-history) |
| pre-step append | `agent/pre-step` → `decision.messages` | Appends one user/message | **Nothing lost**, pure append |
| After a tool | `post-execute` `additionalContexts` | Appended after the tool result | Nothing lost |

`dsh-time-context`, the agentmemory capture plugin and `dsh-repeat-tool-reminder` all use the last two. The DSH README says it plainly: "append only; new visible content sits behind the reusable request prefix and does not invalidate existing KV cache entries."

**But those last two have no notion of a *position*.** Every plugin pushes into `decision.messages` on its own, the order depends on registration order, and there is no shared slot, no budget, no deduplication, and no way to hand a position to another plugin.

That gap is what this plugin fills.

## What it does

- Provides the `ctx.promptInject` service; any plugin can register a slot
- **Two channels**: `channel: 'pre-step'` appends to session history (the default); `channel: 'request'` only reaches the outbound provider request and is **never written to the log**
- On the first step of every turn, joins all registered slots into **one** user message
- Compares against a persisted session projection, so **the same content is not injected twice in a turn** (survives session restore)
- Hard budgets: a per-slot cap plus a total cap; overflow is evicted by priority
- Rendering has a timeout, a broken slot is skipped and logged, and **a turn can never be stalled by a slot**
- Never touches the system prompt, never touches the runtime-context snapshot

## The two channels

| channel | Lands as | Enters session history | Reconstructable from the log afterwards |
|---|---|---|---|
| `'pre-step'` (default) | `agent/pre-step` → `decision.messages` | Yes | Yes |
| `'request'` | The outbound request, rewritten inside `llm/stream` | **No** | **No** |

`'request'` is OpenClaw's `prependContext` semantics: the text is woven in ahead of this turn's user message and is visible only to that single model call.

**The cost must be stated plainly**: `dsh-llm/README.md` documents the invariant "Model-visible ⟺ logged" — anything the model sees must be reconstructable from the log. `'request'` deliberately breaks it. When debugging, remember the model saw text that `session.v4.jsonl` does not contain.

Implementation-wise there is a hard constraint: inside cordis's `waterfall`, `next()` is a closure bound to the original arguments, so you **cannot** call `next(newArgs)`. The only option is to not call `next` at all and re-enter `ctx.llm.stream(newRequest)` yourself, marking the new object in a `WeakSet` to prevent infinite recursion. The side effect is that `prepareCall()` binding is redone, costing one extra adapter pre-parse per step.

`llm/stream` also sees auxiliary calls such as title generation and compaction summaries. They all carry `options.purpose`, so they must be passed through with `if (options.purpose !== undefined) return next()`.

## Install

Put `dsh-prompt-slot/` into the profile's `node_modules`, then insert one row in
the profile's `cordis.patch.yml` (an absolute path is rewritten to `file://` by
the loader):

```yaml
- insert:
    - id: fgfg163-prompt-slot
      name: '@fgfg163/dsh-prompt-slot'
      config:
        position: before      # before | after
        totalMaxChars: 8000
```

It can also be installed as a bundle and listed in `package.json`'s
`dsh.profile.bundles`; this repository ships its own `cordis.patch.yml` for that
route.

### Configuration

| Key | Default | Meaning |
|---|---|---|
| `position` | `'before'` | Only affects the `'pre-step'` channel: `before` places the block ahead of this turn's user input (OpenClaw `prependContext` semantics); `after` appends it behind all existing messages |
| `totalMaxChars` | `8000` | Character ceiling for the joined body of one injection (counted separately per channel) |

The `runtime-context` snapshot is never displaced: with `before`, the slot lands ahead of the first **non**-runtime-context message, preserving the position the loop expects it in.

### Slot fields

| Key | Default | Meaning |
|---|---|---|
| `id` | required | Globally unique; a duplicate registration throws rather than silently shadowing |
| `render` | required | Returns a string; `null`/`undefined`/empty means "nothing this turn". May be async |
| `channel` | `'pre-step'` | `'pre-step'` writes history / `'request'` reaches the model only |
| `priority` | `100` | Lower sorts earlier |
| `when` | `'turn'` | `'turn'` = first step of each turn / `'step'` = every model step. The `'request'` channel currently renders only at `step === 1` |
| `maxChars` | `4000` | Per-slot cap; overflow is truncated with a visible marker |
| `timeoutMs` | `1500` | Render timeout; a slot that times out is skipped |

## Using it (how another plugin contributes)

```js
const name = 'my-plugin'
const inject = ['promptInject']   // depend on the slot service, wait for it

function apply(ctx) {
  ctx.effect(() => ctx.promptInject.register({
    id: 'my-plugin:status',        // globally unique; duplicates throw, never shadow
    channel: 'pre-step',           // 'pre-step' writes history | 'request' model only
    priority: 100,                 // lower sorts earlier
    maxChars: 1000,                // per-slot cap; overflow is truncated with a marker
    when: 'turn',                  // 'turn' first step / 'step' every model step
    timeoutMs: 800,                // render timeout; the slot is skipped on expiry
    render: ({ turn, step, agent, session, decision, signal }) => {
      return `stale jobs: 3`       // return a string; null/undefined/empty = nothing
    },
  }), 'my-plugin.register()')
}
```

`render` may be async. What it receives:

| Field | Meaning |
|---|---|
| `turn` / `step` | Current turn and step |
| `agent` / `session` | The agent and session objects |
| `decision` | The downstream pre-step decision (existing messages are readable) |
| `signal` | The turn's `AbortSignal`; do not render after it fires |

The service also exposes `unregister(id)`, `has(id)` and `list()`. `list()` returns descriptors in final injection order, with no functions inside, so it can be printed directly for diagnostics.

### A note on caching

Returning content that **changes every turn** is safe (pure append). Do not put large blocks of stable text in a slot — that belongs in `systemPrompt.section()`. The whole point of the slot is "the things that change".

## Testing

```powershell
# Unit tests (fake ctx, 34 cases)
node --test test\index.test.js

# Integration test against a real Cordis kernel
node test\integration.mjs
```

The unit tests cover: placement, the runtime-context snapshot never being displaced, an empty first step doing no work, rejection propagation, same-turn deduplication, re-injection across turns, `when` semantics, priority ordering, per-slot truncation, total-budget eviction order, throw/timeout isolation, duplicate-id rejection and unregister taking effect. The request channel additionally covers: not writing history, the insertion anchor, once-per-turn, auxiliary calls passing through, re-entry protection and per-slot failure isolation.

The integration test runs a real `@deepseek-ai/cordis` through `ctx.plugin()` + `ctx.effect()` + the `inject` gate + waterfall, confirming the service really mounts, the demo really contributes through the dependency gate, and the injected text really lands ahead of the user input.

## Known limits

- **The `'request'` channel breaks "the log is the request"**: injected content cannot be reconstructed from `session.v4.jsonl`. That is a deliberate trade-off, not a bug.
- **The `'request'` channel redoes `prepareCall()`**: `waterfall`'s `next()` cannot take new arguments, so the only option is re-entering `llm.stream()`, costing one extra adapter pre-parse per rewrite.
- **The `'request'` channel injects once per turn**, rendered at `step === 1` and consumed by that turn's first model call. Later steps in the same turn (tool continuations) do not see the block as fresh input, but it is already at the end of the turn's context, so the model can still read it.
- **It only acts on `agent/pre-step`**, with no post-tool injection. If you need "add a line after a tool finishes", use `post-execute`'s `additionalContexts`; this plugin does not cover that.
- **Deduplication is keyed on "turn + body"**: if the body changes within the same turn it is injected again, which is deliberate (different content is new information). Only the `'pre-step'` channel deduplicates; the `'request'` channel never lands on disk, so there is nothing to compare against.
- **Old injections are not compacted**: injected history messages are shadowed by compaction like any other message; the plugin does no extra cleanup.
- **`position: 'before'` assumes at least one non-runtime-context message this turn**; when there is none it injects nothing (an empty first step is treated by the loop as end-of-turn, and injecting would spin).
- **The `'request'` channel depends on the target message shape**: it looks for the last `role === 'user'` message that is not `runtime-context` as the insertion anchor, falling back to appending at the end.
- The plugin validates nothing beyond the return type of `slot.render`; content is the contributing plugin's responsibility.

## Relationship to OpenClaw

| OpenClaw | This plugin |
|---|---|
| `before_prompt_build` returning `prependContext` | `channel: 'request'` — placed ahead of this turn's user message, model-only, never logged |
| `<!-- OPENCLAW_CACHE_BOUNDARY -->` splitting stable/dynamic | DSH has no explicit boundary: stable content goes through `systemPrompt.section()`, dynamic content through this slot — a choice of API rather than a marker |
| One hook, one return value | Many plugins register many slots, merged into one message by priority |

## License

MIT
