const children = [
  Bun.spawn(['bun', '--watch', 'server.ts'], { stdout: 'inherit', stderr: 'inherit' }),
  Bun.spawn(['bun', 'node_modules/vite/bin/vite.js'], { stdout: 'inherit', stderr: 'inherit' }),
]
let stopping = false
function stop(code: number): void {
  if (stopping) return
  stopping = true
  for (const child of children) child.kill()
  process.exit(code)
}
process.on('SIGINT', () => stop(0))
process.on('SIGTERM', () => stop(0))
for (const child of children) {
  void child.exited.then((code) => stop(code || 1))
}
