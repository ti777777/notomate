import { createServer } from 'node:http'
import { timingSafeEqual } from 'node:crypto'

export const parseNoteName = (name) => {
  const [type, id, generation] = name.split(':')
  return type === 'note' ? { id, generation: generation === undefined ? null : Number(generation) } : null
}

// One coordinator per collab process. SQL revisions fence writes across processes/restarts.
export class NoteHistory {
  constructor(db) {
    this.db = db
    this.queues = new Map()
    this.barriers = new Map()
    this.states = new WeakMap()
  }

  async serial(id, action) {
    const previous = this.queues.get(id) || Promise.resolve()
    const pending = previous.catch(() => {}).then(action)
    this.queues.set(id, pending)
    try { return await pending } finally {
      if (this.queues.get(id) === pending) this.queues.delete(id)
    }
  }

  async initialize(document, id) {
    const note = await this.db.findNote(id)
    if (!note) throw new Error('Note not found')
    const room = parseNoteName(document.name)
    if (room.generation !== null && room.generation !== note.generation) throw new Error('Stale note room')
    document.transact(() => {
      document.getMap('content').set('data', note.content || '')
      document.getMap('meta').set('title', note.title || '')
    })
    this.states.set(document, { revision: note.revision, generation: note.generation, actor: null,
      saved: JSON.stringify([note.title || '', note.content || '']), invalid: false })
  }

  onChange({ document, context }) {
    const state = this.states.get(document)
    if (state && context?.userId) state.actor = context.userId
  }

  async beforeSync(data) {
    // Hocuspocus awaits this hook immediately before applying a Yjs update.
    await this.beforeHandleMessage(data)
  }

  async beforeHandleMessage({ document, documentName, connection }) {
    const room = parseNoteName(documentName)
    if (!room) return
    // Messages received during a snapshot wait; after restore they must rejoin a new generation.
    while (true) {
      await this.barriers.get(room.id)?.promise
      const note = await this.db.findNote(room.id)
      const state = this.states.get(document)
      if (!note || !state || state.invalid || state.generation !== note.generation) {
        this.invalidate(document)
        throw new Error('Note was replaced; reconnect with a fresh document')
      }
      const actor = connection.context?.userId
      const allowed = note.visibility === 'private' ? actor === note.created_by
        : actor && actor !== 'anonymous' && await this.db.isWorkspaceMember(actor, note.workspace_id)
      if (!allowed && !(connection.readOnly && note.visibility === 'public')) throw new Error('Access denied')
      if (state.invalid) throw new Error('Note was replaced; reconnect with a fresh document')
      if (!this.barriers.has(room.id)) return
    }
  }

  invalidate(document) {
    const state = this.states.get(document)
    if (state?.invalid) return
    if (state) state.invalid = true
    document.broadcastStateless(JSON.stringify({ type: 'note-replaced' }))
  }

  async persist(document) {
    const room = parseNoteName(document.name)
    return this.serial(room.id, () => this.flush(document, room.id))
  }

  async flush(document, id) {
    const state = this.states.get(document)
    if (!state || state.invalid) return
    const title = document.getMap('meta').get('title') || ''
    const content = document.getMap('content').get('data') || ''
    const serialized = JSON.stringify([title, content])
    if (serialized === state.saved) return
    if (!state.actor) throw new Error('Missing note editor identity')
    try {
      const result = await this.db.updateNote(id, { title, content, updated_by: state.actor,
        revision: state.revision, generation: state.generation })
      state.revision = result.revision
      state.saved = serialized
      document.broadcastStateless(JSON.stringify({ type: 'note-persisted', title, content,
        revision: state.revision, generation: state.generation }))
    } catch (err) {
      if (err.code === 10 || err.code === 7 || err.code === 5) this.invalidate(document)
      throw err
    }
  }

  // A stateless message is ordered after this client's preceding Yjs updates.
  async onStateless({ document, payload, connection }) {
    if (!parseNoteName(document.name)) return
    let message
    try { message = JSON.parse(payload) } catch { return }
    if (message.type !== 'history-sync') return
    try {
      await this.persist(document)
      const state = this.states.get(document)
      if (!state || state.invalid) throw new Error('Stale document')
      const [title, content] = JSON.parse(state.saved)
      connection.sendStateless(JSON.stringify({ type: 'history-synced', id: message.id,
        title, content, revision: state.revision, generation: state.generation }))
    } catch {
      connection.sendStateless(JSON.stringify({ type: 'history-synced', id: message.id, error: true }))
    }
  }

  async control(instance, action, request) {
    return this.serial(request.note_id, async () => {
      let release
      const promise = new Promise(resolve => { release = resolve })
      this.barriers.set(request.note_id, { promise })
      try {
        const documents = [...instance.documents.values()].filter(doc => parseNoteName(doc.name)?.id === request.note_id)
        for (const doc of documents) await this.flush(doc, request.note_id)
        if (action === 'prepare') {
          const note = await this.db.findNote(request.note_id)
          if (!note || note.workspace_id !== request.workspace_id) throw Object.assign(new Error('Note not found'), { code: 5 })
          return { revision: note.revision, generation: note.generation }
        }
        const result = await this.db.versionOperation(request)
        if (action === 'restore') for (const doc of documents) {
          const state = this.states.get(doc)
          if (state?.generation !== result.note.generation) this.invalidate(doc)
        }
        return result
      } finally {
        this.barriers.delete(request.note_id)
        release()
      }
    })
  }
}

export function startHistoryControl(history, instance) {
  const secret = Buffer.from(`Bearer ${process.env.APP_SECRET || 'default_secret'}`)
  const server = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json')
    const supplied = Buffer.from(req.headers.authorization || '')
    if (supplied.length !== secret.length || !timingSafeEqual(supplied, secret)) {
      res.writeHead(401).end(JSON.stringify({ message: 'Unauthorized' })); return
    }
    const action = req.url?.slice(1)
    if (req.method !== 'POST' || !['prepare', 'snapshot', 'restore'].includes(action)) { res.writeHead(404).end('{}'); return }
    try {
      let body = ''
      for await (const chunk of req) {
        body += chunk
        if (body.length > 8192) { res.writeHead(413).end('{}'); return }
      }
      const request = JSON.parse(body)
      if (!request.note_id || !request.workspace_id || !request.user_id || (action === 'restore' && !request.version_id)) {
        res.writeHead(400).end('{}'); return
      }
      const result = await history.control(instance, action, request)
      res.writeHead(200).end(JSON.stringify(result))
    } catch (error) {
      const code = ({ 10: 409, 7: 403, 5: 404, 3: 400 })[error.code] || 503
      console.error('[Note history] operation failed:', error.message)
      res.writeHead(code).end(JSON.stringify({ message: code === 409 ? 'Note changed; refresh and confirm again' : 'Version operation failed; retry' }))
    }
  })
  server.listen(Number(process.env.CONTROL_PORT || 3001), process.env.CONTROL_HOST || '127.0.0.1')
  return server
}
