/**
 * @fgfg163/dsh-prompt-slot — a shared, cache-safe per-turn injection slot.
 *
 * ## Why this exists
 *
 * DSH has four places a plugin can put model-visible text, and they cost very
 * different amounts of provider prefix cache:
 *
 * | surface                      | API                                    | cache |
 * | ---------------------------- | -------------------------------------- | ----- |
 * | system prompt section        | `ctx.systemPrompt.section()`           | rewrites system node 0 — breaks from the first changed token |
 * | dynamic runtime context      | `ctx.systemPrompt.context()`           | replaces a user node in place — breaks from there |
 * | pre-step append              | `agent/pre-step` -> `decision.messages`| append only — prefix survives |
 * | post-tool append             | `post-execute` `additionalContexts`    | append only — prefix survives |
 *
 * Only the last two are cache-safe, and both are "every plugin pushes into the
 * same array in registration order". There is no shared slot, no budget, no
 * deduplication, and no way for one plugin to hand another a place to write.
 *
 * This plugin adds exactly that: one registry, one append-only injection per
 * step, deduplicated against the durable session projection so a resumed
 * session does not re-inject unchanged text.
 *
 * ## Two channels
 *
 * A slot picks where its text lands with `channel`:
 *
 * | channel      | lands in                                   | enters session history |
 * | ------------ | ------------------------------------------ | ---------------------- |
 * | `'pre-step'` | `agent/pre-step` -> `decision.messages`     | yes                    |
 * | `'request'`  | the outbound `llm/stream` request only      | **no**                 |
 *
 * `'request'` matches OpenClaw's `prependContext`: the text is woven into the
 * provider request ahead of the current user turn and is never appended to the
 * session log. That breaks DSH's *model-visible ⟺ logged* invariant on
 * purpose — a request built this way cannot be reconstructed from the session
 * log — so it is opt-in per slot rather than the default.
 *
 * ## What it deliberately does NOT do
 *
 * It never touches the system prompt or the runtime-context snapshot. Those
 * are the two APIs that invalidate the cached prefix, and DSH keeps the
 * runtime-context slot unique on purpose (cwd, sandbox mode, approval policy
 * are facts, not per-turn commentary).
 */

import { randomUUID } from 'node:crypto'

/**
 * Cordis plugin name; also the `source.kind` of every message this plugin emits.
 *
 * 2026-11-15: renamed from `prompt-inject` to `prompt-slot` and namespaced with
 * the author when the package moved to `@fgfg163/*` on npm.
 *
 * Note the consequence: `source.kind` on messages already written into old
 * session logs still says `prompt-inject`, so the duplicate-suppression check
 * below no longer recognises them. Harmless in practice — that check compares
 * against the *last injected turn* projection, which is rebuilt fresh — but
 * anyone grepping old logs for `prompt-slot` will not find pre-rename rows.
 */
const name = 'fgfg163-prompt-slot'

/** Services this plugin needs before `apply` runs. */
const inject = ['sessionProjections']

/** Projection key holding the last injected turn and body. */
const PROJECTION_KEY = 'promptInject'

/** Default per-slot character budget. */
const DEFAULT_SLOT_MAX_CHARS = 4000

/** Default total character budget for one pre-step injection. */
const DEFAULT_TOTAL_MAX_CHARS = 8000

/** Default per-slot render timeout. `agent/pre-step` sits on the critical path. */
const DEFAULT_TIMEOUT_MS = 1500

/** Channels a slot may target. */
const CHANNELS = ['pre-step', 'request']

/**
 * Bookkeeping for requests this plugin already rewrote.
 *
 * `llm/stream` re-entry is the only way to change an outbound request (the
 * waterfall's `next` closure always replays the original arguments), so the
 * rewritten object must be recognized when it comes back through.
 */
const rewrittenRequests = new WeakSet()

/**
 * A tiny `.parse`-shaped schema. `sessionProjections` calls `stateSchema.parse`
 * while `zod` is not resolvable from a profile-local plugin, so the contract is
 * duck-typed rather than imported.
 */
function stateSchema(validate) {
  return {
    parse(value) {
      const parsed = validate(value)
      if (parsed === undefined) throw new TypeError('prompt-slot projection state is malformed')
      return parsed
    },
  }
}

const injectedStateSchema = stateSchema((value) => {
  if (value === null || typeof value !== 'object') return undefined
  const turn = value.turn
  const body = value.body
  if (!Number.isSafeInteger(turn) || turn < -1) return undefined
  if (typeof body !== 'string') return undefined
  return { turn, body }
})

/** Concatenate the text blocks of one user message. */
function textOf(message) {
  const content = message?.content
  if (!Array.isArray(content)) return ''
  let out = ''
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string') out += block.text
  }
  return out
}

