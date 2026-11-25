# Changelog

All notable changes to `@fgfg163/dsh-prompt-slot` are recorded here.
每个版本先英文后中文。

---

# 0.3.1

## English

**Changed**

- **The per-turn total budget is unlimited by default.** `totalMaxChars` no
  longer has a schema default and is absent from the shipped patch, so a fresh
  install imposes no total ceiling — only each slot's own `maxChars` applies.
  The settings field is now a free-text box that may be left empty; clearing it
  writes an `unset` op, which removes the key and restores "unlimited".
  "Unlimited" is a real state rather than a magic number, because the form can
  only `set` a value or `unset` the key — a numeric default would make it
  impossible to save.

**Fixed**

- `totalMaxChars: 0` (and negatives, and non-integers) are rejected with a
  clear message instead of being read as "no ceiling". A real 0 would otherwise
  silently drop every slot, and a typo must never remove a ceiling someone set
  on purpose.

## 中文

**变更**

- **单轮总预算默认不限制。** `totalMaxChars` 不再有 schema 默认值，出厂 patch
  里也不写这个键，所以新装即无总量上限 —— 只有单槽自己的 `maxChars` 生效。
  设置页改成可留空的文本框，清空即写入 `unset`，把键删掉、恢复「不限」。
  「不限」是真实状态而不是幻数：设置页只能 `set` 值或 `unset` 键，给数字默认
  值会让「不限」根本存不下去。

**修复**

- `totalMaxChars: 0`（以及负数、非整数）现在直接报错，不再被当成「不限」。
  真正的 0 会让所有槽位都被淘汰，手误也不该抹掉别人特意设的上限。

---

# 0.3.0

## English

**Added**

- **Two registration methods replace the global placement switch.**
  `ctx.promptInject.registerBefore(slot)` puts the block ahead of this turn's
  user prompt; `ctx.promptInject.registerAfter(slot)` appends it behind every
  existing message. Placement is a property of the content, so it now belongs
  to whoever registers the slot rather than to one process-wide setting that
  unrelated consumers had to fight over.
- Each placement is joined into its own message and measured against its own
  `totalMaxChars` budget, so "before" can never starve "after".
- Deduplication is tracked per placement on the same session projection row, so
  one turn can carry a before block and an after block independently.

**Changed**

- `register(slot)` is now the compatibility entry point: it honours the slot's
  own `placement` field (default `'before'`), so 0.2.0 consumers keep working
  unchanged.
- The projection row moved to `stateVersion: 2` (`{ turn, before, after }`).
  `dsh-session-projection` drops a version-mismatched row and refolds the log
  from seq 0, and `foldInjected` reads a placement-less (pre-0.3.0) message as a
  "before" body — so an in-place upgrade rebuilds its dedup baseline instead of
  losing it. `injectedStateSchema` additionally accepts the v1 shape for direct
  callers.
- `list()` descriptors now include `placement` and are sorted by placement then
  priority.
- The settings page edits only `totalMaxChars`; the placement dropdown is gone.

**Removed**

- **`position`** from `Config` and from `cordis.patch.yml`. A leftover
  `position:` key in a hand-written patch is ignored rather than fatal.

**Fixed**

- The request channel's splice now uses the joined block's `body` field (it
  read `.text` and injected an empty string).

## 中文

**新增**

- **用两个注册方法取代全局位置开关。**
  `ctx.promptInject.registerBefore(slot)` 把块放在本轮用户提问之前；
  `ctx.promptInject.registerAfter(slot)` 追加到所有已有消息之后。位置是内容自己的
  属性，所以改由投稿方决定，而不是一个让互不相关的消费方互相抢的进程级开关。
- 每个位置各自合成一条消息、各自对照自己的 `totalMaxChars` 预算，前注入不会饿死后注入。
- 去重按位置分别记录在同一条 projection 上，一轮可以同时带前块和后块。

**变更**

- `register(slot)` 退化为兼容入口：读槽位自己的 `placement`（默认 `'before'`），
  0.2.0 的消费方无需改动。
- projection 行升到 `stateVersion: 2`（`{ turn, before, after }`）。
  `dsh-session-projection` 会把版本不匹配的行丢掉并从 seq 0 重折日志，而
  `foldInjected` 把没有 placement 的旧消息（0.3.0 之前）当作前注入正文 ——
  所以原地升级是**重建**去重基线，不是丢掉它。`injectedStateSchema` 另外也接受
  v1 形状，供直接调用方使用。
- `list()` 的描述符新增 `placement`，排序规则改为先位置后优先级。
- 配置页只编辑 `totalMaxChars`，位置下拉框已删除。

**移除**

- `Config` 与 `cordis.patch.yml` 里的 **`position`**。手写 patch 里残留的
  `position:` 会被忽略，不会报错。

**修复**

- request 通道拼接改用块的 `body` 字段（原先读 `.text`，注入的是空串）。

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
