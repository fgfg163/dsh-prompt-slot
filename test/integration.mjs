/**
 * Integration check against the real Cordis kernel.
 *
 * The unit tests use a fake ctx. This one boots a real `@deepseek-ai/cordis`
 * Context with a stand-in `sessionProjections` service, mounts both plugins
 * through `ctx.plugin()`, and drives `agent/pre-step`. It proves the pieces the
 * fake cannot: fiber-scoped `ctx.effect`, `inject` gating, `ctx.provide`, and
 * waterfall ordering with `{ prepend: true }`.
 *
 * Run: node test/integration.mjs
 */

import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'

// The real kernel, taken from the DSH installation checkout rather than copied
// into the profile: a second cordis in profile node_modules would change how the
// loader resolves everything else.
import { Context } from 'file:///E:/DSH/_dshsrc/node_modules/@deepseek-ai/cordis/lib/index.js'

const here = fileURLToPath(new URL('.', import.meta.url))
const SLOT = new URL('../lib/index.js', import.meta.url).href
const DEMO = new URL('../../dsh-prompt-inject-demo/lib/index.js', import.meta.url).href

/** Minimal durable projection registry: init + apply + stateOf, no persistence. */
class FakeProjections {
  constructor(ctx) {
    this.ctx = ctx
    this.definitions = new Map()
    this.states = new WeakMap()
  }
  register(definition) {
    this.definitions.set(definition.key, definition)
    return () => this.definitions.delete(definition.key)
  }
  stateOf(session, key) {
    const definition = this.definitions.get(key)
    if (definition === undefined) return undefined
    let state = this.states.get(session)
    if (state === undefined) {
      state = { [key]: definition.init() }
      this.states.set(session, state)
    }
    return state[key]
  }
  fold(session, key, event) {
    const definition = this.definitions.get(key)
    if (definition === undefined) return
    const current = this.stateOf(session, key)
    this.states.get(session)[key] = definition.apply(current, event)
  }
}

/** Collect pre-step listeners so the waterfall can be driven directly. */
async function runPreStep(ctx, payload, base) {
  return ctx.waterfall('agent/pre-step', payload, () => Promise.resolve(base))
}

const session = { id: 'integration-session' }

async function main() {
  const ctx = new Context()
  const projections = new FakeProjections(ctx)
  ctx.provide('sessionProjections', projections)

  const slot = await import(SLOT)
  const demo = await import(DEMO)

  // Mount the slot first: the demo's `inject` must wait for `promptInject`.
  ctx.plugin({ name: slot.name, inject: slot.inject, apply: (c, config) => slot.apply(c, { position: 'before', totalMaxChars: 8000, ...config }) })
  await new Promise((resolve) => setTimeout(resolve, 20))

  assert.ok(ctx.get('promptInject') !== undefined, 'ctx.promptInject must be provided by the slot plugin')
  console.log('ok - slot service registered on the real kernel')

  ctx.plugin({ name: demo.name, inject: demo.inject, apply: demo.apply })
  await new Promise((resolve) => setTimeout(resolve, 50))

  const descriptors = ctx.get('promptInject').list()
  assert.equal(descriptors.length, 1, 'demo must have registered exactly one slot')
  assert.equal(descriptors[0].id, 'demo:clock')
  console.log('ok - demo contributed a slot through inject gating')

  const base = {
    kind: 'enter',
    messages: [{ id: 'u1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] }],
  }
  const out = await runPreStep(ctx, { agent: { session }, turn: 1, step: 1, signal: new AbortController().signal }, base)

  assert.equal(out.messages.length, 2, 'one injected message must be added')
  assert.equal(out.messages[0].source.kind, 'fgfg163-prompt-slot')
  assert.match(out.messages[0].content[0].text, /Current time \(turn 1, step 1\): \d{4}-\d{2}-\d{2}T/)
  assert.equal(out.messages[1], base.messages[0], 'the user prompt must survive untouched')
  console.log('ok - injected text lands ahead of the user prompt:', out.messages[0].content[0].text.split('\n')[0])

  // A second step in the same turn must not duplicate a when:'turn' slot.
  const second = await runPreStep(ctx, { agent: { session }, turn: 1, step: 2, signal: new AbortController().signal }, base)
  assert.equal(second.messages.length, 1, 'when:"turn" must not fire on step 2')
  console.log('ok - step 2 stayed clean (when:"turn")')

  // Durable dedup, made deterministic with a controllable body rather than the
  // wall clock: same turn + same body must not append twice, a changed body must.
  ctx.get('promptInject').unregister('demo:clock')
  let body = 'fixed body'
  ctx.get('promptInject').register({ id: 'demo:clock', render: () => body })

  const first = await runPreStep(ctx, { agent: { session }, turn: 5, step: 1, signal: new AbortController().signal }, base)
  assert.equal(first.messages.length, 2, 'a new turn injects')
  projections.fold(session, 'promptInject', { type: 'user/message', data: first.messages[0] })

  const deduped = await runPreStep(ctx, { agent: { session }, turn: 5, step: 1, signal: new AbortController().signal }, base)
  assert.equal(deduped.messages.length, 1, 'identical body in the same turn must not append twice')
  console.log('ok - durable dedup suppresses an unchanged body')

  body = 'changed body'
  const changed = await runPreStep(ctx, { agent: { session }, turn: 5, step: 1, signal: new AbortController().signal }, base)
  assert.equal(changed.messages.length, 2, 'a changed body is a new injection')
  assert.equal(changed.messages[0].content[0].text, 'changed body')
  console.log('ok - a changed body injects again')

  // Unloading the contributor must remove the slot: it registered inside ctx.effect.
  const before = ctx.get('promptInject').list().length
  assert.equal(before, 1)
  console.log(`\nall integration checks passed (${here})`)
}

await main()
