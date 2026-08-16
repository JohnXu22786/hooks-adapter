import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { discoverFiles } from '../lib/discover.js'
import { loadRuntime } from '../lib/config.js'

function makeHome() {
  return mkdtempSync(join(tmpdir(), 'hooks-adapter-home-'))
}

function write(dir, rel, content) {
  const full = join(dir, ...rel.split('/'))
  mkdirSync(join(dir, ...rel.split('/').slice(0, -1)), { recursive: true })
  writeFileSync(full, typeof content === 'string' ? content : JSON.stringify(content))
  return full
}

test('discoverFiles finds the standard locations in precedence order', () => {
  const home = makeHome()
  const cwd = mkdtempSync(join(tmpdir(), 'hooks-adapter-cwd-'))
  write(home, '.claude/settings.json', {})
  write(cwd, '.claude/settings.local.json', {})
  const found = discoverFiles({ homeDir: home, cwd })
  assert.ok(found.some((f) => f.file.endsWith(join(home, '.claude', 'settings.json'))))
  assert.ok(found.some((f) => f.file.endsWith(join(cwd, '.claude', 'settings.local.json'))))
  // precedence: global claude before local claude
  const globalIdx = found.findIndex((f) => f.file.endsWith(join('.claude', 'settings.json')))
  const localIdx = found.findIndex((f) => f.file.includes('settings.local.json'))
  assert.ok(globalIdx < localIdx)
  // native project file appears once it exists
  assert.ok(!found.some((f) => f.file.endsWith('.dsh-hooks.json')))
  write(cwd, '.dsh-hooks.json', {})
  const found2 = discoverFiles({ homeDir: home, cwd })
  assert.ok(found2.some((f) => f.file.endsWith('.dsh-hooks.json')))
  rmSync(home, { recursive: true, force: true })
  rmSync(cwd, { recursive: true, force: true })
})

test('loadRuntime: precedence merges claude settings, later files append hooks', () => {
  const home = makeHome()
  const cwd = mkdtempSync(join(tmpdir(), 'hooks-adapter-cwd-'))
  write(home, '.claude/settings.json', {
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'global-guard' }] }] },
  })
  write(cwd, '.claude/settings.json', {
    hooks: {
      PreToolUse: [{ hooks: [{ type: 'command', command: 'project-guard' }] }],
      Stop: [{ hooks: [{ type: 'command', command: 'project-stop' }] }],
    },
  })
  write(cwd, '.claude/settings.local.json', {
    hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'local-guard' }] }] },
  })
  const runtime = loadRuntime({ homeDir: home, cwd })
  assert.deepEqual(runtime.diagnostics.filter((d) => d.severity === 'error'), [])
  const groups = runtime.groups.get('tool:before')
  assert.equal(groups.length, 3)
  assert.equal(groups[0].hooks[0].spec.command, 'global-guard')
  assert.equal(groups[1].hooks[0].spec.command, 'project-guard')
  assert.equal(groups[2].hooks[0].spec.command, 'local-guard')
  assert.equal(runtime.groups.get('turn:stop').length, 1)
  rmSync(home, { recursive: true, force: true })
  rmSync(cwd, { recursive: true, force: true })
})

test('loadRuntime: disableAllHooks wins from the most specific file', () => {
  const home = makeHome()
  const cwd = mkdtempSync(join(tmpdir(), 'hooks-adapter-cwd-'))
  write(home, '.claude/settings.json', {
    disableAllHooks: true,
    hooks: { Stop: [{ hooks: [{ type: 'command', command: 'global' }] }] },
  })
  write(cwd, '.claude/settings.json', {
    hooks: { Stop: [{ hooks: [{ type: 'command', command: 'project' }] }] },
  })
  // project does not disable -> global disable holds
  let r = loadRuntime({ homeDir: home, cwd })
  assert.equal(r.enabled, false)
  assert.equal(r.groups.size, 0)
  // local disables -> everything off
  write(cwd, '.claude/settings.local.json', { disableAllHooks: true })
  r = loadRuntime({ homeDir: home, cwd })
  assert.equal(r.enabled, false)
  // local explicitly re-enables -> project/global hooks run again
  write(cwd, '.claude/settings.local.json', { disableAllHooks: false })
  r = loadRuntime({ homeDir: home, cwd })
  assert.equal(r.enabled, true)
  assert.ok(r.groups.get('turn:stop').length > 0)
  rmSync(home, { recursive: true, force: true })
  rmSync(cwd, { recursive: true, force: true })
})

test('loadRuntime: explicit configPath overrides discovery', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'hooks-adapter-cwd-'))
  const path = write(cwd, 'hooks.json', {
    hooks: { Stop: [{ hooks: [{ type: 'command', command: 'pinned' }] }] },
  })
  const runtime = loadRuntime({ configPath: path, cwd, homeDir: cwd })
  assert.deepEqual(runtime.diagnostics.filter((d) => d.severity === 'error'), [])
  assert.equal(runtime.groups.get('turn:stop')[0].hooks[0].spec.command, 'pinned')
  assert.equal(runtime.sources.length, 1)
  assert.equal(runtime.sources[0].dialect, 'codex')
  rmSync(cwd, { recursive: true, force: true })
})

test('loadRuntime: missing files are tolerated silently, unreadable ones diagnosed', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'hooks-adapter-cwd-'))
  const runtime = loadRuntime({ cwd, homeDir: cwd })
  assert.equal(runtime.sources.length, 0)
  assert.equal(runtime.groups.size, 0)
  const path = write(cwd, '.claude/settings.json', 'not json at all')
  const broken = loadRuntime({ cwd, homeDir: cwd })
  assert.ok(broken.diagnostics.some((d) => d.severity === 'error' && d.file === path))
  rmSync(cwd, { recursive: true, force: true })
})

test('loadRuntime: HOOKS_ADAPTER_CONFIG env acts as configPath', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'hooks-adapter-cwd-'))
  const path = write(cwd, 'hooks.json', {
    hooks: { Stop: [{ hooks: [{ type: 'command', command: 'env-pinned' }] }] },
  })
  const old = process.env.HOOKS_ADAPTER_CONFIG
  process.env.HOOKS_ADAPTER_CONFIG = path
  try {
    const runtime = loadRuntime({ cwd, homeDir: cwd })
    assert.equal(runtime.groups.get('turn:stop')[0].hooks[0].spec.command, 'env-pinned')
    assert.equal(runtime.sources.length, 1)
  } finally {
    if (old === undefined) delete process.env.HOOKS_ADAPTER_CONFIG
    else process.env.HOOKS_ADAPTER_CONFIG = old
  }
  rmSync(cwd, { recursive: true, force: true })
})

test('loadRuntime: per-event groups are flattened with dialect tags', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'hooks-adapter-cwd-'))
  write(cwd, 'opencode.json', {
    hooks: { 'tool.execute.before': [{ matcher: 'bash', hooks: [{ type: 'command', command: 'oc' }] }] },
  })
  const runtime = loadRuntime({ cwd, homeDir: cwd })
  const groups = runtime.groups.get('tool:before')
  assert.equal(groups.length, 1)
  assert.equal(groups[0].dialect, 'opencode')
  assert.equal(groups[0].matcher, 'bash')
  rmSync(cwd, { recursive: true, force: true })
})
