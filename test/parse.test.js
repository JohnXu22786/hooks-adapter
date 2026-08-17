import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { parseFile, parseConfigText, parseConfigObject } from '../lib/parse.js'

const here = dirname(fileURLToPath(import.meta.url))
const fixture = (name) => join(here, 'fixtures', name)
const parseRaw = (raw, dialect, vars = {}) => parseConfigObject(raw, dialect, vars)

test('claude dialect: settings.json parses all four handler kinds', () => {
  const { groups, diagnostics } = parseFile(fixture('claude-settings.json'), 'claude', {})
  assert.deepEqual(diagnostics.filter((d) => d.severity === 'error'), [])
  const pre = groups.filter((g) => g.event === 'PreToolUse')
  assert.equal(pre.length, 2)
  assert.equal(pre[0].matcher, 'Bash|Write')
  assert.deepEqual(
    pre[0].hooks.map((h) => h.kind),
    ['shell', 'oracle'],
  )
  assert.equal(pre[0].hooks[0].timeoutSec, 10)
  assert.equal(pre[0].hooks[1].timeoutSec, 30)
  assert.equal(pre[1].hooks[0].kind, 'webhook')
  assert.equal(pre[1].hooks[0].spec.url, 'https://example.invalid/hook')
  const stop = groups.find((g) => g.event === 'Stop')
  assert.deepEqual(
    stop.hooks.map((h) => h.kind),
    ['shell', 'proxy'],
  )
  assert.ok(stop.hooks[1].spec.prompt.includes('$ARGUMENTS'))
})

test('claude dialect: matcher on a subject-less event yields a warning, matcher dropped', () => {
  const { groups, diagnostics } = parseFile(fixture('claude-settings.json'), 'claude', {})
  const warning = diagnostics.find((d) => d.event === 'UserPromptSubmit')
  assert.ok(warning, 'warning for matcher on UserPromptSubmit')
  assert.equal(warning.severity, 'warning')
  const group = groups.find((g) => g.event === 'UserPromptSubmit')
  assert.equal(group.matcher, undefined)
})

test('claude dialect: unknown events are reported and skipped', () => {
  const { groups, diagnostics } = parseFile(fixture('claude-settings.json'), 'claude', {})
  assert.equal(groups.some((g) => g.event === 'UnknownEvent'), false)
  assert.ok(diagnostics.some((d) => d.message.includes('UnknownEvent')))
})

test('claude dialect: bad entries produce diagnostics instead of throwing', () => {
  const { groups, diagnostics } = parseRaw(
    {
      hooks: {
        PreToolUse: [
          'not-an-object',
          { matcher: 'Bash', hooks: [{ type: 'command' }, { type: 'warp', command: 'x' }, 42] },
        ],
        SessionStart: { not: 'an array' },
      },
    },
    'claude',
  )
  assert.equal(groups.length, 0)
  assert.ok(diagnostics.some((d) => d.message.includes('type "warp"')))
  assert.ok(diagnostics.some((d) => d.message.includes('command')))
})

test('codex dialect: hooks.json parses with regex matchers', () => {
  const { groups, diagnostics } = parseFile(fixture('codex-hooks.json'), 'codex', {})
  assert.deepEqual(diagnostics.filter((d) => d.severity === 'error'), [])
  assert.equal(groups.find((g) => g.event === 'PreToolUse').matcher, '^bash$')
  assert.equal(groups.find((g) => g.event === 'PreToolUse').hooks[0].timeoutSec, 9)
  assert.equal(groups.find((g) => g.event === 'Stop').matcher, undefined)
})

test('opencode dialect: dot-separated event names parse', () => {
  const { groups, diagnostics } = parseFile(fixture('opencode.json'), 'opencode', {})
  assert.deepEqual(diagnostics.filter((d) => d.severity === 'error'), [])
  const before = groups.find((g) => g.event === 'tool.execute.before')
  assert.equal(before.matcher, 'bash')
  assert.equal(before.hooks[0].kind, 'shell')
  const created = groups.find((g) => g.event === 'session.created')
  assert.equal(created.hooks[0].kind, 'proxy')
})

test('native dialect: canonical event keys and all four handler kinds', () => {
  const { groups, diagnostics } = parseFile(fixture('native.json'), 'native', {})
  assert.deepEqual(diagnostics.filter((d) => d.severity === 'error'), [])
  const byEvent = new Map(groups.map((g) => [g.event, g]))
  assert.equal(byEvent.get('tool:before').hooks[0].kind, 'shell')
  assert.equal(byEvent.get('tool:before').hooks[0].onError, 'block')
  assert.equal(byEvent.get('prompt:submit').hooks[0].kind, 'webhook')
  assert.deepEqual(byEvent.get('prompt:submit').hooks[0].spec.headers, { 'X-Token': '$API_TOKEN' })
  assert.equal(byEvent.get('session:start').hooks[0].kind, 'oracle')
  assert.equal(byEvent.get('turn:stop').hooks[0].kind, 'proxy')
})

