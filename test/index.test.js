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
  applySlot(harness.ctx, { position: 'before' })
  const service = harness.services.get('promptInject')
  service.register({ id: 'test:hello', render: () => 'slot body' })

  const base = decision()
  const out = await preStep(harness, { agent: { session: fakeSession() }, turn: 1, step: 1, signal: new AbortController().signal }, base)

  assert.equal(out.messages.length, 2)
  assert.equal(out.messages[0].source.kind, 'fgfg163-prompt-slot')
  assert.equal(out.messages[0].content[0].text, 'slot body')
  assert.equal(out.messages[1], base.messages[0])
})

test('position "after" appends behind existing messages', async () => {
  const harness = makeCtx()
  applySlot(harness.ctx, { position: 'after' })
  harness.services.get('promptInject').register({ id: 'test:hello', render: () => 'slot body' })

  const base = decision()
  const out = await preStep(harness, { agent: { session: fakeSession() }, turn: 1, step: 1, signal: new AbortController().signal }, base)

  assert.equal(out.messages[1].source.kind, 'fgfg163-prompt-slot')
  assert.equal(out.messages[0], base.messages[0])
})

test('runtime-context snapshots are not displaced from the anchor', async () => {
  const harness = makeCtx()
  applySlot(harness.ctx, { position: 'before' })
  harness.services.get('promptInject').register({ id: 'test:hello', render: () => 'slot body' })

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
  assert.throws(() => applySlot(makeCtx().ctx, { position: 'sideways' }), /position must be/)
  assert.throws(() => applySlot(makeCtx().ctx, { totalMaxChars: 0 }), /totalMaxChars must be/)
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

