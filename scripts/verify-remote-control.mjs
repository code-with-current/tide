// Verifies the exposed daemon: opens the WebSocket, performs the protocol
// hello handshake with the token, and prints the server's reply. Usage:
//   bun scripts/verify-remote-control.mjs [ws://host:port] [token]
const address = process.argv[2] ?? 'ws://127.0.0.1:34123'
const token = process.argv[3] ?? ''
const url = address.startsWith('ws') ? `${address}/v1` : `${address.replace(/\/$/, '')}/v1`

const socket = new WebSocket(url)
const timeout = setTimeout(() => {
  console.error('TIMEOUT: no hello reply within 5s')
  process.exit(1)
}, 5000)

socket.addEventListener('open', () => {
  socket.send(
    JSON.stringify({
      type: 'hello',
      protocolVersion: 7,
      token,
      clientId: crypto.randomUUID(),
      resumeFrom: [],
    }),
  )
})

socket.addEventListener('message', (event) => {
  clearTimeout(timeout)
  const message = JSON.parse(event.data)
  if (message.type === 'hello') {
    console.log('HANDSHAKE OK — daemon replied hello:', JSON.stringify(message).slice(0, 200))
  } else if (message.type === 'rejected') {
    console.error('REJECTED: bad token')
    process.exit(1)
  } else {
    console.log('unexpected first message:', message.type)
    process.exit(1)
  }
  socket.close()
  process.exit(0)
})

socket.addEventListener('error', (event) => {
  clearTimeout(timeout)
  console.error('CONNECT FAILED:', event.message ?? 'connection error')
  process.exit(1)
})