test('native dialect: legacy type names are accepted as aliases', () => {
  const { groups, diagnostics } = parseRaw(
    {
      events: {
        'tool:before': [{ hooks: [{ type: 'command', command: 'a' }, { type: 'http', url: 'http://x' }] }],
        'prompt:submit': [{ hooks: [{ type: 'prompt', prompt: 'p' }, { type: 'subagent', prompt: 's' }] }],
      },
    },
    'native',
  )
  assert.deepEqual(diagnostics.filter((d) => d.severity === 'error'), [])
  assert.deepEqual(groups.flatMap((g) => g.hooks.map((h) => h.kind)), ['shell', 'webhook', 'oracle', 'proxy'])
})

test('substitution: project dir and plugin root tokens in commands', () => {
  const { groups } = parseRaw(
    {
      hooks: {
        SessionStart: [{ hooks: [{ type: 'command', command: 'cat ${CLAUDE_PROJECT_DIR}/a ${CLAUDE_PLUGIN_ROOT}/b' }] }],
      },
    },
    'claude',
    { projectDir: '/proj', pluginRoot: '/plug' },
  )
  assert.equal(groups[0].hooks[0].spec.command, 'cat /proj/a /plug/b')
})

test('substitution: unset token stays verbatim', () => {
  const { groups } = parseRaw(
    { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo ${CLAUDE_PROJECT_DIR}' }] }] } },
    'claude',
    {},
  )
  assert.equal(groups[0].hooks[0].spec.command, 'echo ${CLAUDE_PROJECT_DIR}')
})

test('malformed JSON text produces an error diagnostic, not a crash', () => {
  const { groups, diagnostics } = parseConfigText('{ not json', 'codex', {})
  assert.deepEqual(groups, [])
  assert.equal(diagnostics.length, 1)
  assert.equal(diagnostics[0].severity, 'error')
  assert.match(diagnostics[0].message, /JSON/)
})

test('timeout must be a positive number', () => {
  const { groups, diagnostics } = parseRaw(
    {
      hooks: {
        PreToolUse: [
          {
            hooks: [
              { type: 'command', command: 'a', timeout: -5 },
              { type: 'command', command: 'b', timeout: 'ten' },
            ],
          },
        ],
      },
    },
    'claude',
  )
  assert.equal(groups[0].hooks[0].timeoutSec, undefined)
  assert.equal(groups[0].hooks[1].timeoutSec, undefined)
  assert.equal(diagnostics.filter((d) => d.severity === 'error').length, 2)
})

test('bad onError values are diagnosed', () => {
  const { groups, diagnostics } = parseRaw(
    { events: { 'tool:before': [{ hooks: [{ type: 'shell', command: 'a', onError: 'explode' }] }] } },
    'native',
  )
  assert.equal(groups[0].hooks[0].onError, undefined)
  assert.ok(diagnostics.some((d) => d.message.includes('onError')))
})

test('headers and env must be string maps, otherwise diagnosed', () => {
  const { groups, diagnostics } = parseRaw(
    {
      events: {
        'tool:before': [
          {
            hooks: [
              { type: 'shell', command: 'a', env: { MODE: 1 } },
              { type: 'webhook', url: 'https://example.invalid/h', headers: { 'X-Token': null } },
            ],
          },
        ],
      },
    },
    'native',
  )
  // both hooks remain usable (only the malformed extra field is diagnosed)
  assert.equal(groups.length, 1)
  assert.equal(groups[0].hooks.length, 2)
  assert.equal(groups[0].hooks[0].env, undefined)
  assert.equal(groups[0].hooks[1].spec.headers, undefined)
  assert.ok(diagnostics.some((d) => d.message.includes('env must be a string map')))
  assert.ok(diagnostics.some((d) => d.message.includes('headers must be a string map')))
})

test('non-string matcher is an error, not a silent match-all', () => {
  const { groups, diagnostics } = parseRaw(
    { hooks: { PreToolUse: [{ matcher: 123, hooks: [{ type: 'command', command: 'a' }] }] } },
    'claude',
  )
  assert.equal(groups.length, 0)
  assert.ok(diagnostics.some((d) => d.message.includes('matcher must be a string')))
})

test('an empty hooks array is diagnosed', () => {
  const { groups, diagnostics } = parseRaw(
    { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [] }] } },
    'claude',
  )
  assert.equal(groups.length, 0)
  assert.ok(diagnostics.some((d) => d.message.includes('must not be empty')))
})

test('an "if" filter is surfaced as a warning, not silently ignored', () => {
  const { groups, diagnostics } = parseRaw(
    {
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'a', if: 'Bash(rm *)' }] }],
      },
    },
    'claude',
  )
  assert.equal(groups.length, 1)
  assert.ok(diagnostics.some((d) => d.severity === 'warning' && d.message.includes('"if"')))
})
