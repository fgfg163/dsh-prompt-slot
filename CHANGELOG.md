# Changelog

All notable changes to `@fgfg163/dsh-prompt-slot` are recorded here.
每个版本先英文后中文。

---

# 0.2.0

## English

**Added**

- **Settings page.** The bundle now declares a `Config` schema and ships a
  browser half (`lib/client.js`) that registers a `settings.section` tab:
  Settings → 提示注入槽. Both fields (`position`, `totalMaxChars`) are
  declared `.volatile()`, so a save takes effect on the next turn without
  restarting the plugin.
- A live-form save writes through the Host `settings` service into the
  profile patch; undeclared fields in the row are preserved.

**Changed**

- `apply` reads both config fields through live getters. A real cordis host
  resolves the declared schema and hands volatile references to `apply`;
  hand-written plain values keep working (fail-fast validation on mount).

**Fixed**

- **The settings tab never appeared.** The browser half ran before
  `ui-settings` registered `configForms`, and the guarded client context
  rejects `ctx.slots` without an `inject` declaration, so the tab was dropped
  silently. It now declares `inject: ['slots']`, polls
  `ctx.get('configForms')`, and accepts both loader-row id spellings.
- **The settings page was unstyled.** It rendered native controls with inline
  styles and referenced a token that does not exist. It now follows the
  Harness settings rows (`--dsw-alias-*` tokens, 14px/12px type, 36px controls,
  row separators) so it matches the shipped sections in light and dark themes.

## 中文

**新增**

- **配置页。** 声明 `Config` schema 并内置浏览器半边（`lib/client.js`），在
  设置 → 提示注入槽 注册独立页。两个字段（`position`、`totalMaxChars`）均声明
  为 `.volatile()`，保存后下一轮即生效，无需重启插件。
- 表单保存经宿主 settings 服务写入 profile patch；行内未声明的字段原样保留。

**变更**

- `apply` 改为经 live getter 读取两个字段。真实 cordis 宿主会解析 schema 并把
  volatile 引用交给 `apply`；手写普通值依旧可用（挂载时快速失败校验）。

**修复**

- **配置页不显示。** 浏览器半边在 `ui-settings` 注册 `configForms` 之前执行，
  且受保护的客户端 ctx 在未声明 `inject` 时拒绝访问 `ctx.slots`，页面被静默丢弃。
  现声明 `inject: ['slots']`、轮询 `ctx.get('configForms')`，并兼容两种行 id 拼写。
- **配置页没有样式。** 之前是原生控件加内联样式，还引用了一个不存在的 token。
  现改为宿主设置行布局（`--dsw-alias-*` token、14px/12px 字号、36px 控件、
  行分隔线），明暗主题都与内置分页一致。

---
Changelog

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
