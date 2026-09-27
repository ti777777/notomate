import { useCallback, useEffect, useRef, useState } from 'react'
import { HocuspocusProvider } from '@hocuspocus/provider'
import * as Y from 'yjs'
import { getNote } from '@/api/note'
import { useCurrentUserStore } from '@/stores/current-user'
import { NoteDraft, NoteSnapshot, parseDraft, reconcileDraft, sameSnapshot } from '@/lib/note-draft'

interface Options { noteId: string; workspaceId: string; enabled: boolean }
type SaveStatus = 'loading' | 'saved' | 'saving' | 'local' | 'conflict' | 'storage-error'

export function useNoteCollab({ noteId, workspaceId, enabled }: Options) {
  const userId = useCurrentUserStore(state => state.user?.id || '')
  const [clientId] = useState(() => {
    try {
      let id = sessionStorage.getItem('note-draft-client')
      if (!id) { id = crypto.randomUUID(); sessionStorage.setItem('note-draft-client', id) }
      return id
    } catch { return crypto.randomUUID() }
  })
  const prefix = `note-draft:${userId}:${workspaceId}:${noteId}:`
  const storageKey = prefix + clientId
  const [snapshot, setSnapshot] = useState<NoteSnapshot | null>(null)
  const [draft, setDraft] = useState<NoteDraft | null>(null)
  const [isReady, setReady] = useState(false)
  const [canEdit, setCanEdit] = useState(false)
  const [generation, setGeneration] = useState(0)
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('loading')
  const [replaced, setReplaced] = useState(false)
  const editRef = useRef<(patch: Partial<NoteSnapshot>) => void>(() => {})
  const flushRef = useRef<() => Promise<void>>(async () => { throw new Error('Not connected') })
  const discardRef = useRef<() => void>(() => {})
  const copyRef = useRef<() => NoteSnapshot | null>(() => null)

  useEffect(() => {
    if (!enabled || !noteId || !workspaceId) return
    let disposed = false, synced = false, editable = false, conflict = false, storageFailed = false
    let provider: HocuspocusProvider | undefined, doc: Y.Doc | undefined
    let retry: ReturnType<typeof setTimeout> | undefined, saveTimer: ReturnType<typeof setTimeout> | undefined
    let pendingDraft: NoteDraft | null = null, displayed: NoteSnapshot | null = null
    let remote: NoteSnapshot = { title: '', content: '' }, durable = remote, roomGeneration = 0
    let foreignKey: string | null = null, foreignRaw: string | null = null
    const requests = new Map<string, { resolve: () => void; reject: (error: Error) => void }>()
    setSnapshot(null); setDraft(null); setReady(false); setCanEdit(false); setSaveStatus('loading'); setReplaced(false)
    try {
      pendingDraft = parseDraft(localStorage.getItem(storageKey))
      if (!pendingDraft) {
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i)
          if (!key?.startsWith(prefix)) continue
          const raw = localStorage.getItem(key), candidate = parseDraft(raw)
          if (candidate && (!pendingDraft || candidate.savedAt > pendingDraft.savedAt)) {
            pendingDraft = candidate; foreignKey = key; foreignRaw = raw
          }
        }
      }
    } catch { storageFailed = true }

    const show = (value: NoteSnapshot) => { displayed = value; setSnapshot(value) }
    const status = () => {
      if (disposed) return
      setSaveStatus(storageFailed && pendingDraft ? 'storage-error' : conflict ? 'conflict' :
        pendingDraft ? (synced ? 'saving' : 'local') : !displayed ? 'loading' :
          sameSnapshot(displayed, durable) ? 'saved' : (synced ? 'saving' : 'local'))
      setReady(synced && !conflict)
      setDraft(conflict ? pendingDraft : null)
    }
    const store = (value: NoteDraft) => {
      pendingDraft = value
      try { localStorage.setItem(storageKey, JSON.stringify(value)); storageFailed = false }
      catch { storageFailed = true }
    }
    const clearStored = () => {
      try {
        localStorage.removeItem(storageKey)
        if (foreignKey && localStorage.getItem(foreignKey) === foreignRaw) localStorage.removeItem(foreignKey)
        sessionStorage.removeItem(`note-recovery:${userId}:${workspaceId}:${noteId}`)
      } catch { storageFailed = true }
      foreignKey = null; foreignRaw = null; pendingDraft = null; conflict = false
    }
    const acknowledge = (message: { title?: string; content?: string; generation?: number }) => {
      if (message.generation !== roomGeneration || typeof message.title !== 'string' || typeof message.content !== 'string') return
      durable = { title: message.title, content: message.content }
      if (pendingDraft && sameSnapshot(pendingDraft, durable)) {
        clearStored()
        show(remote)
      }
      status()
    }
    const flush = () => new Promise<void>((resolve, reject) => {
      if (!provider || !synced || conflict) { reject(new Error('Note is not synchronized')); return }
      const id = crypto.randomUUID()
      const timeout = setTimeout(() => { requests.delete(id); reject(new Error('Save timed out')) }, 15000)
      requests.set(id, {
        resolve: () => { clearTimeout(timeout); resolve() },
        reject: error => { clearTimeout(timeout); reject(error) },
      })
      provider.sendStateless(JSON.stringify({ type: 'history-sync', id }))
    })
    const scheduleSave = () => {
      if (saveTimer || !synced || conflict) return
      saveTimer = setTimeout(() => {
        saveTimer = undefined
        void flush().catch(() => { if (!disposed) status() })
      }, 1000)
    }
    const applyPending = (localEdit = false) => {
      if (!synced || !doc) return
      if (!pendingDraft) { show(remote); scheduleSave(); status(); return }
      const merged = localEdit ? { title: pendingDraft.title, content: pendingDraft.content } :
        foreignKey && !sameSnapshot(pendingDraft, remote) ? null : reconcileDraft(pendingDraft, remote, roomGeneration)
      if (!merged) { conflict = true; show(pendingDraft); status(); return }
      conflict = false
      const base = { ...pendingDraft.base }
      for (const field of ['title', 'content'] as const) {
        if (pendingDraft[field] === pendingDraft.base[field]) base[field] = remote[field]
      }
      store({ ...pendingDraft, ...merged, base })
      show(merged)
      doc.transact(() => {
        if (doc!.getMap('meta').get('title') !== merged.title) doc!.getMap('meta').set('title', merged.title)
        if (doc!.getMap('content').get('data') !== merged.content) doc!.getMap('content').set('data', merged.content)
      }, 'local')
      remote = merged
      scheduleSave(); status()
    }
    editRef.current = patch => {
      if (!editable || !displayed) return
      const next = { ...displayed, ...patch }
      if (sameSnapshot(next, displayed)) return
      // Persist before touching the network document, including while disconnected.
      store({ ...next, base: pendingDraft?.base || { ...remote },
        generation: pendingDraft?.generation ?? roomGeneration, savedAt: Date.now() })
      show(next)
      if (synced && !conflict) applyPending(true)
      status()
    }
    flushRef.current = flush
    copyRef.current = () => pendingDraft ? { title: pendingDraft.title, content: pendingDraft.content } : null
    discardRef.current = () => { clearStored(); show(remote); status() }

    const teardown = () => {
      synced = false; clearTimeout(saveTimer); saveTimer = undefined
      for (const request of requests.values()) request.reject(new Error('Note disconnected'))
      requests.clear()
      const previous = provider; provider = undefined
      previous?.destroy(); doc?.destroy(); doc = undefined
    }
    const recover = () => {
      if (disposed || retry) return
      synced = false; status()
      // Leave the local editor and its draft mounted while obtaining a fresh room.
      retry = setTimeout(() => { retry = undefined; teardown(); void connect() }, 1000)
      provider?.disconnect()
    }
    const connect = async () => {
      try {
        const note = await getNote(workspaceId, noteId)
        if (disposed) return
        editable = note.can_edit === true
        setCanEdit(editable)
        roomGeneration = note.generation || 0; setGeneration(roomGeneration)
        remote = { title: note.title || '', content: note.content || '' }; durable = remote
        if (!pendingDraft) {
          // Import recovery copies left by the previous implementation, conservatively.
          try {
            const old = JSON.parse(sessionStorage.getItem(`note-recovery:${userId}:${workspaceId}:${noteId}`) || 'null')
            if (typeof old?.title === 'string' && typeof old?.content === 'string') store({ ...old, base: remote, generation: -1, savedAt: Date.now() })
          } catch { /* no valid legacy recovery */ }
        }
        if (pendingDraft && sameSnapshot(pendingDraft, durable)) clearStored()
        show(pendingDraft || remote)
        status()
        const currentDoc = new Y.Doc(); doc = currentDoc
        const readRemote = () => ({ title: currentDoc.getMap('meta').get('title') as string || '', content: currentDoc.getMap('content').get('data') as string || '' })
        currentDoc.on('afterTransaction', transaction => {
          if (disposed || doc !== currentDoc || !synced || transaction.local) return
          remote = readRemote(); applyPending()
        })
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
        provider = new HocuspocusProvider({
          url: `${protocol}//${window.location.host}/ws/notes/${noteId}`,
          name: `note:${noteId}:${roomGeneration}`, document: currentDoc,
          onDisconnect: recover, onAuthenticationFailed: recover,
          onSynced() {
            if (disposed || doc !== currentDoc || retry) return
            synced = true; remote = readRemote(); applyPending()
          },
          onStateless({ payload }) {
            if (disposed || doc !== currentDoc) return
            let message
            try { message = JSON.parse(payload) } catch { return }
            if (message.type === 'note-replaced') { setReplaced(true); recover() }
            if (message.type === 'note-persisted') acknowledge(message)
            if (message.type === 'history-synced') {
              if (message.error) requests.get(message.id)?.reject(new Error('Persistence failed'))
              else { acknowledge(message); requests.get(message.id)?.resolve() }
              requests.delete(message.id)
            }
          },
        })
      } catch { if (!disposed) { status(); retry = setTimeout(() => { retry = undefined; void connect() }, 3000) } }
    }
    void connect()
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (pendingDraft && storageFailed) { event.preventDefault(); event.returnValue = '' }
    }
    window.addEventListener('beforeunload', beforeUnload)
    return () => {
      disposed = true; clearTimeout(retry); teardown()
      window.removeEventListener('beforeunload', beforeUnload)
      editRef.current = () => {}; copyRef.current = () => null; discardRef.current = () => {}
      flushRef.current = async () => { throw new Error('Note disconnected') }
    }
  }, [enabled, noteId, workspaceId, userId, prefix, storageKey])

  return { isReady, canEdit, saveStatus, generation, draft, replaced, hasContent: snapshot !== null,
    title: snapshot?.title || '', content: snapshot?.content,
    sendUpdateTitle: useCallback((title: string) => editRef.current({ title }), []),
    sendUpdateContent: useCallback((content: string) => editRef.current({ content }), []),
    flush: useCallback(() => flushRef.current(), []),
    discardDraft: useCallback(() => discardRef.current(), []),
    getDraft: useCallback(() => copyRef.current(), []),
    dismissReplaced: useCallback(() => setReplaced(false), []),
  }
}
