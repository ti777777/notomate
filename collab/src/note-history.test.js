import test from 'node:test'
import assert from 'node:assert/strict'
import * as Y from 'yjs'
import { NoteHistory } from './note-history.js'

async function setup() {
  const note = { id: 'n', workspace_id: 'w', created_by: 'u', visibility: 'workspace', title: 'initial', content: '', revision: 0, generation: 0 }
  const writes = []
  const operations = new Map()
  const db = {
    findNote: async () => ({ ...note }),
    isWorkspaceMember: async user => user === 'u',
    updateNote: async (id, fields) => {
      if (fields.revision !== note.revision || fields.generation !== note.generation) throw Object.assign(new Error('conflict'), { code: 10 })
      writes.push({ ...fields }); Object.assign(note, fields); note.revision++
      return { revision: note.revision }
    },
    versionOperation: async req => {
      if (operations.has(req.operation_id)) return operations.get(req.operation_id)
      if (req.version_id) {
        if (req.expected_revision !== note.revision) throw Object.assign(new Error('conflict'), { code: 10 })
        note.title = 'restored'; note.revision++; note.generation++
      }
      const result = { note: { ...note }, version: { title: note.title } }
      operations.set(req.operation_id, result)
      return result
    },
  }
  const history = new NoteHistory(db)
  const document = new Y.Doc()
  document.name = 'note:n:0'
  const messages = []
  document.broadcastStateless = message => messages.push(JSON.parse(message))
  await history.initialize(document, 'n')
  const instance = { documents: new Map([[document.name, document]]) }
  const edit = title => { document.getMap('meta').set('title', title); history.onChange({ document, context: { userId: 'u' } }) }
  return { history, document, db, note, writes, instance, edit, messages }
}

test('manual snapshot flushes room state and serializes concurrent persistence', async t => {
  const state = await setup(); t.after(() => state.document.destroy())
  state.edit('latest')
  const [snapshot] = await Promise.all([
    state.history.control(state.instance, 'snapshot', { note_id: 'n', operation_id: 'one' }),
    state.history.persist(state.document),
  ])
  assert.equal(snapshot.version.title, 'latest')
  assert.equal(state.writes.length, 1)
  assert.equal(state.note.revision, 1)
})

test('restore refuses confirmation made before another editor changed the room', async t => {
  const state = await setup(); t.after(() => state.document.destroy())
  const prepared = await state.history.control(state.instance, 'prepare', { note_id: 'n', workspace_id: 'w' })
  state.edit('concurrent edit')
  await assert.rejects(state.history.control(state.instance, 'restore', { note_id: 'n', version_id: 'old', expected_revision: prepared.revision, operation_id: 'restore' }), { code: 10 })
  assert.equal(state.note.title, 'concurrent edit')
  assert.equal(state.note.generation, 0)
  assert.equal(state.history.barriers.size, 0)
})

test('restore invalidates old room and rejects reconnecting stale generation', async t => {
  const state = await setup(); t.after(() => state.document.destroy())
  await state.history.control(state.instance, 'restore', { note_id: 'n', version_id: 'old', expected_revision: 0, operation_id: 'restore' })
  state.edit('late update')
  await state.history.persist(state.document)
  assert.equal(state.writes.length, 0)
  assert.equal(state.note.title, 'restored')
  assert.equal(state.messages[0].type, 'note-replaced')
  await assert.rejects(state.history.beforeHandleMessage({ document: state.document, documentName: state.document.name, connection: { context: { userId: 'u' } } }), /reconnect/)
  const stale = new Y.Doc(); stale.name = 'note:n:0'; t.after(() => stale.destroy())
  await assert.rejects(state.history.initialize(stale, 'n'), /Stale/)
})

test('failed database writes prevent a snapshot and can be retried', async t => {
  const state = await setup(); t.after(() => state.document.destroy())
  state.edit('pending')
  const update = state.db.updateNote
  state.db.updateNote = async () => { throw new Error('database unavailable') }
  await assert.rejects(state.history.control(state.instance, 'snapshot', { note_id: 'n', operation_id: 'retry' }), /unavailable/)
  assert.equal(state.messages.some(message => message.type === 'note-persisted'), false)
  assert.equal(state.history.barriers.size, 0)
  state.db.updateNote = update
  const result = await state.history.control(state.instance, 'snapshot', { note_id: 'n', operation_id: 'retry' })
  assert.equal(result.version.title, 'pending')
  assert.equal(state.messages.find(message => message.type === 'note-persisted').title, 'pending')
})

test('acknowledgement describes the committed snapshot, not newer in-flight edits', async t => {
  const state = await setup(); t.after(() => state.document.destroy())
  state.edit('committing')
  const update = state.db.updateNote
  state.db.updateNote = async (...args) => { state.edit('newer'); return update(...args) }
  await state.history.persist(state.document)
  assert.equal(state.messages[0].title, 'committing')
  assert.equal(state.document.getMap('meta').get('title'), 'newer')
  state.db.updateNote = update
  const replies = []
  await state.history.onStateless({ document: state.document, payload: JSON.stringify({type:'history-sync',id:'sync'}), connection: {sendStateless: value => replies.push(JSON.parse(value))} })
  assert.equal(replies[0].title, 'newer')
  assert.equal(replies[0].error, undefined)
  state.db.updateNote = async () => { throw new Error('offline') }
  state.edit('unsaved')
  await state.history.onStateless({ document: state.document, payload: JSON.stringify({type:'history-sync',id:'failed'}), connection: {sendStateless: value => replies.push(JSON.parse(value))} })
  assert.equal(replies[1].error, true)
})

test('private note access is limited to its creator', async t => {
  const state = await setup(); t.after(() => state.document.destroy())
  state.note.visibility = 'private'
  await assert.rejects(state.history.beforeHandleMessage({ document: state.document, documentName: state.document.name, connection: { context: { userId: 'other' } } }), /denied/)
})
