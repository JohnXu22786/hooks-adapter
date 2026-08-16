/**
 * The four handler executors: shell, webhook, oracle and proxy. Every
 * executor returns a decoded outcome plus a wall-clock duration; failures
 * (spawn errors, timeouts, bad responses, missing configuration) become
 * non-blocking error outcomes unless the hook's `onError` policy escalates
 * them to a denial.
 * @module hooks-adapter/execute
 */

import { spawn, spawnSync } from 'node:child_process'
import { decodeOutcome } from './contract.js'
import { expandEnv, silentLogger } from './util.js'

/** Reference default timeouts per handler kind, in seconds. */
export const DEFAULT_TIMEOUT_SEC = {
  shell: 600,
  webhook: 600,
  oracle: 30,
  proxy: 60,
}

/** The resolution of a timeout for one handler kind. */
function timeoutFor(runtime, hook) {
  const base = runtime.options.timeoutSec ?? DEFAULT_TIMEOUT_SEC[hook.kind]
  return (hook.timeoutSec ?? base) * 1000
}

/** Render `$ARGUMENTS` inside a prompt template. */
export function renderTemplate(template, payload) {
  return template.replaceAll('$ARGUMENTS', JSON.stringify(payload))
}

/**
 * Run one hook. Returns `{ outcome, durationMs, error }` where `error` is a
 * message when the run failed at the infrastructure level (never throws).
 */
export async function executeHook(runtime, hook, ctx) {
  const started = Date.now()
  const logger = runtime.logger ?? silentLogger
  let result
  let error
  try {
    if (hook.kind === 'shell') result = await runShell(runtime, hook, ctx)
    else if (hook.kind === 'webhook') result = await runWebhook(runtime, hook, ctx)
    else if (hook.kind === 'oracle') result = await runOracle(runtime, hook, ctx)
    else if (hook.kind === 'proxy') result = await runProxy(runtime, hook, ctx)
    else throw new Error(`unknown handler kind ${hook.kind}`)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    error = message
    result = { exitCode: undefined, stdout: '', stderr: message }
  }

  const outcome = decodeOutcome(result.exitCode, result.stdout, result.stderr, ctx.expectedEvent)
  const onError = hook.onError ?? runtime.options.onError ?? 'warn'
  if (error !== undefined && onError === 'block') {
    outcome.decision = 'deny'
    if (outcome.reason === undefined) outcome.reason = `hook failed: ${error}`
  }
  if (error !== undefined && onError === 'warn') {
    logger.warn(`hook ${hook.id} failed: ${error}`)
  } else if (error !== undefined && onError === 'ignore') {
    logger.debug(`hook ${hook.id} failed: ${error}`)
  } else if (error === undefined && outcome.exitCode !== undefined && outcome.exitCode !== 0 && outcome.exitCode !== 2) {
    // A non-blocking error exit is documented as logged; surface it.
    logger.warn(`hook ${hook.id} exited with code ${outcome.exitCode}: ${outcome.stderr.slice(0, 200)}`)
  }

  return { outcome, durationMs: Date.now() - started, error }
}

/** The cwd a handler runs in, and the env it sees. */
function runContext(runtime, hook, ctx) {
  const cwd = ctx.cwd ?? runtime.options.projectDir ?? process.cwd()
  const env = {
    ...process.env,
    ...(hook.env ?? {}),
    CLAUDE_PROJECT_DIR: runtime.options.projectDir ?? cwd,
  }
  return { cwd, env }
}

/** Spawn a shell command, feed the payload on stdin, capture output. */
function runShell(runtime, hook, ctx) {
  const { cwd, env } = runContext(runtime, hook, ctx)
  const timeoutMs = timeoutFor(runtime, hook)
  return spawnCapture(hook.spec.command, {
    cwd,
    env,
    stdin: JSON.stringify(ctx.payload) + '\n',
    timeoutMs,
    signal: ctx.signal,
    describe: `timed out after ${Math.round(timeoutMs / 1000)}s`,
  })
}

/** POST the payload to a webhook URL and decode the response body. */
async function runWebhook(runtime, hook, ctx) {
  const { url, headers = {} } = hook.spec
  const timeoutMs = timeoutFor(runtime, hook)
  const requestHeaders = {
    'content-type': 'application/json',
    ...Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, expandEnv(v)])),
  }
  const { signal, cleanup } = signalWithTimeout(timeoutMs, ctx.signal)
  let response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: requestHeaders,
      body: JSON.stringify(ctx.payload),
      signal,
    })
  } catch (err) {
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
      throw new Error(
        ctx.signal?.aborted === true
          ? `webhook ${url} aborted by the host`
          : `webhook ${url} timed out after ${Math.round(timeoutMs / 1000)}s`,
      )
    }
    throw err
  } finally {
    cleanup()
  }
  const body = await response.text()
  if (!response.ok) {
    throw new Error(`webhook ${url} answered HTTP ${response.status}: ${body.slice(0, 200)}`)
  }
  return { exitCode: 0, stdout: body, stderr: '' }
}

