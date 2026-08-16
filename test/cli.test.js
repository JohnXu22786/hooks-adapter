import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const cli = join(here, '..', 'lib', 'index.js')

/** Run the CLI once; resolves with { code, stdout, stderr }. */
function runCli(args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (c) => (stdout += c))
    child.stderr.on('data', (c) => (stderr += c))
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}

function makeProject(hooks) {
  const dir = mkdtempSync(join(tmpdir(), 'hooks-adapter-cli-'))
  mkdirSync(join(dir, '.claude'))
  writeFileSync(join(dir, '.claude', 'settings.json'), JSON.stringify({ hooks }))
  return dir
}

test('cli: validate exits 0 on a clean project and reports problems otherwise', async () => {
  const clean = mkdtempSync(join(tmpdir(), 'hooks-adapter-clean-'))
  let r = await runCli(['validate', '--home', clean], clean)
  assert.equal(r.code, 0, r.stderr)

  const dir = makeProject({
    PreToolUse: [{ hooks: [{ type: 'command' }] }],
  })
  r = await runCli(['validate', '--home', dir], dir)
  assert.equal(r.code, 1)
  assert.ok(r.stderr.includes('missing command') || r.stdout.includes('missing command'))
  rmSync(dir, { recursive: true, force: true })
  rmSync(clean, { recursive: true, force: true })
})

test('cli: validate --json emits machine-readable diagnostics', async () => {
  const dir = makeProject({
    PreToolUse: [{ hooks: [{ type: 'command' }] }],
  })
  const r = await runCli(['validate', '--json', '--home', dir], dir)
  assert.equal(r.code, 1)
  const parsed = JSON.parse(r.stdout.trim().split('\n').pop())
  assert.ok(Array.isArray(parsed.diagnostics))
  assert.ok(parsed.diagnostics.length >= 1)
  assert.equal(parsed.diagnostics[0].severity, 'error')
  rmSync(dir, { recursive: true, force: true })
})

test('cli: run dispatches once and mirrors the hook decision in its exit code', async () => {
  const dir = makeProject({
    PreToolUse: [
      {
        matcher: 'Bash',
        hooks: [{ type: 'command', command: `node -e "process.stderr.write('no');process.exit(2)"` }],
      },
    ],
  })
  const payload = join(dir, 'payload.json')
  writeFileSync(
    payload,
    JSON.stringify({ session_id: 's1', cwd: dir, hook_event_name: 'PreToolUse', tool_name: 'Bash' }),
  )
  const blocked = await runCli(['run', '--event', 'PreToolUse', '--payload', payload, '--home', dir], dir)
  assert.equal(blocked.code, 2, blocked.stderr)
  const out = JSON.parse(blocked.stdout.trim().split('\n').pop())
  assert.equal(out.outcome.decision, 'deny')
  assert.equal(out.outcome.reason, 'no')

  writeFileSync(
    payload,
    JSON.stringify({ session_id: 's1', cwd: dir, hook_event_name: 'PreToolUse', tool_name: 'Read' }),
  )
  const allowed = await runCli(['run', '--event', 'PreToolUse', '--payload', payload, '--home', dir], dir)
  assert.equal(allowed.code, 0, allowed.stderr)
  rmSync(dir, { recursive: true, force: true })
})

test('cli: run with a missing payload file is an error', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hooks-adapter-cli-'))
  const r = await runCli(['run', '--event', 'PreToolUse', '--payload', join(dir, 'nope.json'), '--home', dir], dir)
  assert.equal(r.code, 1)
  assert.ok(r.stderr.includes('nope.json'))
  rmSync(dir, { recursive: true, force: true })
})

test('cli: invalid --timeout is rejected instead of producing NaN timeouts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hooks-adapter-cli-'))
  const r = await runCli(['validate', '--timeout', 'abc', '--home', dir], dir)
  assert.equal(r.code, 1)
  assert.ok(r.stderr.includes('--timeout'))
  rmSync(dir, { recursive: true, force: true })
})

test('cli: --llm-base-url requires --llm-model', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hooks-adapter-cli-'))
  const r = await runCli(['validate', '--llm-base-url', 'http://x', '--home', dir], dir)
  assert.equal(r.code, 1)
  assert.ok(r.stderr.includes('--llm-model'))
  rmSync(dir, { recursive: true, force: true })
})

test('cli: importing the module programmatically does not run the CLI', async () => {
  const entry = new URL('../lib/index.js', import.meta.url).href
  const script = `await import(${JSON.stringify(entry)}); console.log("imported-ok")`
  const r = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { cwd: process.cwd() })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (c) => (stdout += c))
    child.stderr.on('data', (c) => (stderr += c))
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
  assert.equal(r.code, 0, r.stderr)
  assert.ok(r.stdout.includes('imported-ok'))
  assert.ok(!r.stdout.includes('usage:'))
})

test('cli: dump prints the merged effective configuration', async () => {
  const dir = makeProject({
    Stop: [{ hooks: [{ type: 'command', command: 'echo done' }] }],
  })
  const r = await runCli(['dump', '--home', dir], dir)
  assert.equal(r.code, 0, r.stderr)
  const parsed = JSON.parse(r.stdout.trim().split('\n').pop())
  assert.equal(parsed.groups['turn:stop'].length, 1)
  assert.equal(parsed.groups['turn:stop'][0].hooks[0].spec.command, 'echo done')
  rmSync(dir, { recursive: true, force: true })
})
