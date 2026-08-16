import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { executeHook, DEFAULT_TIMEOUT_SEC } from '../lib/execute.js'
import { silentLogger } from '../lib/util.js'

const here = dirname(fileURLToPath(import.meta.url))
const script = (name) => join(here, '..', 'test-support', 'scripts', name)

/** A minimal runtime shape (as loadRuntime returns) for execute tests. */
function runtimeOptions(overrides = {}) {
  return {
    options: {
      llm: null,
      proxy: null,
      onError: 'warn',
      timeoutSec: undefined,
      projectDir: undefined,
      stderrCap: 500,
      ...overrides,
    },
    logger: silentLogger,
  }
}

const baseCtx = {
  payload: { session_id: 's1', cwd: '/w', hook_event_name: 'PreToolUse', tool_name: 'Bash' },
  cwd: undefined,
  expectedEvent: 'PreToolUse',
  env: {},
  signal: undefined,
}

/** Start a mock HTTP server; `handler` receives { method, url, headers, body } and returns { status, body }. */
async function mockServer(handler) {
  const sockets = new Set()
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      handler({ method: req.method, url: req.url, headers: req.headers, body })
        .then(({ status = 200, body: out = '' }) => {
          res.writeHead(status, { 'content-type': 'application/json' })
          res.end(typeof out === 'string' ? out : JSON.stringify(out))
        })
        .catch(() => {
          res.writeHead(500)
          res.end()
        })
    })
  })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.destroy()
        server.close(resolve)
      }),
  }
}

// --- shell handler ---

test('shell: payload arrives on stdin as JSON', async () => {
  const hook = { id: 't', kind: 'shell', spec: { command: `node "${script('echo-stdin.mjs')}"` }, onError: 'warn' }
  const { outcome } = await executeHook(runtimeOptions(), hook, baseCtx)
  assert.equal(outcome.exitCode, 0)
  // stdout is trimmed by the decoder; the echoed stdin proves the payload
  // reached the process as JSON (with the trailing newline stripped by trim).
  assert.equal(outcome.stdout, `got:${JSON.stringify(baseCtx.payload)}`)
})

test('shell: exit 2 blocks with stderr as reason', async () => {
  const hook = { id: 't', kind: 'shell', spec: { command: `node "${script('exit2.mjs')}"` }, onError: 'warn' }
  const { outcome } = await executeHook(runtimeOptions(), hook, baseCtx)
  assert.equal(outcome.decision, 'deny')
  assert.equal(outcome.reason, 'blocked by hook')
})

test('shell: exit 3 is a non-blocking error', async () => {
  const hook = { id: 't', kind: 'shell', spec: { command: `node "${script('exit3.mjs')}"` }, onError: 'warn' }
  const { outcome } = await executeHook(runtimeOptions(), hook, baseCtx)
  assert.equal(outcome.decision, undefined)
  assert.equal(outcome.stderr, 'boom')
})

test('shell: structured JSON on exit 0 controls the decision', async () => {
  const hook = { id: 't', kind: 'shell', spec: { command: `node "${script('structured.mjs')}"` }, onError: 'warn' }
  const { outcome } = await executeHook(runtimeOptions(), hook, baseCtx)
  assert.equal(outcome.decision, 'deny')
  assert.equal(outcome.reason, 'structured no')
})

test('shell: timeout kills the process and yields an error outcome', async () => {
  const hook = {
    id: 't',
    kind: 'shell',
    spec: { command: `node "${script('slow.mjs')}"` },
    onError: 'warn',
    timeoutSec: 1,
  }
  const started = Date.now()
  const { outcome, durationMs } = await executeHook(runtimeOptions(), hook, baseCtx)
  assert.equal(outcome.exitCode, undefined)
  assert.match(outcome.stderr, /timed out/i)
  assert.ok(durationMs < 5000)
  assert.ok(Date.now() - started < 5000)
})

