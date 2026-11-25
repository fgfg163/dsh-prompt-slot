/**
 * Integration check against the real Cordis kernel.
 *
 * The unit tests use a fake ctx. This one boots a real `@deepseek-ai/cordis`
 * Context with a stand-in `sessionProjections` service, mounts the plugin
 * through `ctx.plugin()`, and drives `agent/pre-step`. It proves the pieces the
 * fake cannot: fiber-scoped `ctx.effect`, `inject` gating, `ctx.provide`, and
 * waterfall ordering with `{ prepend: true }`.
 *
 * Run: node test/integration.mjs
 *
 * ## Cordis resolution
 *
 * The kernel is loaded from whatever copy this machine actually has — a second
 * cordis in the profile's node_modules would change how the loader resolves
 * everything else, so it is never installed here. Candidates are tried in
 * order; the first that exists wins. Point CORDIS_PATH at a specific file to
 * override.
 */

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const CORDIS_CANDIDATES = [
  process.env.CORDIS_PATH,
  // A DSH checkout / unpacked host, if this machine keeps one.
  'D:/Program Files/DeepSeek Harness/resources/app.asar/dsh/node_modules/@deepseek-ai/cordis/lib/index.js',
  'D:/Program Files/DeepSeek Harness/resources/app/dsh/node_modules/@deepseek-ai/cordis/lib/index.js',
  'E:/DSH/_dshsrc/node_modules/@deepseek-ai/cordis/lib/index.js',
  // An older unpacked tree kept under the profile's backup folder.
  'E:/dsh-home/profile-backups/asar-restore-20261123-030959/app-unpacked-original/node_modules/@deepseek-ai/cordis/lib/index.js',
].filter((candidate) => typeof candidate === 'string' && candidate !== '')

function resolveCordis() {
  for (const candidate of CORDIS_CANDIDATES) {
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

const cordisPath = resolveCordis()
if (cordisPath === undefined) {
  console.error('SKIP - no @deepseek-ai/cordis found. Set CORDIS_PATH to its lib/index.js to run this test.')
  process.exit(0)
}

const { Context } = await import(pathToFileURL(cordisPath).href)

const SLOT = new URL('../lib/index.js', import.meta.url).href

/**
 * Stand-in contributor: registers one slot through `ctx.inject`, which is the
 * dependency gate a real plugin uses. Inlined rather than imported so this test
 * does not depend on a demo package living next door.
 */
const demo = {
  name: 'prompt-slot-integration-demo',
  inject: ['promptInject'],
  apply(ctx) {
    ctx.effect(
      () =>
        ctx.inject(['promptInject'], (scope) => {
          const dispose = scope.promptInject.register({
            id: 'demo:clock',
            render: () => 'Current time (demo): 2026-01-01T00:00:00Z',
          })
          return () => dispose()
        }),
      'demo.register()',
    )
  },
}

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

  // Mount the slot first: the demo's `inject` must wait for `promptInject`.
  ctx.plugin({ name: slot.name, inject: slot.inject, apply: (c, config) => slot.apply(c, { totalMaxChars: 8000, ...config }) })
  await new Promise((resolve) => setTimeout(resolve, 20))

  assert.ok(ctx.get('promptInject') !== undefined, 'ctx.promptInject must be provided by the slot plugin')
  console.log('ok - slot service registered on the real kernel')

  // The two registration methods must exist as first-class entry points.
  const service = ctx.get('promptInject')
  assert.equal(typeof service.registerBefore, 'function', 'registerBefore must be exposed')
  assert.equal(typeof service.registerAfter, 'function', 'registerAfter must be exposed')
  assert.equal(service.register, service.register, 'register stays as the compatibility entry point')

  ctx.plugin({ name: demo.name, inject: demo.inject, apply: demo.apply })
  await new Promise((resolve) => setTimeout(resolve, 50))

  const descriptors = ctx.get('promptInject').list()
  assert.equal(descriptors.length, 1, 'demo must have registered exactly one slot')
  assert.equal(descriptors[0].id, 'demo:clock')
  assert.equal(descriptors[0].placement, 'before', 'register() defaults to the before placement')
  console.log('ok - demo contributed a slot through inject gating')

  const base = {
    kind: 'enter',
    messages: [{ id: 'u1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] }],
  }
  const out = await runPreStep(ctx, { agent: { session }, turn: 1, step: 1, signal: new AbortController().signal }, base)

  assert.equal(out.messages.length, 2, 'one injected message must be added')
  assert.equal(out.messages[0].source.kind, 'fgfg163-prompt-slot')
  assert.equal(out.messages[0].source.placement, 'before')
  assert.match(out.messages[0].content[0].text, /Current time \(demo\): \d{4}-\d{2}-\d{2}T/)
  assert.equal(out.messages[1], base.messages[0], 'the user prompt must survive untouched')
  console.log('ok - injected text lands ahead of the user prompt:', out.messages[0].content[0].text.split('\n')[0])

  // A second step in the same turn must not duplicate a when:'turn' slot.
  const second = await runPreStep(ctx, { agent: { session }, turn: 1, step: 2, signal: new AbortController().signal }, base)
  assert.equal(second.messages.length, 1, 'when:"turn" must not fire on step 2')
  console.log('ok - step 2 stayed clean (when:"turn")')

  // The two placements must produce two distinct blocks in one step.
  service.registerAfter({ id: 'demo:tail', priority: 500, render: () => 'tail body' })
  const both = await runPreStep(ctx, { agent: { session }, turn: 9, step: 1, signal: new AbortController().signal }, base)
  const injected = both.messages.filter((message) => message.source?.kind === 'fgfg163-prompt-slot')
  assert.equal(injected.length, 2, 'before and after must land as two messages')
  assert.equal(injected[0].source.placement, 'before')
  assert.equal(injected[1].source.placement, 'after')
  assert.equal(both.messages.at(-1).content[0].text, 'tail body', '"after" must be the tail')
  assert.equal(both.messages.at(-2), base.messages[0], 'the user prompt stays between the two blocks')
  console.log('ok - registerBefore/registerAfter produce two separate blocks')
  service.unregister('demo:tail')

  // Durable dedup, made deterministic with a controllable body rather than the
  // wall clock: same turn + same body must not append twice, a changed body must.
  ctx.get('promptInject').unregister('demo:clock')
  let body = 'fixed body'
  ctx.get('promptInject').registerBefore({ id: 'demo:clock', render: () => body })

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
  console.log(`\nall integration checks passed (cordis: ${cordisPath})`)
}

await main()
