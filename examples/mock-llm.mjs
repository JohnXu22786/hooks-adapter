#!/usr/bin/env node
/**
 * 本地 mock LLM：OpenAI 兼容的 /v1/chat/completions 端点，用于离线验证
 * oracle handler 的接线、$ARGUMENTS 插值与决策折叠。
 *
 * 行为：提示词包含 "DENY" 时回答 {"ok":false,"reason":"mock denied"}，
 * 否则回答 {"ok":true}。可加 --deny-on 参数指定触发词。
 *
 * 用法：
 *   node examples/mock-llm.mjs --port 8765
 *   插件配置：llm: { baseUrl: "http://127.0.0.1:8765/v1", model: "mock" }
 */
import { createServer } from 'node:http'

const args = process.argv.slice(2)
const portIdx = args.indexOf('--port')
const port = portIdx !== -1 ? Number(args[portIdx + 1] ?? 8765) : 8765
const denyIdx = args.indexOf('--deny-on')
const denyOn = denyIdx !== -1 ? args[denyIdx + 1] ?? 'DENY' : 'DENY'

const server = createServer((req, res) => {
  if (req.method !== 'POST' || !req.url.endsWith('/chat/completions')) {
    res.writeHead(404)
    res.end('not found')
    return
  }
  let body = ''
  req.on('data', (chunk) => (body += chunk))
  req.on('end', () => {
    let prompt = ''
    try {
      prompt = JSON.parse(body).messages?.[0]?.content ?? ''
    } catch {
      // keep empty prompt
    }
    const denied = prompt.includes(denyOn)
    const answer = denied ? { ok: false, reason: 'mock denied' } : { ok: true }
    console.error(`[mock-llm] ${denied ? 'DENY ' : 'allow'} prompt=${prompt.slice(0, 80)}`)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(answer) } }] }))
  })
})

server.listen(port, '127.0.0.1', () => {
  console.error(`[mock-llm] listening on http://127.0.0.1:${port}/v1 (deny trigger: "${denyOn}")`)
})
