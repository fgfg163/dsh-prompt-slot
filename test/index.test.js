/**
 * Harness-free unit tests for @fgfg163/dsh-prompt-slot.
 *
 * These run under plain Node: the plugin only needs a fake `ctx` with
 * `provide`, `on`, `effect`, `sessionProjections`, and `logger`. That keeps the
 * cache-safety contract testable without booting DSH.
 *
 * Run: node --test test/
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { apply as applySlot, inject as slotInject, name as slotName } from '../lib/index.js'

/** Build a fake Cordis context recording the pre-step listener and service. */
function makeCtx() {
  const listeners = []
  const services = new Map()
  const registrations = new Map()
  const states = new WeakMap()
  const warnings = []

  const ctx = {
    logger: { warn: (message) => warnings.push(message) },
    provide(serviceName, value) {
      if (services.has(serviceName)) throw new Error(`service "${serviceName}" already provided`)
      services.set(serviceName, value)
      return () => services.delete(serviceName)
    },
    on(event, handler, options) {
      listeners.push({ event, handler, options })
      return () => {}
    },
    effect(factory) {
      const dispose = factory()
      return () => dispose?.()
    },
    sessionProjections: {
      register(definition) {
        registrations.set(definition.key, definition)
      },
      stateOf(session, key) {
        const definition = registrations.get(key)
        if (definition === undefined) return undefined
        let state = states.get(session)
        if (state === undefined) {
          state = { [key]: definition.init() }
          states.set(session, state)
        }
        return state[key]
      },
      /** Fold one committed event, exactly like the real projection driver. */
      fold(session, key, event) {
        const definition = registrations.get(key)
        const current = ctx.sessionProjections.stateOf(session, key)
        states.get(session)[key] = definition.apply(current, event)
      },
    },
  }

  return { ctx, listeners, services, registrations, states, warnings }
}

