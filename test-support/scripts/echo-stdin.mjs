// Echoes everything received on stdin as "got:<stdin>" on stdout.
let data = ''
process.stdin.on('data', (chunk) => {
  data += chunk
})
process.stdin.on('end', () => {
  process.stdout.write('got:' + data)
})
