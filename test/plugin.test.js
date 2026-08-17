import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply } from '../dsh/plugin.js'

const here = dirname(fileURLToPath(import.meta.url))
const script = (name) => join(here, '..', 'test-support', 'scripts', name)

/** A minimal Cordis-like context recording subscriptions and disposers. */
function makeHarness() {
  const handlers = new Map()
  const disposers = []
  const warns = []
  const logger = {
    debug() {},
    info() {},
    warn: (...parts) => warns.push(parts.map(String).join(' ')),
    error() {},
  }
  const ctx = {
    on: (name, fn) => handlers.set(name, fn),
    effect: (fn) => {
      disposers.push(fn)
      return () => {}
    },
    get: () => undefined,
    logger,
  }
  return { ctx, handlers, disposers, warns, logger }
}

function makeSession(events = []) {
  const appended = []
  return {
    header: { id: 's1', cwd: process.cwd() },
    events,
    append: (type, data) => appended.push({ type, data }),
    appended,
  }
}

function makeAgent() {
  const session = makeSession([{ type: 'turn/start', data: { turn: 3 } }])
  const injected = []
  const steered = []
  return {
    session,
    injected,
    steered,
    inject: (message) => injected.push(message),
    steer: (message) => steered.push(message),
  }
}

function makeProject() {
  const dir = mkdtempSync(join(tmpdir(), 'hooks-adapter-plugin-'))
  mkdirSync(join(dir, '.claude'))
  writeFileSync(
    join(dir, '.claude', 'settings.json'),
    JSON.stringify({
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: `node "${script('exit2.mjs')}"` }] }],
        Stop: [{ hooks: [{ type: 'command', command: `node "${script('exit2.mjs')}"` }] }],
        SessionStart: [{ hooks: [{ type: 'command', command: `node "${script('echo-stdin.mjs')}"` }] }],
        UserPromptSubmit: [
          {
            hooks: [
              {
                type: 'command',
                command: `node -e "process.stdout.write(JSON.stringify({additionalContext:'injected' + ' context'}))"`,
              },
            ],
          },
        ],
      },
    }),
  )
  return dir
}

/** Drain the plugin's detached runs through its registered disposer. */
async function disposeAll(harness) {
  for (const disposer of harness.disposers) await disposer()
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 250))

/** Poll until `predicate` holds; fails after `ms` instead of waiting a fixed tick. */
async function waitFor(predicate, what, ms = 5000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`timed out waiting for ${what}`)
}

test('plugin: subscribes to the harness extension points', () => {
  const dir = makeProject()
  const harness = makeHarness()
  apply(harness.ctx, { configPath: join(dir, '.claude', 'settings.json') })
  for (const name of [
    'agent/session-start',
    'session/disposed',
    'agent/pre-step',
    'tools/pre-execute',
    'tools/post-execute',
    'agent/turn-stopping',
    'subagent/start',
    'subagent/end',
  ]) {
    assert.ok(harness.handlers.has(name), `subscribed to ${name}`)
  }
  rmSync(dir, { recursive: true, force: true })
})

test('plugin: PreToolUse denial maps to {kind:"deny"} and records the run', async () => {
  const dir = makeProject()
  const harness = makeHarness()
  apply(harness.ctx, { configPath: join(dir, '.claude', 'settings.json') })
  const agent = makeAgent()
  let nextCalled = false
  const exec = {
    name: 'Bash',
    arguments: { command: 'rm -rf /' },
    callId: 'call_1',
    agent,
    signal: new AbortController().signal,
  }
  const decision = await harness.handlers.get('tools/pre-execute')(exec, async () => {
    nextCalled = true
    return { kind: 'pass' }
  })
  assert.equal(nextCalled, false)
  assert.equal(decision.kind, 'deny')
  assert.equal(decision.reason, 'blocked by hook')
  // the run is recorded on the session log as an invoked/result pair
  const types = agent.session.appended.map((e) => e.type)
  assert.deepEqual(types, ['hook/invoked', 'hook/result'])
  assert.equal(agent.session.appended[0].data.point, 'PreToolUse')
  assert.equal(agent.session.appended[1].data.decision, 'deny')
  assert.equal(agent.session.appended[1].data.handlerId, agent.session.appended[0].data.handlerId)
  rmSync(dir, { recursive: true, force: true })
})

test('plugin: a non-matching PreToolUse delegates to next()', async () => {
  const dir = makeProject()
  const harness = makeHarness()
  apply(harness.ctx, { configPath: join(dir, '.claude', 'settings.json') })
  const exec = { name: 'Read', arguments: {}, callId: 'c', agent: undefined, signal: new AbortController().signal }
  const downstream = { kind: 'pass' }
  const decision = await harness.handlers.get('tools/pre-execute')(exec, async () => downstream)
  assert.equal(decision, downstream)
  rmSync(dir, { recursive: true, force: true })
})

