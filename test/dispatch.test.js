import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadRuntime } from '../lib/config.js'
import { dispatchEvent } from '../lib/dispatch.js'

const here = dirname(fileURLToPath(import.meta.url))
const script = (name) => join(here, '..', 'test-support', 'scripts', name)

function makeProject(settings) {
  const dir = mkdtempSync(join(tmpdir(), 'hooks-adapter-dispatch-'))
  const claude = join(dir, '.claude')
  mkdirSync(claude, { recursive: true })
  writeFileSync(join(claude, 'settings.json'), JSON.stringify(settings))
  return dir
}

const settings = {
  hooks: {
    PreToolUse: [
      { matcher: 'Bash', hooks: [{ type: 'command', command: `node "${script('exit2.mjs')}"` }] },
      { matcher: 'Write', hooks: [{ type: 'command', command: `node "${script('exit3.mjs')}"` }] },
    ],
    SessionStart: [{ hooks: [{ type: 'command', command: `node "${script('echo-stdin.mjs')}"` }] }],
    Notification: [{ hooks: [{ type: 'command', command: `node "${script('exit2.mjs')}"` }] }],
  },
}

test('dispatch: matcher selects the group, exit 2 denies the tool', async () => {
  const dir = makeProject(settings)
  const runtime = loadRuntime({ cwd: dir, homeDir: dir })
  assert.deepEqual(runtime.diagnostics.filter((d) => d.severity === 'error'), [])
  const result = await dispatchEvent(runtime, 'PreToolUse', {
    session_id: 's1',
    cwd: dir,
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'rm -rf /' },
  })
  assert.equal(result.outcome.decision, 'deny')
  assert.equal(result.outcome.reason, 'blocked by hook')
  assert.equal(result.runs.length, 1)
  assert.equal(result.runs[0].hook.kind, 'shell')
  assert.equal(typeof result.runs[0].durationMs, 'number')
  rmSync(dir, { recursive: true, force: true })
})

test('dispatch: a non-blocking error from the only matched hook passes', async () => {
  const dir = makeProject(settings)
  const runtime = loadRuntime({ cwd: dir, homeDir: dir })
  const result = await dispatchEvent(runtime, 'PreToolUse', {
    session_id: 's1',
    cwd: dir,
    hook_event_name: 'PreToolUse',
    tool_name: 'Write',
  })
  assert.equal(result.outcome.decision, 'none')
  assert.equal(result.runs.length, 1)
  rmSync(dir, { recursive: true, force: true })
})

test('dispatch: no matching group runs nothing', async () => {
  const dir = makeProject(settings)
  const runtime = loadRuntime({ cwd: dir, homeDir: dir })
  const result = await dispatchEvent(runtime, 'PreToolUse', {
    session_id: 's1',
    cwd: dir,
    hook_event_name: 'PreToolUse',
    tool_name: 'Read',
  })
  assert.equal(result.outcome.decision, 'none')
  assert.equal(result.runs.length, 0)
  rmSync(dir, { recursive: true, force: true })
})

test('dispatch: denial on a non-blockable event is downgraded', async () => {
  const dir = makeProject(settings)
  const runtime = loadRuntime({ cwd: dir, homeDir: dir })
  const result = await dispatchEvent(runtime, 'Notification', {
    session_id: 's1',
    cwd: dir,
    hook_event_name: 'Notification',
  })
  assert.equal(result.outcome.decision, 'none')
  assert.equal(result.outcome.downgraded, true)
  assert.equal(result.outcome.rawDecision, 'deny')
  assert.equal(result.outcome.rawReason, 'blocked by hook')
  assert.equal(result.runs.length, 1)
  rmSync(dir, { recursive: true, force: true })
})

test('dispatch: PostToolUse and PostToolUseFailure stay mutually exclusive', async () => {
  const dir = makeProject({
    hooks: {
      PostToolUse: [{ hooks: [{ type: 'command', command: `node "${script('exit2.mjs')}"` }] }],
      PostToolUseFailure: [{ hooks: [{ type: 'command', command: `node "${script('exit3.mjs')}"` }] }],
    },
  })
  const runtime = loadRuntime({ cwd: dir, homeDir: dir })
  const success = await dispatchEvent(runtime, 'PostToolUse', {
    session_id: 's1',
    cwd: dir,
    hook_event_name: 'PostToolUse',
    tool_name: 'Bash',
  })
  assert.equal(success.runs.length, 1)
  assert.equal(success.runs[0].hook.event, 'PostToolUse')
  const failure = await dispatchEvent(runtime, 'PostToolUseFailure', {
    session_id: 's1',
    cwd: dir,
    hook_event_name: 'PostToolUseFailure',
    tool_name: 'Bash',
  })
  assert.equal(failure.runs.length, 1)
  assert.equal(failure.runs[0].hook.event, 'PostToolUseFailure')
  // the canonical spelling runs both
  const both = await dispatchEvent(runtime, 'tool:after', {
    session_id: 's1',
    cwd: dir,
    hook_event_name: 'tool:after',
    tool_name: 'Bash',
  })
  assert.equal(both.runs.length, 2)
  rmSync(dir, { recursive: true, force: true })
})

