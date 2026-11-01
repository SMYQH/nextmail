// Waits until the local dev server accepts connections on port 3000.
//
// Used by the "wait: dev server" task in tasks.json. The check lives in a file
// instead of an inline `node -e` one-liner so no shell has to quote characters
// such as `>` that the Windows command line would treat as a redirection.
//
// Usage: node .vscode/wait-for-dev-server.mjs [port] [timeoutMs]

import net from "node:net"

const port = Number(process.argv[2] ?? 3000)
const timeoutMs = Number(process.argv[3] ?? 120000)
const deadline = Date.now() + timeoutMs

function attempt() {
  const socket = net.connect(port, "127.0.0.1")
  socket.on("connect", () => {
    socket.end()
    console.log(`The dev server is listening on port ${port}.`)
    process.exit(0)
  })
  socket.on("error", () => {
    socket.destroy()
    if (Date.now() >= deadline) {
      console.error(`The dev server did not open port ${port} in time.`)
      process.exit(1)
    }
    setTimeout(attempt, 500)
  })
}

attempt()