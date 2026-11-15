# Changelog

All notable changes to `@fgfg163/dsh-prompt-slot` are recorded here.

Versioning is independent of DeepSeek Harness itself. The package targets the
Cordis plugin API exposed by any DSH release that provides
`sessionProjections`, `llm` and `agent/pre-step`.

## 0.1.0 — 2026-11-15

First public release. Published to the `@fgfg163` scope on npm.

This plugin existed before as a private package called `dsh-prompt-inject`
(versions 0.1.0 through 0.2.0, never published). Everything below is what the
public 0.1.0 contains; the private version numbers are not part of this
sequence.

### The slot

A shared per-turn injection slot over `agent/pre-step`: other plugins register
dynamic context, it reaches the model without invalidating the provider prefix
cache.

- Per-slot character budgets plus a total budget, evicting by priority
- Per-slot render timeouts; a broken or slow slot is skipped, never fatal
- A persisted session projection so the same body is not injected twice in a
  turn, including after a session restore
- Never touches the system prompt, never touches the runtime-context snapshot

### The two channels

- `channel: 'pre-step'` (default) appends to session history through
  `agent/pre-step` → `decision.messages`.
- `channel: 'request'` weaves the text into the outbound provider request inside
  `llm/stream` and never appends it to the session log. This is OpenClaw's
  `prependContext` shape. It deliberately breaks DSH's "Model-visible ⟺ logged"
  invariant: this text cannot be reconstructed from `session.v4.jsonl`.

Auxiliary LLM calls that declare `options.purpose` pass through untouched, and a
request already rewritten is tracked in a `WeakSet` so it is not rewritten again.

### Naming

- Package: `@fgfg163/dsh-prompt-slot` (private predecessor: `dsh-prompt-inject`)
- Loader row id: `fgfg163-prompt-slot`
- Module `name` / message `source.kind`: `fgfg163-prompt-slot`

The name mirrors OpenClaw's `before_prompt_build` hook, which is the behaviour
this plugin reproduces on DSH.

**The service name `ctx.promptInject` is deliberately unchanged.** It is an API
surface other plugins inject on (`ctx.promptInject.register(...)`), not a package
name, so renaming it would break consumers for no benefit.

If you used the private `dsh-prompt-inject` package:

- The loader row must move to `name: '@fgfg163/dsh-prompt-slot'` and
  `id: fgfg163-prompt-slot`.
- The load-time `name` is also the `source.kind` stamped on every message this
  plugin appends. Rows already written into old session logs still say
  `prompt-inject`; grep accordingly.