test('dispatch: plain stdout becomes context on session events', async () => {
  const dir = makeProject(settings)
  const runtime = loadRuntime({ cwd: dir, homeDir: dir })
  const result = await dispatchEvent(runtime, 'SessionStart', {
    session_id: 's1',
    cwd: dir,
    hook_event_name: 'SessionStart',
    source: 'new',
  })
  assert.equal(result.outcome.decision, 'none')
  assert.equal(result.outcome.contexts.length, 1)
  assert.ok(result.outcome.contexts[0].startsWith('got:{"session_id"'))
  rmSync(dir, { recursive: true, force: true })
})

test('dispatch: structured JSON context from a hook is folded in order', async () => {
  const dir = makeProject({
    hooks: {
      Stop: [
        {
          hooks: [
            { type: 'command', command: `node -e "process.stdout.write(JSON.stringify({additionalContext:'one'}))"` },
            { type: 'command', command: `node -e "process.stdout.write(JSON.stringify({additionalContext:'two'}))"` },
          ],
        },
      ],
    },
  })
  const runtime = loadRuntime({ cwd: dir, homeDir: dir })
  const result = await dispatchEvent(runtime, 'Stop', { session_id: 's1', cwd: dir, hook_event_name: 'Stop' })
  assert.deepEqual(result.outcome.contexts, ['one', 'two'])
  rmSync(dir, { recursive: true, force: true })
})

test('dispatch: canonical event names work against native configs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hooks-adapter-native-'))
  writeFileSync(
    join(dir, '.dsh-hooks.json'),
    JSON.stringify({
      events: {
        'tool:before': [{ matcher: 'bash', hooks: [{ type: 'shell', command: `node "${script('exit2.mjs')}"` }] }],
      },
    }),
  )
  const runtime = loadRuntime({ cwd: dir, homeDir: dir })
  const result = await dispatchEvent(runtime, 'tool:before', {
    session_id: 's1',
    cwd: dir,
    tool_name: 'bash',
  })
  assert.equal(result.outcome.decision, 'deny')
  rmSync(dir, { recursive: true, force: true })
})

test('dispatch: a canonical name runs every dialect group for that event', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hooks-adapter-canonical-'))
  mkdirSync(join(dir, '.claude'), { recursive: true })
  writeFileSync(
    join(dir, '.claude', 'settings.json'),
    JSON.stringify({
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: `node "${script('exit2.mjs')}"` }] }],
      },
    }),
  )
  writeFileSync(
    join(dir, '.dsh-hooks.json'),
    JSON.stringify({
      events: {
        'tool:before': [{ matcher: 'Bash', hooks: [{ type: 'shell', command: `node "${script('exit3.mjs')}"` }] }],
      },
    }),
  )
  const runtime = loadRuntime({ cwd: dir, homeDir: dir })
  // claude spelling
  const claude = await dispatchEvent(runtime, 'PreToolUse', {
    session_id: 's1',
    cwd: dir,
    tool_name: 'Bash',
  })
  assert.equal(claude.outcome.decision, 'deny')
  assert.equal(claude.runs.length, 2) // both dialects' groups ran
  // canonical spelling hits the same bucket
  const canonical = await dispatchEvent(runtime, 'tool:before', {
    session_id: 's1',
    cwd: dir,
    tool_name: 'Bash',
  })
  assert.equal(canonical.runs.length, 2)
  rmSync(dir, { recursive: true, force: true })
})

test('dispatch: updatedInput requests are surfaced with a warning', async () => {
  const dir = makeProject({
    hooks: {
      PreToolUse: [
        {
          matcher: 'Bash',
          hooks: [
            {
              type: 'command',
              command: `node -e "process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',updatedInput:{command:'safe'}}}))"`,
            },
          ],
        },
      ],
    },
  })
  const warnings = []
  const runtime = loadRuntime({
    cwd: dir,
    homeDir: dir,
    logger: { debug() {}, info() {}, warn: (...a) => warnings.push(a.join(' ')), error() {} },
  })
  const result = await dispatchEvent(runtime, 'PreToolUse', {
    session_id: 's1',
    cwd: dir,
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
  })
  assert.equal(result.outcome.decision, 'none')
  assert.equal(result.outcome.updateInputs.length, 1)
  assert.ok(warnings.some((w) => w.includes('updatedInput')))
  rmSync(dir, { recursive: true, force: true })
})

test('dispatch: onInvoke/onResult callbacks see each run', async () => {
  const dir = makeProject(settings)
  const runtime = loadRuntime({ cwd: dir, homeDir: dir })
  const invoked = []
  const results = []
  await dispatchEvent(runtime, 'PreToolUse', {
    session_id: 's1',
    cwd: dir,
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
  }, {
    onInvoke: (info) => invoked.push(info),
    onResult: (info) => results.push(info),
  })
  assert.equal(invoked.length, 1)
  assert.equal(invoked[0].hook.id, results[0].hook.id)
  assert.equal(results[0].outcome.decision, 'deny')
  rmSync(dir, { recursive: true, force: true })
})