/** A decision shaped like the loop's fallback value. */
function decision(overrides = {}) {
  return {
    kind: 'enter',
    messages: [
      { id: 'prompt-1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }] },
    ],
    ...overrides,
  }
}

/** One fake session identity. */
function fakeSession() {
  return { id: 'session-1' }
}

/** Drive the registered pre-step listener once. */
async function preStep(harness, payload, nextValue) {
  const entry = harness.listeners.find((listener) => listener.event === 'agent/pre-step')
  assert.ok(entry, 'pre-step listener must be registered')
  return entry.handler(payload, async () => nextValue)
}

test('plugin exports the Cordis contract', () => {
  assert.equal(slotName, 'fgfg163-prompt-slot')
  assert.deepEqual(slotInject, ['sessionProjections'])
})

test('registers the slot service and prepends the listener', () => {
  const harness = makeCtx()
  applySlot(harness.ctx, {})
  assert.ok(harness.services.has('promptInject'), 'ctx.promptInject must be provided')
  const entry = harness.listeners.find((listener) => listener.event === 'agent/pre-step')
  assert.equal(entry.options?.prepend, true, 'listener must run before other injectors')
})

test('injects registered slot text ahead of the user prompt', async () => {
  const harness = makeCtx()
  applySlot(harness.ctx, {})
  const service = harness.services.get('promptInject')
  service.registerBefore({ id: 'test:hello', render: () => 'slot body' })

  const base = decision()
  const out = await preStep(harness, { agent: { session: fakeSession() }, turn: 1, step: 1, signal: new AbortController().signal }, base)

  assert.equal(out.messages.length, 2)
  assert.equal(out.messages[0].source.kind, 'fgfg163-prompt-slot')
  assert.equal(out.messages[0].content[0].text, 'slot body')
  assert.equal(out.messages[1], base.messages[0])
})

test('registerAfter appends behind existing messages', async () => {
  const harness = makeCtx()
  applySlot(harness.ctx, {})
  harness.services.get('promptInject').registerAfter({ id: 'test:hello', render: () => 'slot body' })

  const base = decision()
  const out = await preStep(harness, { agent: { session: fakeSession() }, turn: 1, step: 1, signal: new AbortController().signal }, base)

  assert.equal(out.messages[1].source.kind, 'fgfg163-prompt-slot')
  assert.equal(out.messages[0], base.messages[0])
})

test('before and after slot land as two separate messages in one step', async () => {
  const harness = makeCtx()
  applySlot(harness.ctx, {})
  const service = harness.services.get('promptInject')
  service.registerBefore({ id: 'test:pre', render: () => 'pre body' })
  service.registerAfter({ id: 'test:post', render: () => 'post body' })

  const base = decision()
  const out = await preStep(harness, { agent: { session: fakeSession() }, turn: 1, step: 1, signal: new AbortController().signal }, base)

  assert.equal(out.messages.length, 3)
  assert.equal(out.messages[0].content[0].text, 'pre body')
  assert.equal(out.messages[0].source.placement, 'before')
  assert.equal(out.messages[1], base.messages[0])
  assert.equal(out.messages[2].content[0].text, 'post body')
  assert.equal(out.messages[2].source.placement, 'after')
})

test('the two placements have independent budgets', async () => {
  const harness = makeCtx()
  applySlot(harness.ctx, { totalMaxChars: 40 })
  const service = harness.services.get('promptInject')
  service.registerBefore({ id: 'pre:keep', render: () => 'p'.repeat(30) })
  service.registerAfter({ id: 'post:keep', render: () => 'a'.repeat(30) })

  const out = await preStep(harness, { agent: { session: fakeSession() }, turn: 1, step: 1, signal: new AbortController().signal }, decision())

  assert.equal(out.messages.length, 3, 'neither placement may evict the other')
  assert.equal(out.messages[0].content[0].text, 'p'.repeat(30))
  assert.equal(out.messages[2].content[0].text, 'a'.repeat(30))
})

test('each placement dedups on its own body', async () => {
  const harness = makeCtx()
  applySlot(harness.ctx, {})
  const service = harness.services.get('promptInject')
  const session = fakeSession()
  let pre = 'pre body'
  let post = 'post body'
  service.registerBefore({ id: 'test:pre', render: () => pre })
  service.registerAfter({ id: 'test:post', render: () => post })

  const payload = { agent: { session }, turn: 1, step: 1, signal: new AbortController().signal }
  const first = await preStep(harness, payload, decision())
  assert.equal(first.messages.length, 3)
  for (const message of first.messages.filter((entry) => entry.source?.kind === 'fgfg163-prompt-slot')) {
    harness.ctx.sessionProjections.fold(session, 'promptInject', { type: 'user/message', data: message })
  }

  // Both unchanged: nothing new.
  const same = await preStep(harness, payload, decision())
  assert.equal(same.messages.length, 1)

  // Only "after" changed: exactly one message comes back, and it is the after one.
  post = 'post body v2'
  const changed = await preStep(harness, payload, decision())
  assert.equal(changed.messages.length, 2)
  assert.equal(changed.messages[1].content[0].text, 'post body v2')
  assert.equal(changed.messages[1].source.placement, 'after')
})

test('a version-1 projection row is migrated to the two-placement shape', () => {
  const harness = makeCtx()
  applySlot(harness.ctx, {})
  const definition = harness.registrations.get('promptInject')
  assert.equal(definition.stateVersion, 2)

  // What an upgraded install carries over from 0.2.0: { turn, body }.
  assert.deepEqual(definition.stateSchema.parse({ turn: 3, body: 'stable' }), { turn: 3, before: 'stable', after: '' })
  // The current shape round-trips untouched.
  assert.deepEqual(definition.stateSchema.parse({ turn: 4, before: 'p', after: 'a' }), { turn: 4, before: 'p', after: 'a' })
  // A malformed row is refused rather than silently accepted.
  assert.throws(() => definition.stateSchema.parse({ turn: 'x' }), /malformed/)
})

test('runtime-context snapshots are not displaced from the anchor', async () => {
  const harness = makeCtx()
  applySlot(harness.ctx, {})
  harness.services.get('promptInject').registerBefore({ id: 'test:hello', render: () => 'slot body' })

  const base = decision({
    messages: [
      { id: 'ctx', role: 'user', source: { kind: 'runtime-context' }, content: [{ type: 'text', text: 'cwd' }] },
      { id: 'prompt-1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }] },
    ],
  })
  const out = await preStep(harness, { agent: { session: fakeSession() }, turn: 1, step: 1, signal: new AbortController().signal }, base)

  assert.deepEqual(
    out.messages.map((message) => message.source.kind),
    ['runtime-context', 'fgfg163-prompt-slot', 'user'],
  )
})

test('an empty first step is never turned into work', async () => {
  const harness = makeCtx()
  applySlot(harness.ctx, {})
  harness.services.get('promptInject').register({ id: 'test:hello', render: () => 'slot body' })

  const base = decision({ messages: [] })
  const out = await preStep(harness, { agent: { session: fakeSession() }, turn: 1, step: 1, signal: new AbortController().signal }, base)

  assert.equal(out.messages.length, 0)
})

test('rejected decisions stay rejected', async () => {
  const harness = makeCtx()
  applySlot(harness.ctx, {})
  harness.services.get('promptInject').register({ id: 'test:hello', render: () => 'slot body' })

  const base = { kind: 'reject' }
  const out = await preStep(harness, { agent: { session: fakeSession() }, turn: 1, step: 1, signal: new AbortController().signal }, base)

  assert.deepEqual(out, base)
})

test('unchanged text is not injected twice for the same turn', async () => {
  const harness = makeCtx()
  applySlot(harness.ctx, {})
  harness.services.get('promptInject').register({ id: 'test:hello', render: () => 'stable' })

  const session = fakeSession()
  const first = await preStep(harness, { agent: { session }, turn: 1, step: 1, signal: new AbortController().signal }, decision())
  assert.equal(first.messages.length, 2)

  // Record the committed message the way the session log would.
  harness.ctx.sessionProjections.fold(session, 'promptInject', {
    type: 'user/message',
    data: first.messages[0],
  })

  const second = await preStep(harness, { agent: { session }, turn: 1, step: 1, signal: new AbortController().signal }, decision())
  assert.equal(second.messages.length, 1, 'duplicate body must not be appended again')
})

test('a new turn injects again even with identical text', async () => {
  const harness = makeCtx()
  applySlot(harness.ctx, {})
  harness.services.get('promptInject').register({ id: 'test:hello', render: () => 'stable' })

  const session = fakeSession()
  const first = await preStep(harness, { agent: { session }, turn: 1, step: 1, signal: new AbortController().signal }, decision())
  harness.ctx.sessionProjections.fold(session, 'promptInject', { type: 'user/message', data: first.messages[0] })

  const second = await preStep(harness, { agent: { session }, turn: 2, step: 1, signal: new AbortController().signal }, decision())
  assert.equal(second.messages.length, 2)
})

test('when:"turn" renders only on step 1', async () => {
  const harness = makeCtx()
  applySlot(harness.ctx, {})
  let calls = 0
  harness.services.get('promptInject').register({ id: 'test:hello', render: () => (calls += 1, 'body') })

  const stepTwo = await preStep(harness, { agent: { session: fakeSession() }, turn: 1, step: 2, signal: new AbortController().signal }, decision())
  assert.equal(stepTwo.messages.length, 1)
  assert.equal(calls, 0)
})

test('when:"step" renders on every step', async () => {
  const harness = makeCtx()
  applySlot(harness.ctx, {})
  let calls = 0
  harness.services.get('promptInject').register({ id: 'test:hello', when: 'step', render: () => (calls += 1, `body ${calls}`) })

  await preStep(harness, { agent: { session: fakeSession() }, turn: 1, step: 2, signal: new AbortController().signal }, decision())
  assert.equal(calls, 1)
})

test('slots render in priority order', async () => {
  const harness = makeCtx()
  applySlot(harness.ctx, {})
  const service = harness.services.get('promptInject')
  service.register({ id: 'b', priority: 200, render: () => 'second' })
  service.register({ id: 'a', priority: 100, render: () => 'first' })

  const out = await preStep(harness, { agent: { session: fakeSession() }, turn: 1, step: 1, signal: new AbortController().signal }, decision())
  assert.equal(out.messages[0].content[0].text, 'first\n\nsecond')
  assert.deepEqual(out.messages[0].source.sections.map((section) => section.name), ['a', 'b'])
})

test('per-slot maxChars truncates with a visible marker', async () => {
  const harness = makeCtx()
  applySlot(harness.ctx, {})
  harness.services.get('promptInject').register({ id: 'long', maxChars: 80, render: () => 'x'.repeat(200) })

  const out = await preStep(harness, { agent: { session: fakeSession() }, turn: 1, step: 1, signal: new AbortController().signal }, decision())
  const text = out.messages[0].content[0].text
  assert.equal(text.length, 80, 'a slot must never exceed its own ceiling')
  assert.match(text, /\[truncated: long exceeded 80 chars\]$/)
})

test('a budget too small for the full marker degrades instead of overrunning', async () => {
  const harness = makeCtx()
  applySlot(harness.ctx, {})
  harness.services.get('promptInject').register({ id: 'tiny', maxChars: 20, render: () => 'x'.repeat(200) })

  const out = await preStep(harness, { agent: { session: fakeSession() }, turn: 1, step: 1, signal: new AbortController().signal }, decision())
  const text = out.messages[0].content[0].text
  assert.equal(text.length, 20)
  assert.match(text, /\[truncated\]$/)
})

test('a null config (comment-only patch block) still mounts', () => {
  const harness = makeCtx()
  applySlot(harness.ctx, null)
  assert.ok(harness.services.has('promptInject'), 'a null config must fall back to defaults, not throw')
})

test('an empty config object means unlimited', async () => {
  const harness = makeCtx()
  applySlot(harness.ctx, {})
  harness.services.get('promptInject').register({ id: 'big', maxChars: 100000, render: () => 'x'.repeat(20000) })
  const out = await preStep(harness, { agent: { session: fakeSession() }, turn: 1, step: 1, signal: new AbortController().signal }, decision())
  assert.equal(out.messages.length, 2)
  assert.equal(out.messages[0].content[0].text.length, 20000)
})

test('no totalMaxChars means unlimited', async () => {
  const harness = makeCtx()
  applySlot(harness.ctx, {})
  const service = harness.services.get('promptInject')
  // Well past the old 8000 default: with no ceiling configured everything stays.
  service.register({ id: 'huge', maxChars: 100000, render: () => 'x'.repeat(40000) })
  service.register({ id: 'keep', priority: 900, render: () => 'tail' })

  const out = await preStep(harness, { agent: { session: fakeSession() }, turn: 1, step: 1, signal: new AbortController().signal }, decision())
  const text = out.messages[0].content[0].text
  assert.equal(text.length, 40000 + '\n\n'.length + 4, 'nothing may be evicted without a ceiling')
  assert.deepEqual(out.messages[0].source.sections.map((section) => section.name), ['huge', 'keep'])
  assert.equal(harness.warnings.length, 0, 'no budget warning when unlimited')
})

test('an explicit totalMaxChars still evicts', async () => {
  const harness = makeCtx()
  applySlot(harness.ctx, { totalMaxChars: 40 })
  harness.services.get('promptInject').register({ id: 'big', render: () => 'x'.repeat(100) })
  const out = await preStep(harness, { agent: { session: fakeSession() }, turn: 1, step: 1, signal: new AbortController().signal }, decision())
  assert.equal(out.messages.length, 1, 'the only slot over budget is dropped')
  assert.ok(harness.warnings.some((warning) => warning.includes('budget 40 dropped big')))
})

test('zero or negative totalMaxChars is rejected, not read as unlimited', () => {
  assert.throws(() => applySlot(makeCtx().ctx, { totalMaxChars: 0 }), /positive integer or left empty/)
  assert.throws(() => applySlot(makeCtx().ctx, { totalMaxChars: -5 }), /positive integer or left empty/)
  assert.throws(() => applySlot(makeCtx().ctx, { totalMaxChars: 12.5 }), /positive integer or left empty/)
})

test('a live reference cleared to null becomes unlimited', async () => {
  const harness = makeCtx()
  let current = 40
  applySlot(harness.ctx, { totalMaxChars: { get: () => current } })
  harness.services.get('promptInject').register({ id: 'big', render: () => 'x'.repeat(100) })

  const payload = { agent: { session: fakeSession() }, turn: 1, step: 1, signal: new AbortController().signal }
  const limited = await preStep(harness, payload, decision())
  assert.equal(limited.messages.length, 1, 'a configured budget evicts')

  current = null
  const unlimited = await preStep(harness, payload, decision())
  assert.equal(unlimited.messages.length, 2, 'clearing the budget lets everything through')
})

test('the total budget drops the lowest-priority slot first', async () => {
  const harness = makeCtx()
  applySlot(harness.ctx, { totalMaxChars: 40 })
  const service = harness.services.get('promptInject')
  service.register({ id: 'keep', priority: 10, render: () => 'k'.repeat(30) })
  service.register({ id: 'drop', priority: 900, render: () => 'd'.repeat(30) })

  const out = await preStep(harness, { agent: { session: fakeSession() }, turn: 1, step: 1, signal: new AbortController().signal }, decision())
  assert.equal(out.messages[0].content[0].text, 'k'.repeat(30))
  assert.deepEqual(out.messages[0].source.sections.map((section) => section.name), ['keep'])
  assert.ok(harness.warnings.some((warning) => warning.includes('drop')))
})

test('a throwing slot is skipped and logged, not fatal', async () => {
  const harness = makeCtx()
  applySlot(harness.ctx, {})
  const service = harness.services.get('promptInject')
  service.register({ id: 'boom', priority: 10, render: () => { throw new Error('nope') } })
  service.register({ id: 'ok', priority: 20, render: () => 'fine' })

  const out = await preStep(harness, { agent: { session: fakeSession() }, turn: 1, step: 1, signal: new AbortController().signal }, decision())
  assert.equal(out.messages[0].content[0].text, 'fine')
  assert.ok(harness.warnings.some((warning) => warning.includes('boom')))
})

test('a slow slot times out without blocking the turn', async () => {
  const harness = makeCtx()
  applySlot(harness.ctx, {})
  harness.services.get('promptInject').register({
    id: 'slow',
    timeoutMs: 10,
    render: () => new Promise((resolve) => setTimeout(() => resolve('late'), 200)),
  })

  const out = await preStep(harness, { agent: { session: fakeSession() }, turn: 1, step: 1, signal: new AbortController().signal }, decision())
  assert.equal(out.messages.length, 1)
  assert.ok(harness.warnings.some((warning) => warning.includes('timed out')))
})

test('duplicate slot ids throw instead of shadowing', () => {
  const harness = makeCtx()
  applySlot(harness.ctx, {})
  const service = harness.services.get('promptInject')
  service.register({ id: 'same', render: () => 'a' })
  assert.throws(() => service.register({ id: 'same', render: () => 'b' }), /already registered/)
})

test('unregister removes a slot from later injections', async () => {
  const harness = makeCtx()
  applySlot(harness.ctx, {})
  const service = harness.services.get('promptInject')
  const dispose = service.register({ id: 'temp', render: () => 'temp body' })

  assert.equal(service.has('temp'), true)
  dispose()
  assert.equal(service.has('temp'), false)

  const out = await preStep(harness, { agent: { session: fakeSession() }, turn: 1, step: 1, signal: new AbortController().signal }, decision())
  assert.equal(out.messages.length, 1)
})

test('service list() is ordered and exposes no functions', () => {
  const harness = makeCtx()
  applySlot(harness.ctx, {})
  const service = harness.services.get('promptInject')
  service.register({ id: 'z', priority: 5, render: () => 'z' })
  service.register({ id: 'a', priority: 1, render: () => 'a' })

  const listed = service.list()
  assert.deepEqual(listed.map((entry) => entry.id), ['a', 'z'])
  assert.equal(listed[0].render, undefined)
})

test('null render output means "nothing this step"', async () => {
  const harness = makeCtx()
  applySlot(harness.ctx, {})
  harness.services.get('promptInject').register({ id: 'empty', render: () => null })

  const out = await preStep(harness, { agent: { session: fakeSession() }, turn: 1, step: 1, signal: new AbortController().signal }, decision())
  assert.equal(out.messages.length, 1)
})

test('no slots means no work', async () => {
  const harness = makeCtx()
  applySlot(harness.ctx, {})
  const out = await preStep(harness, { agent: { session: fakeSession() }, turn: 1, step: 1, signal: new AbortController().signal }, decision())
  assert.equal(out.messages.length, 1)
})

test('rejects an invalid configuration', () => {
  assert.throws(() => applySlot(makeCtx().ctx, { totalMaxChars: 0 }), /totalMaxChars must be/)
})

test('rejects an unknown placement', () => {
  const harness = makeCtx()
  applySlot(harness.ctx, {})
  assert.throws(
    () => harness.services.get('promptInject').register({ id: 'bad', placement: 'sideways', render: () => 'x' }),
    /placement must be/,
  )
})

test('registerBefore/registerAfter refuse a contradicting placement', () => {
  const harness = makeCtx()
  applySlot(harness.ctx, {})
  const service = harness.services.get('promptInject')
  assert.throws(() => service.registerAfter({ id: 'x', placement: 'before', render: () => 'x' }), /declares placement/)
  assert.throws(() => service.registerBefore({ id: 'y', placement: 'after', render: () => 'y' }), /declares placement/)
})

test('an already-provided service is reported, not thrown', () => {
  const harness = makeCtx()
  harness.ctx.provide('promptInject', { fake: true })
  applySlot(harness.ctx, {})
  assert.ok(harness.warnings.some((warning) => warning.includes('already owns ctx.promptInject')))
})

//#region request channel

/** Drive the registered `llm/stream` listener once and collect its chunks. */
async function streamOnce(harness, options, upstream = ['chunk']) {
  const entry = harness.listeners.find((listener) => listener.event === 'llm/stream')
  assert.ok(entry, 'llm/stream listener must be registered')
  const collected = []
  for await (const chunk of entry.handler(options, async function* () {
    yield* upstream
  })) {
    collected.push(chunk)
  }
  return collected
}

/** Build a fake `ctx.llm` that records the request it was asked to stream. */
function attachLlm(harness) {
  const calls = []
  harness.ctx.services = harness.ctx.services ?? new Map()
  harness.ctx.get = (serviceName) => (serviceName === 'llm' ? {
    stream: (request) => {
      calls.push(request)
      return (async function* () { yield 'rewritten' })()
    },
  } : undefined)
  return calls
}

test('the llm/stream listener is registered globally', () => {
  const harness = makeCtx()
  applySlot(harness.ctx, {})
  const entry = harness.listeners.find((listener) => listener.event === 'llm/stream')
  assert.ok(entry, 'request channel needs an llm/stream listener')
  assert.equal(entry.options?.global, true)
})

test('rejects an unknown channel', () => {
  const harness = makeCtx()
  applySlot(harness.ctx, {})
  assert.throws(
    () => harness.services.get('promptInject').register({ id: 'bad', channel: 'sideways', render: () => 'x' }),
    /channel must be/,
  )
})

test('a request slot never appends to the session history', async () => {
  const harness = makeCtx()
  applySlot(harness.ctx, {})
  harness.services.get('promptInject').register({ id: 'req', channel: 'request', render: () => 'recalled' })

  const out = await preStep(harness, { agent: { session: fakeSession() }, turn: 1, step: 1, signal: new AbortController().signal }, decision())
  assert.equal(out.messages.length, 1, 'pre-step must leave the decision untouched')
})

test('request text is woven in ahead of this turn user prompt', async () => {
  const harness = makeCtx()
  applySlot(harness.ctx, {})
  const calls = attachLlm(harness)
  harness.services.get('promptInject').register({ id: 'req', channel: 'request', render: () => 'recalled' })

  await preStep(harness, { agent: { session: fakeSession() }, turn: 1, step: 1, signal: new AbortController().signal }, decision())

  const request = {
    sessionId: 'session-1',
    messages: [
      { id: 'a', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'earlier' }] },
      { id: 'b', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'now' }] },
      { id: 'c', role: 'user', source: { kind: 'runtime-context' }, content: [{ type: 'text', text: 'facts' }] },
    ],
  }
  const chunks = await streamOnce(harness, request)
  assert.deepEqual(chunks, ['rewritten'], 'the rewritten request must be what gets streamed')
  assert.equal(calls.length, 1)

  const sent = calls[0].messages
  assert.equal(sent.length, 4)
  assert.equal(sent[1].content[0].text, 'recalled', 'block sits ahead of this turn user prompt')
  assert.equal(sent[1].id, undefined, 'request-only shape carries no id')
  assert.equal(sent[1].source, undefined, 'request-only shape carries no source')
  assert.equal(sent[2].content[0].text, 'now', 'the real prompt stays after the block')
  assert.equal(sent[3].content[0].text, 'facts', 'runtime-context stays last')
})