test('shell: onError block escalates a timeout to a denial', async () => {
  const hook = {
    id: 't',
    kind: 'shell',
    spec: { command: `node "${script('slow.mjs')}"` },
    onError: 'block',
    timeoutSec: 1,
  }
  const { outcome } = await executeHook(runtimeOptions(), hook, baseCtx)
  assert.equal(outcome.decision, 'deny')
  assert.match(outcome.reason, /timed out/i)
})

test('shell: extra env from the hook spec reaches the process', async () => {
  const hook = {
    id: 't',
    kind: 'shell',
    spec: {
      command: `node -e "process.stdout.write(process.env.HOOK_SECRET ?? '')"`,
    },
    env: { HOOK_SECRET: 's3cret' },
    onError: 'warn',
  }
  const { outcome } = await executeHook(runtimeOptions(), hook, baseCtx)
  assert.equal(outcome.stdout, 's3cret')
})

// --- webhook handler ---

test('webhook: posts the payload and honors a JSON decision', async () => {
  let seen
  const server = await mockServer(async (req) => {
    seen = req
    return { body: { decision: 'block', reason: 'remote no' } }
  })
  const hook = { id: 't', kind: 'webhook', spec: { url: server.url, headers: {} }, onError: 'warn' }
  const { outcome } = await executeHook(runtimeOptions(), hook, baseCtx)
  assert.equal(seen.method, 'POST')
  assert.equal(seen.body, JSON.stringify(baseCtx.payload))
  assert.match(seen.headers['content-type'], /application\/json/)
  assert.equal(outcome.decision, 'deny')
  assert.equal(outcome.reason, 'remote no')
  await server.close()
})

test('webhook: continue:false from the body stops', async () => {
  const server = await mockServer(async () => ({ body: { continue: false, stopReason: 'enough' } }))
  const hook = { id: 't', kind: 'webhook', spec: { url: server.url, headers: {} }, onError: 'warn' }
  const { outcome } = await executeHook(runtimeOptions(), hook, baseCtx)
  assert.equal(outcome.stop, true)
  assert.equal(outcome.stopReason, 'enough')
  await server.close()
})

test('webhook: non-2xx response is a non-blocking error', async () => {
  const server = await mockServer(async () => ({ status: 500, body: 'internal' }))
  const hook = { id: 't', kind: 'webhook', spec: { url: server.url, headers: {} }, onError: 'warn' }
  const { outcome } = await executeHook(runtimeOptions(), hook, baseCtx)
  assert.equal(outcome.exitCode, undefined)
  assert.match(outcome.stderr, /500/)
  assert.equal(outcome.decision, undefined)
  await server.close()
})

test('webhook: timeout yields an error outcome', async () => {
  const server = await mockServer(async () => {
    await new Promise(() => {}) // never resolves
  })
  const hook = { id: 't', kind: 'webhook', spec: { url: server.url, headers: {} }, onError: 'warn', timeoutSec: 1 }
  const { outcome } = await executeHook(runtimeOptions(), hook, baseCtx)
  assert.equal(outcome.exitCode, undefined)
  assert.match(outcome.stderr, /timed out/i)
  await server.close()
})

test('webhook: $ENV tokens in headers are interpolated', async () => {
  const old = process.env.API_TOKEN
  process.env.API_TOKEN = 'tk-123'
  let seen
  const server = await mockServer(async (req) => {
    seen = req
    return {}
  })
  const hook = {
    id: 't',
    kind: 'webhook',
    spec: { url: server.url, headers: { 'X-Token': '$API_TOKEN' } },
    onError: 'warn',
  }
  await executeHook(runtimeOptions(), hook, baseCtx)
  assert.equal(seen.headers['x-token'], 'tk-123')
  if (old === undefined) delete process.env.API_TOKEN
  else process.env.API_TOKEN = old
  await server.close()
})

// --- oracle handler ---