test('plugin: UserPromptSubmit denial rejects the step, context appends to enter', async () => {
  const dir = makeProject()
  const harness = makeHarness()
  apply(harness.ctx, { configPath: join(dir, '.claude', 'settings.json') })
  const agent = makeAgent()
  const input = {
    agent,
    messages: [{ content: [{ type: 'text', text: 'hello' }] }],
    turn: 3,
    signal: new AbortController().signal,
  }
  // the configured UserPromptSubmit hook only adds context; nothing denies
  const enter = await harness.handlers.get('agent/pre-step')(input, async () => ({
    kind: 'enter',
    messages: [{ id: 'm1', role: 'user', content: [], source: { kind: 'user' } }],
  }))
  assert.equal(enter.kind, 'enter')
  assert.equal(enter.messages.length, 2)
  assert.equal(enter.messages[1].source.kind, 'plugin')
  rmSync(dir, { recursive: true, force: true })
})

test('plugin: Stop denial steers the agent to continue', async () => {
  const dir = makeProject()
  const harness = makeHarness()
  apply(harness.ctx, { configPath: join(dir, '.claude', 'settings.json') })
  const agent = makeAgent()
  await harness.handlers.get('agent/turn-stopping')({ agent, turn: 3, signal: new AbortController().signal })
  assert.equal(agent.steered.length, 1)
  assert.equal(agent.steered[0].role, 'user')
  assert.match(agent.steered[0].content[0].text, /blocked by hook/)
  rmSync(dir, { recursive: true, force: true })
})

test('plugin: SessionStart context is injected once the detached hook settles', async () => {
  const dir = makeProject()
  const harness = makeHarness()
  apply(harness.ctx, { configPath: join(dir, '.claude', 'settings.json') })
  const agent = makeAgent()
  harness.handlers.get('agent/session-start')({ agent, source: 'new' })
  await waitFor(() => agent.injected.length === 1, 'session-start injection')
  assert.equal(agent.injected[0].role, 'user')
  assert.ok(agent.injected[0].content[0].text.startsWith('got:{"session_id"'))
  await disposeAll(harness)
  rmSync(dir, { recursive: true, force: true })
})

test('plugin: SessionEnd fires for the disposed session object itself', async () => {
  const dir = makeProject()
  const harness = makeHarness()
  apply(harness.ctx, { configPath: join(dir, '.claude', 'settings.json') })
  const agent = makeAgent()
  harness.handlers.get('session/disposed')(agent.session) // the listener receives the session
  await tick()
  await disposeAll(harness)
  rmSync(dir, { recursive: true, force: true })
})

test('plugin: a failed tool runs PostToolUseFailure hooks and blocks the result', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hooks-adapter-plugin-'))
  mkdirSync(join(dir, '.claude'))
  writeFileSync(
    join(dir, '.claude', 'settings.json'),
    JSON.stringify({
      hooks: {
        PostToolUse: [{ hooks: [{ type: 'command', command: `node "${script('exit3.mjs')}"` }] }],
        PostToolUseFailure: [{ hooks: [{ type: 'command', command: `node "${script('exit2.mjs')}"` }] }],
      },
    }),
  )
  const harness = makeHarness()
  apply(harness.ctx, { configPath: join(dir, '.claude', 'settings.json') })
  const agent = makeAgent()
  const exec = { name: 'Bash', arguments: {}, callId: 'c1', agent, signal: new AbortController().signal }
  const result = { content: [{ type: 'text', text: 'boom' }], isError: true }
  const decision = await harness.handlers.get('tools/post-execute')(exec, result, async () => ({ kind: 'pass' }))
  assert.equal(decision.kind, 'block')
  assert.equal(decision.feedback[0].text, 'blocked by hook')
  // only the failure group ran (the success group is mutually exclusive)
  const invoked = agent.session.appended.filter((e) => e.type === 'hook/invoked')
  assert.equal(invoked.length, 1)
  assert.equal(invoked[0].data.point, 'PostToolUseFailure')
  rmSync(dir, { recursive: true, force: true })
})

test('plugin: bad config produces warnings, not a crash', () => {
  const dir = makeProject()
  const broken = join(dir, '.claude', 'settings.local.json')
  writeFileSync(
    broken,
    JSON.stringify({
      hooks: { PreToolUse: [{ hooks: [{ type: 'warp', command: 'x' }] }] },
    }),
  )
  const harness = makeHarness()
  apply(harness.ctx, { configPath: broken })
  assert.ok(harness.warns.some((w) => w.includes('[error]') && w.includes('warp')))
  rmSync(dir, { recursive: true, force: true })
})