test('registerAfter on the request channel appends at the tail', async () => {
  const harness = makeCtx()
  applySlot(harness.ctx, {})
  const calls = attachLlm(harness)
  harness.services.get('promptInject').registerAfter({ id: 'req:tail', channel: 'request', render: () => 'tail' })

  await preStep(harness, { agent: { session: fakeSession() }, turn: 1, step: 1, signal: new AbortController().signal }, decision())

  const request = { sessionId: 'session-1', messages: [{ id: 'b', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'now' }] }] }
  await streamOnce(harness, request)

  const sent = calls[0].messages
  assert.equal(sent.length, 2)
  assert.equal(sent[1].content[0].text, 'tail')
  assert.equal(sent[0].content[0].text, 'now', 'an "after" block never moves the user prompt')
})

test('the block lands once per turn, not once per step', async () => {
  const harness = makeCtx()
  applySlot(harness.ctx, {})
  const calls = attachLlm(harness)
  harness.services.get('promptInject').register({ id: 'req', channel: 'request', render: () => 'once' })

  const payload = { agent: { session: fakeSession() }, turn: 1, step: 1, signal: new AbortController().signal }
  await preStep(harness, payload, decision())

  const request = { sessionId: 'session-1', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }
  await streamOnce(harness, request)
  await streamOnce(harness, request, ['passthrough'])

  assert.equal(calls.length, 1, 'only the first stream may be rewritten')
})