/** Ask a configured LLM endpoint (OpenAI-compatible) to evaluate. */
async function runOracle(runtime, hook, ctx) {
  const llm = runtime.options.llm
  if (!llm?.baseUrl || !llm?.model) {
    throw new Error('oracle handler: no LLM endpoint configured (set llm.baseUrl and llm.model)')
  }
  const prompt = renderTemplate(hook.spec.prompt, ctx.payload)
  const timeoutMs = timeoutFor(runtime, hook)
  const headers = { 'content-type': 'application/json' }
  if (llm.apiKey) headers.authorization = `Bearer ${llm.apiKey}`
  const { signal, cleanup } = signalWithTimeout(timeoutMs, ctx.signal)
  let response
  try {
    response = await fetch(`${llm.baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: llm.model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0,
      }),
      signal,
    })
  } catch (err) {
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
      throw new Error(
        ctx.signal?.aborted === true
          ? 'oracle request aborted by the host'
          : `oracle request timed out after ${Math.round(timeoutMs / 1000)}s`,
      )
    }
    throw err
  } finally {
    cleanup()
  }
  if (!response.ok) {
    const body = (await response.text()).slice(0, 200)
    throw new Error(`oracle endpoint answered HTTP ${response.status}: ${body}`)
  }
  const json = await response.json()
  const text = json?.choices?.[0]?.message?.content
  if (typeof text !== 'string') {
    throw new Error('oracle endpoint answered an unexpected response shape')
  }
  // The evaluation answer must itself be JSON: `{"ok": true|false, ...}`.
  const parsed = JSON.parse(text.trim())
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`oracle answer is not a JSON object: ${text.slice(0, 100)}`)
  }
  return { exitCode: 0, stdout: text, stderr: '' }
}

/** Delegate to a subagent runner command with the prompt. */
function runProxy(runtime, hook, ctx) {
  const command = hook.spec.command ?? runtime.options.proxy?.command
  if (!command) {
    throw new Error('proxy handler: no subagent runner configured (set proxy.command or a per-hook command)')
  }
  const prompt = renderTemplate(hook.spec.prompt, ctx.payload)
  const { cwd, env } = runContext(runtime, hook, ctx)
  const timeoutMs = timeoutFor(runtime, hook)
  return spawnCapture(command, {
    cwd,
    env: { ...env, HOOK_PROMPT: prompt },
    stdin: JSON.stringify({ ...ctx.payload, prompt }) + '\n',
    timeoutMs,
    signal: ctx.signal,
    describe: `timed out after ${Math.round(timeoutMs / 1000)}s`,
  })
}

/**
 * Combine a timeout with an optional external abort signal into one signal.
 * Returns `{ signal, cleanup }`; cleanup must run after the fetch settles.
 */
function signalWithTimeout(timeoutMs, external) {
  if (!external) return { signal: AbortSignal.timeout(timeoutMs), cleanup: () => {} }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const onExternal = () => controller.abort()
  external.addEventListener('abort', onExternal, { once: true })
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer)
      external.removeEventListener('abort', onExternal)
    },
  }
}

/**
 * Spawn a command (shell mode), feed stdin, capture stdout/stderr, enforce
 * the timeout with a hard kill of the whole process tree, and resolve with
 * `{ exitCode, stdout, stderr }`. Rejects only on infrastructure faults.
 */
function spawnCapture(command, { cwd, env, stdin, timeoutMs, signal, describe }) {
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(command, { shell: true, cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (err) {
      reject(err)
      return
    }
    let stdout = ''
    let stderr = ''
    let exitCode
    let settled = false

    const settle = (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (signal !== undefined) signal.removeEventListener('abort', onExternalAbort)
      if (err) reject(err)
      else resolve({ exitCode, stdout, stderr })
    }

    const timer = setTimeout(() => {
      killTree(child)
      settle(new Error(describe))
    }, timeoutMs)
    const onExternalAbort = () => {
      killTree(child)
      settle(new Error('hook aborted by the host'))
    }
    if (signal !== undefined) {
      if (signal.aborted) {
        onExternalAbort()
      } else {
        signal.addEventListener('abort', onExternalAbort, { once: true })
      }
    }

    child.stdout.on('data', (chunk) => (stdout += chunk))
    child.stderr.on('data', (chunk) => (stderr += chunk))
    child.on('error', (err) => settle(err))
    child.on('close', (code) => {
      exitCode = code
      settle()
    })

    // A child that exits before reading stdin makes the pipe fail
    // asynchronously (EOF/EPIPE); swallow it, matching the intent that a
    // quick exit is harmless.
    child.stdin.on('error', () => {})
    try {
      child.stdin.write(stdin)
    } catch {
      // the process may have exited before reading; harmless
    }
    try {
      child.stdin.end()
    } catch {
      // same
    }
  })
}

/**
 * Kill a hook process and its whole tree. With `shell: true` the direct
 * child is the command interpreter; a hook script's own children would
 * otherwise outlive it and hold the captured pipes open.
 */
function killTree(child) {
  if (child.pid === undefined) return
  if (child.exitCode !== null || child.signalCode !== null) return // already gone
  if (process.platform === 'win32') {
    try {
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    } catch {
      // fall through to the direct kill
    }
  } else {
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch {
      // no process group; fall through
    }
  }
  try {
    child.kill('SIGKILL')
  } catch {
    // already gone
  }
}
