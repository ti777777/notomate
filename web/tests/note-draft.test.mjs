import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseDraft, reconcileDraft } from '../src/lib/note-draft.ts'
const base = { title: 'title', content: 'original' }
const draft = { ...base, content: 'local', base, generation: 2, savedAt: 123 }
test('replay local edits when server is unchanged', () => {
  assert.deepEqual(reconcileDraft(draft, base, 2), { title: 'title', content: 'local' })
})
test('merge independent title and body edits', () => {
  assert.deepEqual(reconcileDraft(draft, { ...base, title: 'remote' }, 2), { title: 'remote', content: 'local' })
})
test('preserve competing body edits and generation changes for user review', () => {
  assert.equal(reconcileDraft(draft, { ...base, content: 'remote' }, 2), null)
  assert.equal(reconcileDraft(draft, base, 3), null)
  assert.deepEqual(reconcileDraft(draft, draft, 3), draft)
})
test('validate persisted recovery data', () => {
  assert.deepEqual(parseDraft(JSON.stringify(draft)), draft)
  for (const raw of [null, '{', '{}', JSON.stringify({ ...draft, base: null }), JSON.stringify({ ...draft, generation: 1.5 })]) assert.equal(parseDraft(raw), null)
})