test('later steps of the same turn do not re-render', async () => {
  const harness = makeCtx()
  applySlot(harness.ctx, {})
  const calls = attachLlm(harness)
  let renders = 0
  harness.services.get('promptInject').register({ id: 'req', channel: 'request', render: () => { renders += 1; return 'x' } })

  await preStep(harness, { agent: { session: fakeSession() }, turn: 1, step: 1, signal: new AbortController().signal }, decision())
  await preStep(harness, { agent: { session: fakeSession() }, turn: 1, step: 2, signal: new AbortController().signal }, decision())
  assert.equal(renders, 1)
  assert.ok(calls.length === 0)
})

test('auxiliary calls that declare a purpose pass through untouched', async () => {
  const harness = makeCtx()
  applySlot(harness.ctx, {})
  const calls = attachLlm(harness)
  harness.services.get('promptInject').register({ id: 'req', channel: 'request', render: () => 'x' })
  await preStep(harness, { agent: { session: fakeSession() }, turn: 1, step: 1, signal: new AbortController().signal }, decision())

  const chunks = await streamOnce(harness, { sessionId: 'session-1', purpose: 'session-title', messages: [] }, ['upstream'])
  assert.deepEqual(chunks, ['upstream'])
  assert.equal(calls.length, 0)
})

test('a request already rewritten is not rewritten again', async () => {
  const harness = makeCtx()
  applySlot(harness.ctx, {})
  const calls = attachLlm(harness)
  harness.services.get('promptInject').register({ id: 'req', channel: 'request', render: () => 'x' })
  await preStep(harness, { agent: { session: fakeSession() }, turn: 1, step: 1, signal: new AbortController().signal }, decision())

  // The marker the plugin emits lacks both `id` and `source`, which is exactly
  // the request-only shape the loop itself never re-sends.
  const request = { sessionId: 'session-1', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }
  await streamOnce(harness, request)
  const sent = calls[0]
  await streamOnce(harness, sent, ['second-pass'])
  assert.equal(calls.length, 1, 're-entry must not recurse')
})

test('a failing render skips only its own slot', async () => {
  const harness = makeCtx()
  applySlot(harness.ctx, {})
  attachLlm(harness)
  const service = harness.services.get('promptInject')
  service.register({ id: 'broken', channel: 'request', render: () => { throw new Error('boom') } })
  service.register({ id: 'ok', priority: 200, channel: 'request', render: () => 'survivor' })

  const out = await preStep(harness, { agent: { session: fakeSession() }, turn: 1, step: 1, signal: new AbortController().signal }, decision())
  assert.equal(out.messages.length, 1)
  assert.ok(harness.warnings.some((warning) => warning.includes('broken')))
})

test('no pending request means the stream passes straight through', async () => {
  const harness = makeCtx()
  applySlot(harness.ctx, {})
  const calls = attachLlm(harness)
  harness.services.get('promptInject').register({ id: 'req', channel: 'request', render: () => 'x' })

  const chunks = await streamOnce(harness, { sessionId: 'other-session', messages: [] }, ['untouched'])
  assert.deepEqual(chunks, ['untouched'])
  assert.equal(calls.length, 0)
})

//#endregion

