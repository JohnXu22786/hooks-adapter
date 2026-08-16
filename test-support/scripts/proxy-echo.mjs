// Reads the payload from stdin and answers with the prompt field.
let data = ''
process.stdin.on('data', (chunk) => {
  data += chunk
})
process.stdin.on('end', () => {
  try {
    const payload = JSON.parse(data)
    process.stdout.write(`proxy:${payload.prompt ?? ''}|env:${process.env.HOOK_PROMPT ?? ''}`)
  } catch {
    process.stderr.write('proxy: bad stdin')
    process.exit(1)
  }
})
