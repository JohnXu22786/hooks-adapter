#!/usr/bin/env node
/**
 * 示例 hook 脚本：Bash 工具守卫。
 *
 * 从 stdin 读取 JSON 契约（PreToolUse），检查 tool_input.command 是否包含
 * 危险片段；命中则以退出码 2 拒绝（stderr 为原因）。
 *
 * 用法：在 hooks 配置中引用本文件，例如
 *   { "type": "command", "command": "node ./examples/hooks/guard-bash.mjs", "timeout": 10 }
 */
let data = ''
process.stdin.on('data', (chunk) => {
  data += chunk
})
process.stdin.on('end', () => {
  let input = {}
  try {
    input = JSON.parse(data)
  } catch {
    process.exit(0) // 载荷不可解析时放行
  }
  const command = String(input.tool_input?.command ?? '')
  const dangerous = /\brm\s+-rf\b|\bmv\s+\/\s|\bformat\s+[a-z]:\\|\bshutdown\b/i
  if (dangerous.test(command)) {
    process.stderr.write(`destructive command blocked: ${command.slice(0, 120)}`)
    process.exit(2)
  }
  process.exit(0)
})