/**
 * Fold one committed event into the last-injection state.
 *
 * Only this plugin's own messages count, so the projection is rebuilt
 * identically on resume without any process-local cache.
 */
function foldInjected(state, event) {
  if (event.type !== 'user/message') return state
  const data = event.data
  if (data?.source?.kind !== name) return state
  const turn = data.source.turn
  if (!Number.isSafeInteger(turn)) return state
  const body = textOf(data)
  if (state.turn === turn && state.body === body) return state
  return { turn, body }
}

/**
 * Order slots deterministically: lower priority first, ties broken by id so a
 * registration-order accident cannot reorder the injected text and perturb the
 * cache shape on every restart.
 */
function compareSlots(a, b) {
  return a.priority - b.priority || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
}

/** Validate one slot registration and return a frozen normalized copy. */
function normalizeSlot(slot, taken) {
  if (slot === null || typeof slot !== 'object') throw new TypeError('prompt-slot slot must be an object')
  const { id } = slot
  if (typeof id !== 'string' || id.trim() === '') throw new TypeError('prompt-slot slot requires a non-empty string id')
  if (taken.has(id)) throw new Error(`prompt-slot slot ${JSON.stringify(id)} is already registered`)
  if (typeof slot.render !== 'function') throw new TypeError(`prompt-slot slot ${JSON.stringify(id)} requires a render() function`)
  const priority = slot.priority ?? 100
  if (!Number.isFinite(priority)) throw new TypeError(`prompt-slot slot ${JSON.stringify(id)} priority must be finite`)
  const maxChars = slot.maxChars ?? DEFAULT_SLOT_MAX_CHARS
  if (!Number.isSafeInteger(maxChars) || maxChars <= 0) {
    throw new TypeError(`prompt-slot slot ${JSON.stringify(id)} maxChars must be a positive integer`)
  }
  const when = slot.when ?? 'turn'
  if (when !== 'turn' && when !== 'step') throw new TypeError(`prompt-slot slot ${JSON.stringify(id)} when must be 'turn' or 'step'`)
  const channel = slot.channel ?? 'pre-step'
  if (!CHANNELS.includes(channel)) throw new TypeError(`prompt-slot slot ${JSON.stringify(id)} channel must be 'pre-step' or 'request'`)
  const timeoutMs = slot.timeoutMs ?? DEFAULT_TIMEOUT_MS
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError(`prompt-slot slot ${JSON.stringify(id)} timeoutMs must be a positive integer`)
  }
  return Object.freeze({ id, priority, maxChars, when, channel, timeoutMs, render: slot.render })
}

/**
 * Truncate one slot's text at its own budget, marking the cut.
 *
 * The marker counts against the budget. When the budget cannot hold both, the
 * marker is shortened and then abandoned rather than overrunning `maxChars` —
 * a slot that promises a ceiling must never exceed it.
 */
function boundSlotText(id, raw, maxChars) {
  const text = String(raw).trim()
  if (text.length === 0) return ''
  if (text.length <= maxChars) return text
  const marker = `\n[truncated: ${id} exceeded ${maxChars} chars]`
  if (marker.length < maxChars) return text.slice(0, maxChars - marker.length) + marker
  const short = `\n[truncated]`
  if (short.length < maxChars) return text.slice(0, maxChars - short.length) + short
  return text.slice(0, maxChars)
}

/**
 * Drop the lowest-priority slots until the joined body fits the total budget.
 *
 * "Lowest priority" means the largest `priority` number, so eviction walks the
 * list in descending priority order. The retained order is preserved, so a
 * dropped slot never shifts the surviving ones.
 */
function fitTotalBudget(parts, totalMaxChars) {
  let body = parts.map((part) => part.text).join('\n\n')
  if (body.length <= totalMaxChars) return { body, kept: parts, dropped: [] }
  // Descending priority: the most expendable slot goes first.
  const byPriority = [...parts].sort((a, b) => b.priority - a.priority || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const kept = new Map(parts.map((part) => [part.id, part]))
  const dropped = []
  for (const part of byPriority) {
    if (body.length <= totalMaxChars) break
    kept.delete(part.id)
    dropped.push(part.id)
    body = parts.filter((entry) => kept.has(entry.id)).map((entry) => entry.text).join('\n\n')
  }
  return { body, kept: parts.filter((entry) => kept.has(entry.id)), dropped }
}

/** Resolve one slot's text under its own timeout; `null` means "nothing this step". */
async function renderSlot(slot, context) {
  let timer
  try {
    const rendered = await Promise.race([
      Promise.resolve().then(() => slot.render(context)),
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`render timed out after ${slot.timeoutMs}ms`)), slot.timeoutMs)
        timer.unref?.()
      }),
    ])
    if (rendered === null || rendered === undefined) return ''
    return boundSlotText(slot.id, rendered, slot.maxChars)
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * Install the injection slot service and its single pre-step listener.
 *
 * @param ctx - plugin context providing `sessionProjections`.
 * @param config - process-wide budget and placement policy.
 */
