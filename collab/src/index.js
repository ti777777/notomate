import { NoteHistory, startHistoryControl } from './note-history.js'
import { Server } from '@hocuspocus/server'
import { DatabaseExtension } from './extensions/database-extension.js'
import { AuthExtension } from './extensions/auth-extension.js'
import { createGrpcClient } from './grpc/client.js'

const PORT = parseInt(process.env.PORT || '3000', 10)
const GRPC_ADDR = process.env.GRPC_ADDR || 'localhost:50051'

// Initialize gRPC client (replaces direct DB access)
const db = createGrpcClient(GRPC_ADDR)
const history = new NoteHistory(db)

// Configure Hocuspocus server
const server = new Server({
  port: PORT,
  extensions: [
    new AuthExtension({ db }),
    history,
    new DatabaseExtension({ db, history }),
  ],
  async onListen() {
  },
})

server.listen()
const controlServer = startHistoryControl(history, server.hocuspocus)
// REST/API edits also replace the authoritative generation, including idle rooms.
let checkingRooms = false
const roomCheck = setInterval(async () => {
  if (checkingRooms) return
  checkingRooms = true
  try {
    for (const doc of server.hocuspocus.documents.values()) {
      if (!doc.name.startsWith('note:')) continue
      const state = history.states.get(doc)
      if (!state || state.invalid) continue
      const note = await db.findNote(doc.name.split(':')[1])
      if (!note || note.generation !== state.generation) history.invalidate(doc)
      else await history.persist(doc)
    }
  } catch (err) { console.error('[Note history] room check failed:', err.message) }
  finally { checkingRooms = false }
}, 2000)

// Graceful shutdown
async function shutdown() {
  clearInterval(roomCheck)
  controlServer.close()
  await server.destroy()
  db.close()
  process.exit(0)
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
