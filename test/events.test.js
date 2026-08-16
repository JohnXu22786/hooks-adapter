import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CANONICAL_EVENTS,
  EVENT_META,
  DIALECTS,
  canonicalFor,
  namesFor,
  resolveEventName,
  subjectFor,
  matches,
  matcherDiagnostic,
} from '../lib/events.js'

test('canonical event vocabulary is complete and ordered', () => {
  assert.deepEqual(CANONICAL_EVENTS, [
    'session:start',
    'session:end',
    'prompt:submit',
    'tool:before',
    'tool:after',
    'turn:stop',
    'subagent:start',
    'subagent:end',
    'notice',
    'compact:before',
  ])
  for (const name of CANONICAL_EVENTS) {
    const meta = EVENT_META[name]
    assert.ok(meta, `meta for ${name}`)
    assert.equal(typeof meta.blockable, 'boolean')
    assert.equal(typeof meta.contextFromStdout, 'boolean')
  }
})

test('every dialect maps canonical events, and names resolve back', () => {
  for (const [dialect, table] of Object.entries(DIALECTS)) {
    const names = Object.keys(table.events)
    for (const [name, canonical] of Object.entries(table.events)) {
      assert.equal(canonicalFor(dialect, name), canonical)
      assert.equal(resolveEventName(name).canonical, canonical)
      assert.ok(namesFor(dialect, canonical).includes(name))
    }
    // dialect names never collide with canonical names (except native, whose
    // event names are the canonical ones by design)
    if (dialect !== 'native') {
      for (const name of names) assert.equal(CANONICAL_EVENTS.includes(name), false)
    }
  }
  // claude, opencode and native cover every canonical event; codex lacks a
  // compaction event. claude carries one extra name (PostToolUseFailure also
  // maps onto tool:after).
  assert.equal(Object.keys(DIALECTS.claude.events).length, CANONICAL_EVENTS.length + 1)
  assert.equal(Object.keys(DIALECTS.opencode.events).length, CANONICAL_EVENTS.length)
  assert.equal(Object.keys(DIALECTS.native.events).length, CANONICAL_EVENTS.length)
  assert.equal(Object.keys(DIALECTS.codex.events).length, CANONICAL_EVENTS.length - 1)
  assert.equal(DIALECTS.claude.events.PostToolUse, 'tool:after')
  assert.equal(DIALECTS.claude.events.PostToolUseFailure, 'tool:after')
  assert.equal(DIALECTS.claude.events.PreCompact, 'compact:before')
  assert.equal(DIALECTS.opencode.events['experimental.session.compacting'], 'compact:before')
  assert.equal(DIALECTS.opencode.events['tool.execute.before.subagent'], 'subagent:start')
})

test('event blockability and context-from-stdout flags', () => {
  assert.equal(EVENT_META['tool:before'].blockable, true)
  assert.equal(EVENT_META['prompt:submit'].blockable, true)
  assert.equal(EVENT_META['turn:stop'].blockable, true)
  assert.equal(EVENT_META['notice'].blockable, false)
  assert.equal(EVENT_META['session:start'].blockable, false)
  assert.equal(EVENT_META['tool:after'].blockable, false)
  assert.equal(EVENT_META['session:start'].contextFromStdout, true)
  assert.equal(EVENT_META['prompt:submit'].contextFromStdout, true)
  assert.equal(EVENT_META['tool:before'].contextFromStdout, false)
})

test('dialect metadata: matcher modes and type aliases', () => {
  assert.equal(DIALECTS.claude.matcherMode, 'literal')
  assert.equal(DIALECTS.codex.matcherMode, 'regex')
  assert.equal(DIALECTS.opencode.matcherMode, 'regex')
  assert.equal(DIALECTS.native.matcherMode, 'literal')
  assert.equal(DIALECTS.claude.typeAliases.command, 'shell')
  assert.equal(DIALECTS.claude.typeAliases.http, 'webhook')
  assert.equal(DIALECTS.claude.typeAliases.prompt, 'oracle')
  assert.equal(DIALECTS.claude.typeAliases.agent, 'proxy')
  assert.equal(DIALECTS.native.typeAliases.shell, 'shell')
})

test('matcher: literal mode treats word|pipe patterns as exact alternation', () => {
  assert.equal(matches('Bash|Write', 'Bash', 'literal'), true)
  assert.equal(matches('Bash|Write', 'Write', 'literal'), true)
  assert.equal(matches('Bash|Write', 'bash', 'literal'), false)
  assert.equal(matches('Bash|Write', 'Read', 'literal'), false)
})

test('matcher: literal charset includes dash, comma and spaces', () => {
  assert.equal(matches('Edit, Write', 'Edit', 'literal'), true)
  assert.equal(matches('Edit, Write', 'Write', 'literal'), true)
  assert.equal(matches('Edit, Write', 'Read', 'literal'), false)
  assert.equal(matches('code-reviewer', 'code-reviewer', 'literal'), true)
  assert.equal(matches('code-reviewer', 'my-code-reviewer-tool', 'literal'), false)
  assert.equal(matcherDiagnostic('Edit, Write', 'literal'), undefined)
  assert.equal(matcherDiagnostic('code-reviewer', 'literal'), undefined)
})

test('matcher: literal mode accepts any string, including non-ASCII names', () => {
  assert.equal(matches('阅读', '阅读', 'literal'), true)
  assert.equal(matches('阅读', '写作', 'literal'), false)
  assert.equal(matcherDiagnostic('阅读', 'literal'), undefined)
  assert.equal(matcherDiagnostic('编辑, 阅读', 'literal'), undefined)
  assert.equal(matches('编辑, 阅读', '阅读', 'literal'), true)
})

test('matcher: regex mode applies unanchored patterns', () => {
  assert.equal(matches('^bash$', 'bash', 'regex'), true)
  assert.equal(matches('bash', 'my-bash-tool', 'regex'), true)
  assert.equal(matches('bash', 'Write', 'regex'), false)
})

test('matcher: match-all sentinels and invalid patterns', () => {
  for (const sentinel of [undefined, '', '*']) {
    assert.equal(matches(sentinel, 'anything', 'literal'), true)
    assert.equal(matches(sentinel, 'anything', 'regex'), true)
  }
  assert.equal(matches('(', 'x', 'regex'), false) // invalid regex never throws
  assert.equal(matches('(', 'x', 'literal'), false) // '(' is not word/pipe → regex path → invalid
  assert.equal(matcherDiagnostic('(', 'regex'), 'invalid regex matcher "("')
  assert.equal(matcherDiagnostic('Bash|Write', 'literal'), undefined)
  assert.equal(matcherDiagnostic('*', 'regex'), undefined)
})

test('subject derivation from payload', () => {
  assert.equal(subjectFor('tool:before', { tool_name: 'Bash' }), 'Bash')
  assert.equal(subjectFor('tool:before', { tool: 'bash' }), 'bash')
  assert.equal(subjectFor('tool:before', { name: 'Write' }), 'Write')
  assert.equal(subjectFor('tool:before', {}), '')
  assert.equal(subjectFor('session:start', { source: 'resume' }), 'resume')
})