function apply(ctx, config = {}) {
  const totalMaxChars = config.totalMaxChars ?? DEFAULT_TOTAL_MAX_CHARS
  if (!Number.isSafeInteger(totalMaxChars) || totalMaxChars <= 0) {
    throw new TypeError(`prompt-slot totalMaxChars must be a positive integer, got ${String(totalMaxChars)}`)
  }
  const position = config.position ?? 'before'
  if (position !== 'before' && position !== 'after') {
    throw new TypeError(`prompt-slot position must be 'before' or 'after', got ${JSON.stringify(position)}`)
  }

  /** Registered slots keyed by id, owned by this plugin's fiber. */
  const slots = new Map()

  ctx.sessionProjections.register({
    key: PROJECTION_KEY,
    stateVersion: 1,
    stateSchema: injectedStateSchema,
    init: () => ({ turn: -1, body: '' }),
    apply: foldInjected,
  })

  /**
   * Public registry handed to other plugins.
   *
   * `register()` returns the exact disposer; unregistering a slot removes its
   * text from the next injection. Registering a duplicate id throws rather
   * than silently shadowing, because two plugins writing the same header would
   * produce an order nobody can reason about.
   */
  const service = {
    /**
     * @param slot - `{ id, render, priority?, when?, channel?, maxChars?, timeoutMs? }`.
     * @returns the Cordis effect disposer for this registration.
     */
    register(slot) {
      const normalized = normalizeSlot(slot, slots)
      slots.set(normalized.id, normalized)
      return () => {
        if (slots.get(normalized.id) === normalized) slots.delete(normalized.id)
      }
    },
    /** Remove one slot by id; returns whether it existed. */
    unregister(id) {
      return slots.delete(id)
    },
    /** Whether a slot id is currently registered. */
    has(id) {
      return slots.has(id)
    },
    /** Registered slots in final injection order, as descriptors (no functions). */
    list() {
      return [...slots.values()].sort(compareSlots).map(({ id, priority, maxChars, when, channel, timeoutMs }) => ({
        id,
        priority,
        maxChars,
        when,
        channel,
        timeoutMs,
      }))
    },
  }

  try {
    ctx.provide('promptInject', service)
  } catch (error) {
    ctx.logger?.warn?.(`prompt-slot: another provider already owns ctx.promptInject (${error?.message ?? error})`)
    return
  }

  /** Slots that inject into the outbound request instead of the session log. */
  function requestSlots() {
    return [...slots.values()].filter((slot) => slot.channel === 'request').sort(compareSlots)
  }

  /**
   * Rendered request text waiting for its turn's first model call, by session.
   *
   * The pre-step hook renders it (so the daemon lookup overlaps prompt
   * assembly) and the request hook consumes it, which is what makes request
   * injection happen **once per turn** without the request hook needing to know
   * the turn number. Later steps in the same turn find nothing and pass through.
   */
  const pendingRequest = new Map()

  /**
   * Index of the message a request-only block should precede.
   *
   * The tail of one request is `...history, <this turn's user prompt>,
   * <runtime-context snapshot>`. The block belongs immediately ahead of that
   * user prompt, matching OpenClaw's `prependContext`. The trailing snapshot is
   * skipped because it is emitted after the accepted users.
   *
   * @param messages - the outbound array.
   * @returns the splice index; `messages.length` when no user prompt is found.
   */
  function requestAnchor(messages) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index]
      if (message?.role !== 'user') continue
      if (message?.source?.kind === 'runtime-context') continue
      return index
    }
    return messages.length
  }

  /**
   * Render every `channel: 'request'` slot into one request-only block.
   *
   * @returns `{ text, sections }`, or `undefined` when nothing is worth sending.
   */
  async function renderRequestBlock(context) {
    const candidates = requestSlots()
    if (candidates.length === 0) return undefined
    const parts = []
    for (const slot of candidates) {
      let text
      try {
        text = await renderSlot(slot, context)
      } catch (error) {
        ctx.logger?.warn?.(`prompt-slot: request slot ${JSON.stringify(slot.id)} failed: ${error?.message ?? error}`)
        continue
      }
      if (text) parts.push({ id: slot.id, priority: slot.priority, text })
    }
    if (parts.length === 0) return undefined
    const { body, kept, dropped } = fitTotalBudget(parts, totalMaxChars)
    if (dropped.length > 0) {
      ctx.logger?.warn?.(`prompt-slot: request budget ${totalMaxChars} dropped ${dropped.join(', ')}`)
    }
    if (body.length === 0) return undefined
    return { text: body, sections: kept.map((part) => ({ name: part.id, text: part.text })) }
  }

  /**
   * Rewrite one outbound request so the pending request-only block rides along.
   *
   * The waterfall's `next` closure always replays the original arguments, so a
   * modified request can only be dispatched by re-entering `llm.stream()` with
   * a new object. `rewrittenRequests` stops the re-entry from looping.
   */
  ctx.on(
    'llm/stream',
    async function* (options, next) {
      try {
        if (rewrittenRequests.has(options) || options === null || typeof options !== 'object') {
          yield* next()
          return
        }
        // Auxiliary calls (title generation, compaction, probes) declare a
        // purpose. Only the main conversation loop has none.
        if (options.purpose !== undefined || typeof options.sessionId !== 'string') {
          yield* next()
          return
        }
        const pending = pendingRequest.get(options.sessionId)
        if (pending === undefined) {
          yield* next()
          return
        }
        pendingRequest.delete(options.sessionId)
        const llm = ctx.get?.('llm')
        if (llm === undefined || typeof llm.stream !== 'function') {
          ctx.logger?.warn?.('prompt-slot: ctx.llm is unavailable; request injection skipped')
          yield* next()
          return
        }
        const messages = Array.isArray(options.messages) ? [...options.messages] : []
        const anchor = requestAnchor(messages)
        if (anchor >= messages.length) {
          // Nothing this turn resembles a user prompt; appending is the only
          // shape that cannot reorder history.
          messages.push({ role: 'user', content: [{ type: 'text', text: pending.text }] })
        } else {
          messages.splice(anchor, 0, { role: 'user', content: [{ type: 'text', text: pending.text }] })
        }
        const rewritten = { ...options, messages }
        rewrittenRequests.add(rewritten)
        yield* llm.stream(rewritten)
      } catch (error) {
        ctx.logger?.warn?.(`prompt-slot: llm/stream rewrite failed: ${error?.message ?? error}`)
        yield* next()
      }
    },
    { global: true },
  )

  ctx.on(
    'agent/pre-step',
    async ({ agent, turn, step, signal }, next) => {
      const decision = await next()
      // Never turn an otherwise-empty step into work: the loop treats an empty
      // first step as a finished turn, and injecting here would spin forever.
      if (decision.kind !== 'enter' || decision.messages.length === 0 || signal.aborted) return decision
      if (slots.size === 0) return decision

      const context = { agent, session: agent.session, turn, step, decision, signal }

      // Render request-channel text here, on the turn's first step, so the
      // upstream lookup overlaps prompt assembly. The `llm/stream` hook claims
      // it on the way out; a later step in the same turn finds nothing pending.
      if (step === 1 && requestSlots().length > 0) {
        const block = await renderRequestBlock(context)
        if (signal.aborted) return decision
        if (block === undefined) pendingRequest.delete(agent.session.id)
        else pendingRequest.set(agent.session.id, block)
      }

      const preStepSlots = [...slots.values()].filter((slot) => slot.channel !== 'request')
      if (preStepSlots.length === 0) return decision

      const parts = []
      for (const slot of preStepSlots.sort(compareSlots)) {
        if (slot.when === 'turn' && step !== 1) continue
        let text
        try {
          text = await renderSlot(slot, context)
        } catch (error) {
          ctx.logger?.warn?.(`prompt-slot: slot ${JSON.stringify(slot.id)} failed: ${error?.message ?? error}`)
          continue
        }
        if (signal.aborted) return decision
        if (text) parts.push({ id: slot.id, priority: slot.priority, text })
      }
      if (parts.length === 0) return decision

      const { body, kept, dropped } = fitTotalBudget(parts, totalMaxChars)
      if (dropped.length > 0) {
        ctx.logger?.warn?.(`prompt-slot: total budget ${totalMaxChars} dropped ${dropped.join(', ')}`)
      }
      if (body.length === 0) return decision

      // Skip work the durable log already shows: same turn, same body. This is
      // what makes the slot survive resume without burning a duplicate append.
      const state = ctx.sessionProjections.stateOf(agent.session, PROJECTION_KEY)
      if (state !== undefined && state.turn === turn && state.body === body) return decision

      const message = {
        id: randomUUID(),
        role: 'user',
        source: {
          kind: name,
          form: 'snapshot',
          turn,
          step,
          sections: kept.map((part) => ({ name: part.id, text: part.text })),
        },
        content: [{ type: 'text', text: body }],
      }

      if (position === 'after') {
        return { ...decision, messages: [...decision.messages, message] }
      }

      // 'before': sit immediately ahead of the first real user prompt, keeping
      // any runtime-context snapshot where the loop expects to place it.
      const messages = [...decision.messages]
      const anchor = messages.findIndex((entry) => entry?.source?.kind !== 'runtime-context')
      messages.splice(anchor < 0 ? messages.length : anchor, 0, message)
      return { ...decision, messages }
    },
    { prepend: true },
  )
}

export { apply, inject, name }
