// Uses the same provider package as the web app; install both web and collab dependencies.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { Server } from '@hocuspocus/server'
import * as Y from 'yjs'
import { NoteHistory } from './note-history.js'
import { DatabaseExtension } from './extensions/database-extension.js'

const webRequire = createRequire(new URL('../../web/package.json', import.meta.url))
const { HocuspocusProvider } = webRequire('@hocuspocus/provider')

const until = async (predicate, message) => {
  const deadline = Date.now() + 8000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(message)
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

test('two real websocket clients: flush, restore, generation replacement, stale write fencing', { timeout: 20000 }, async t => {
  const note = { id: 'n', workspace_id: 'w', created_by: 'u', visibility: 'workspace', title: 'original', content: '', revision: 0, generation: 0 }
  const db = {
    findNote: async () => ({ ...note }),
    isWorkspaceMember: async () => true,
    updateNote: async (id, fields) => {
      if (fields.revision !== note.revision || fields.generation !== note.generation) throw Object.assign(new Error('stale'), { code: 10 })
      Object.assign(note, fields); note.revision++; return { revision: note.revision }
    },
    versionOperation: async req => {
      if (req.expected_revision !== note.revision) throw Object.assign(new Error('conflict'), { code: 10 })
      const backup = { ...note }
      note.title = 'original'; note.content = ''; note.revision++; note.generation++
      return { note: { ...note }, backup }
    },
  }
  const history = new NoteHistory(db)
  const server = new Server({ port: 0, address: '127.0.0.1', quiet: true,
    debounce: 20, maxDebounce: 100,
    async onConnect({ context }) { context.userId = 'u' },
    extensions: [history, new DatabaseExtension({ db, history })],
  })
  await server.listen()
  const port = server.httpServer.address().port
  const clients = []
  t.after(async () => {
    for (const client of clients) { client.provider.destroy(); client.doc.destroy() }
    await server.destroy()
  })
  const connect = generation => {
    const doc = new Y.Doc()
    const client = { doc, synced: false, replaced: false, ack: false }
    client.provider = new HocuspocusProvider({ url: `ws://127.0.0.1:${port}`, name: `note:n:${generation}`, document: doc,
      onSynced() { client.synced = true },
      onStateless({ payload }) {
        const message = JSON.parse(payload)
        if (message.type === 'note-replaced') client.replaced = true
        if (message.type === 'history-synced' && !message.error) client.ack = true
      },
    })
    clients.push(client)
    return client
  }
  const first = connect(0); const second = connect(0)
  await until(() => first.synced && second.synced, 'clients did not synchronize')
  first.doc.getMap('meta').set('title', 'collaborative edit')
  first.provider.sendStateless(JSON.stringify({ type: 'history-sync', id: 'barrier' }))
  await until(() => first.ack && second.doc.getMap('meta').get('title') === 'collaborative edit', 'flush or second client failed')
  assert.equal(note.title, 'collaborative edit')
  const result = await history.control(server.hocuspocus, 'restore', { note_id: 'n', expected_revision: note.revision, version_id: 'initial', operation_id: 'restore' })
  assert.equal(result.backup.title, 'collaborative edit')
  await until(() => first.replaced && second.replaced, 'restore was not broadcast to both clients')
  // A delayed edit from an old provider must never reach the authoritative note.
  second.doc.getMap('meta').set('title', 'late stale edit')
  first.provider.destroy(); second.provider.destroy()
  const fresh = connect(1)
  await until(() => fresh.synced, 'fresh generation did not synchronize')
  assert.equal(fresh.doc.getMap('meta').get('title'), 'original')
  assert.equal(note.title, 'original')
  fresh.doc.getMap('meta').set('title', 'after restore')
  fresh.provider.sendStateless(JSON.stringify({ type: 'history-sync', id: 'after' }))
  await until(() => fresh.ack, 'editing after restore failed')
  assert.equal(note.title, 'after restore')
})