test('oracle: $ARGUMENTS is interpolated and ok:false denies', async () => {
  let seenBody
  const server = await mockServer(async (req) => {
    seenBody = JSON.parse(req.body)
    return { body: { choices: [{ message: { content: JSON.stringify({ ok: false, reason: 'model refused' }) } }] } }
  })
  const options = runtimeOptions({ llm: { baseUrl: server.url, model: 'mock' } })
  const hook = {
    id: 't',
    kind: 'oracle',
    spec: { prompt: 'Evaluate $ARGUMENTS' },
    onError: 'warn',
    timeoutSec: 10,
  }
  const { outcome } = await executeHook(options, hook, baseCtx)
  assert.equal(seenBody.model, 'mock')
  assert.ok(seenBody.messages[0].content.includes('Evaluate'))
  assert.ok(seenBody.messages[0].content.includes('"session_id"'))
  assert.equal(outcome.decision, 'deny')
  assert.equal(outcome.reason, 'model refused')
  await server.close()
})

test('oracle: ok:true passes', async () => {
  const server = await mockServer(async () => ({
    body: { choices: [{ message: { content: JSON.stringify({ ok: true }) } }] },
  }))
  const options = runtimeOptions({ llm: { baseUrl: server.url, model: 'mock' } })
  const hook = { id: 't', kind: 'oracle', spec: { prompt: 'eval' }, onError: 'warn', timeoutSec: 10 }
  const { outcome } = await executeHook(options, hook, baseCtx)
  assert.equal(outcome.decision, undefined)
  await server.close()
})

test('oracle: no LLM configured is a friendly error outcome', async () => {
  const hook = { id: 't', kind: 'oracle', spec: { prompt: 'eval' }, onError: 'warn' }
  const { outcome, error } = await executeHook(runtimeOptions(), hook, baseCtx)
  assert.equal(outcome.exitCode, undefined)
  assert.match(outcome.stderr, /oracle/i)
  assert.ok(error)
})

test('oracle: non-JSON answer is an error outcome', async () => {
  const server = await mockServer(async () => ({
    body: { choices: [{ message: { content: 'just words' } }] },
  }))
  const options = runtimeOptions({ llm: { baseUrl: server.url, model: 'mock' } })
  const hook = { id: 't', kind: 'oracle', spec: { prompt: 'eval' }, onError: 'warn', timeoutSec: 10 }
  const { outcome } = await executeHook(options, hook, baseCtx)
  assert.equal(outcome.exitCode, undefined)
  assert.match(outcome.stderr, /JSON/i)
  await server.close()
})

// --- proxy handler ---

test('proxy: renders the prompt, passes it on stdin and via HOOK_PROMPT', async () => {
  const hook = {
    id: 't',
    kind: 'proxy',
    spec: { prompt: 'Summarize $ARGUMENTS', command: `node "${script('proxy-echo.mjs')}"` },
    onError: 'warn',
  }
  const { outcome } = await executeHook(runtimeOptions(), hook, baseCtx)
  assert.ok(outcome.stdout.startsWith('proxy:Summarize'))
  assert.ok(outcome.stdout.includes('"session_id"'))
  assert.ok(outcome.stdout.includes('|env:Summarize'))
  assert.equal(outcome.exitCode, 0)
})

test('proxy: no runner configured is a friendly error outcome', async () => {
  const hook = { id: 't', kind: 'proxy', spec: { prompt: 'summarize' }, onError: 'warn' }
  const { outcome, error } = await executeHook(runtimeOptions(), hook, baseCtx)
  assert.equal(outcome.exitCode, undefined)
  assert.match(outcome.stderr, /proxy/i)
  assert.ok(error)
})

test('proxy: falls back to the global runner command', async () => {
  const hook = { id: 't', kind: 'proxy', spec: { prompt: 'summarize' }, onError: 'warn' }
  const options = runtimeOptions({ proxy: { command: `node "${script('proxy-echo.mjs')}"` } })
  const { outcome } = await executeHook(options, hook, baseCtx)
  assert.equal(outcome.exitCode, 0)
  assert.ok(outcome.stdout.startsWith('proxy:summarize'))
})

test('default timeouts per kind', () => {
  assert.equal(DEFAULT_TIMEOUT_SEC.shell, 600)
  assert.equal(DEFAULT_TIMEOUT_SEC.webhook, 600)
  assert.equal(DEFAULT_TIMEOUT_SEC.oracle, 30)
  assert.equal(DEFAULT_TIMEOUT_SEC.proxy, 60)
})
