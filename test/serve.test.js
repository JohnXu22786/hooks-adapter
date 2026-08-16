import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import readline from 'node:readline'

const here = dirname(fileURLToPath(import.meta.url))
const cli = join(here, '..', 'lib', 'index.js')

/** Spawn the CLI in listen mode and drive it over stdio JSON lines. */
function startServe(args) {
  const child = spawn(process.execPath, [cli, 'listen', ...args], {
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd: process.cwd(),
  })
  const lines = readline.createInterface({ input: child.stdout })
  const pending = []
  const waiters = []
  lines.on('line', (line) => {
    if (waiters.length > 0) waiters.shift()(line)
    else pending.push(line)
  })
  let stderr = ''
  child.stderr.on('data', (c) => (stderr += c))
  const request = (obj) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no response; stderr: ${stderr}`)), 8000)
      waiters.push((line) => {
        clearTimeout(timer)
        resolve(JSON.parse(line))
      })
      child.stdin.write(JSON.stringify(obj) + '\n')
    })
  const close = () => {
    child.stdin.end()
    child.kill()
  }
  return { request, close }
}

test('serve: ping, dispatch and reload round-trip over stdio', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hooks-adapter-serve-'))
  mkdirSync(join(dir, '.claude'))
  const cfg = join(dir, '.claude', 'settings.json')
  writeFileSync(
    cfg,
    JSON.stringify({
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [{ type: 'command', command: `node -e "process.stderr.write('nope');process.exit(2)"` }],
          },
        ],
      },
    }),
  )
  const serve = startServe(['--config', cfg])
  try {
    const pong = await serve.request({ op: 'ping' })
    assert.equal(pong.ok, true)
    assert.equal(pong.pong, true)

    const allowed = await serve.request({
      op: 'dispatch',
      event: 'PreToolUse',
      payload: { session_id: 's1', cwd: dir, hook_event_name: 'PreToolUse', tool_name: 'Read' },
    })
    assert.equal(allowed.ok, true)
    assert.equal(allowed.outcome.decision, 'none')

    const denied = await serve.request({
      op: 'dispatch',
      event: 'PreToolUse',
      payload: { session_id: 's1', cwd: dir, hook_event_name: 'PreToolUse', tool_name: 'Bash' },
    })
    assert.equal(denied.ok, true)
    assert.equal(denied.outcome.decision, 'deny')
    assert.equal(denied.runs.length, 1)

    const reloaded = await serve.request({ op: 'reload' })
    assert.equal(reloaded.ok, true)
    assert.ok(Array.isArray(reloaded.diagnostics))
  } finally {
    serve.close()
  }
  rmSync(dir, { recursive: true, force: true })
})

test('serve: unknown op is answered with an error', async () => {
  const serve = startServe(['--home', mkdtempSync(join(tmpdir(), 'hooks-adapter-serve-'))])
  try {
    const res = await serve.request({ op: 'teleport' })
    assert.equal(res.ok, false)
    assert.match(res.error, /unknown op/i)
  } finally {
    serve.close()
  }
})

test('serve: dispatch with an unknown event is an error', async () => {
  const serve = startServe(['--home', mkdtempSync(join(tmpdir(), 'hooks-adapter-serve-'))])
  try {
    const res = await serve.request({ op: 'dispatch', event: 'WarpDrive', payload: {} })
    assert.equal(res.ok, false)
    assert.match(res.error, /WarpDrive/)
  } finally {
    serve.close()
  }
})
