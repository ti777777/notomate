import { useEffect, useRef, useState } from 'react'
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import axios from 'axios'
import { ArrowLeft, History, LoaderCircle, X } from 'lucide-react'
import { createNoteVersion, getNoteVersion, listNoteVersions, prepareNoteVersion, restoreNoteVersion } from '@/api/note-version'
import Renderer from '@/components/renderer/Renderer'

interface Props {
  workspaceId: string
  noteId: string
  currentTitle: string
  currentContent: string
  connected: boolean
  flush: () => Promise<void>
  onClose: () => void
  initialCreate?: boolean
}

const button = 'rounded-md border dark:border-neutral-700 px-3 py-2 text-sm hover:bg-neutral-100 dark:hover:bg-neutral-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap'

export default function NoteHistory({ workspaceId, noteId, currentTitle, currentContent, connected, flush, onClose, initialCreate }: Props) {
  const { t, i18n } = useTranslation()
  const queryClient = useQueryClient()
  const [selected, setSelected] = useState('')
  const [mobilePreview, setMobilePreview] = useState(false)
  const [creating, setCreating] = useState(!!initialCreate)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [confirmation, setConfirmation] = useState<{ revision: number; id: string; operation: string } | null>(null)
  const [manualOperation, setManualOperation] = useState(() => crypto.randomUUID())
  const closeRef = useRef<HTMLButtonElement>(null)
  const key = ['note-versions', workspaceId, noteId]
  const versions = useInfiniteQuery({ queryKey: key, initialPageParam: '',
    queryFn: ({ pageParam }) => listNoteVersions(workspaceId, noteId, pageParam),
    getNextPageParam: page => page.next_cursor || undefined })
  const detail = useQuery({ queryKey: [...key, selected], queryFn: () => getNoteVersion(workspaceId, noteId, selected), enabled: !!selected })

  useEffect(() => { closeRef.current?.focus() }, [])
  useEffect(() => {
    const handle = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) {
        if (confirmation) setConfirmation(null)
        else if (creating) setCreating(false)
        else onClose()
      }
    }
    window.addEventListener('keydown', handle)
    return () => window.removeEventListener('keydown', handle)
  }, [busy, confirmation, creating, onClose])

  const report = (err: unknown) => {
    if (axios.isAxiosError(err) && err.response?.status === 409) {
      setConfirmation(null); setError(t('history.conflict'))
    } else if (axios.isAxiosError(err) && [401, 403, 404].includes(err.response?.status || 0)) setError(t('history.denied'))
    else setError(t('history.failed'))
  }
  const create = async () => {
    setBusy(true); setError(''); setSuccess('')
    try {
      await flush()
      const result = await createNoteVersion(workspaceId, noteId, name, manualOperation)
      await queryClient.invalidateQueries({ queryKey: key })
      setSelected(result.version.id); setMobilePreview(true); setCreating(false); setName('')
      setManualOperation(crypto.randomUUID()); setSuccess(t('history.saved'))
    } catch (err) { report(err) } finally { setBusy(false) }
  }
  const prepare = async () => {
    setBusy(true); setError(''); setSuccess('')
    try {
      await flush()
      const current = await prepareNoteVersion(workspaceId, noteId)
      setConfirmation({ revision: current.revision, id: selected, operation: crypto.randomUUID() })
    } catch (err) { report(err) } finally { setBusy(false) }
  }
  const restore = async () => {
    if (!confirmation) return
    setBusy(true); setError('')
    try {
      await restoreNoteVersion(workspaceId, noteId, confirmation.id, confirmation.revision, confirmation.operation)
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: key }),
        queryClient.invalidateQueries({ queryKey: ['note', workspaceId, noteId] }),
        queryClient.invalidateQueries({ queryKey: ['notes', workspaceId] }),
      ])
      setConfirmation(null); setSelected(''); setSuccess(t('history.restored'))
    } catch (err) { report(err) } finally { setBusy(false) }
  }
  const date = (value: string) => new Date(value).toLocaleString(i18n.language)
  const entries = versions.data?.pages.flatMap(page => page.items) || []
  const content = selected ? detail.data?.content || '' : currentContent
  const title = selected ? detail.data?.title : currentTitle

  return <section className="flex min-h-0 min-w-0 flex-1 flex-col bg-white dark:bg-neutral-900" aria-label={t('history.title')}>
    <header className="flex shrink-0 items-center justify-between gap-2 border-b p-3 dark:border-neutral-700">
      <div className="flex min-w-0 items-center gap-2"><History size={18} /><h2 className="text-base font-medium">{t('history.title')}</h2></div>
      <button ref={closeRef} className={button} onClick={onClose} disabled={busy} aria-label={t('history.close')}><X size={18} /></button>
    </header>
    {(error || success) && <div className={`px-4 py-2 text-sm ${error ? 'text-red-600 dark:text-red-400' : 'text-muted-foreground'}`} role={error ? 'alert' : 'status'}>{error || success}</div>}
    <div className="flex min-h-0 flex-1">
      <main className={`${mobilePreview ? 'flex' : 'hidden'} min-w-0 flex-1 flex-col md:flex`}>
        <div className="flex items-center justify-between gap-2 border-b p-3 dark:border-neutral-700">
          <button className={`${button} md:hidden`} onClick={() => setMobilePreview(false)}><ArrowLeft size={16} /><span className="sr-only">{t('history.back')}</span></button>
          <p className="min-w-0 truncate text-sm text-muted-foreground">{selected && detail.data ? date(detail.data.created_at) : t('history.current')} · {t('history.readOnly')}</p>
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-4 lg:p-8">
          {selected && detail.isPending ? <p role="status">{t('history.loading')}</p> : selected && detail.isError ? <div role="alert"><p>{t('history.failed')}</p><button className={button} onClick={() => detail.refetch()}>{t('history.retry')}</button></div> :
            <article className="mx-auto max-w-3xl break-words"><h1 className="mb-6 text-xl font-semibold">{title || t('notes.untitled')}</h1><Renderer content={content || '{"type":"doc","content":[]}'} workspaceId={workspaceId} historyMode /></article>}
        </div>
        <footer className="shrink-0 border-t p-3 dark:border-neutral-700">
          {confirmation ? <div role="alertdialog" aria-label={t('history.restore')} aria-describedby="restore-description" className="space-y-3">
            <p id="restore-description" className="text-sm">{t('history.confirm', { date: detail.data ? date(detail.data.created_at) : '' })}</p>
            <div className="flex flex-wrap gap-2"><button className={button} onClick={restore} disabled={busy}>{t('history.confirmRestore')}</button><button className={button} disabled={busy} onClick={() => setConfirmation(null)}>{t('history.cancel')}</button></div>
          </div> : <button className={button} disabled={!selected || !detail.data || detail.isError || busy || !connected} onClick={prepare}>{t('history.restore')}</button>}
          {busy && <span role="status" className="ml-3 inline-flex gap-2 text-sm"><LoaderCircle size={16} className="animate-spin" />{t('history.working')}</span>}
        </footer>
      </main>
      <aside className={`${mobilePreview ? 'hidden' : 'flex'} w-full shrink-0 flex-col border-l dark:border-neutral-700 md:flex md:w-72`}>
        <div className="border-b p-3 dark:border-neutral-700">
          {creating ? <form onSubmit={event => { event.preventDefault(); void create() }} className="space-y-2">
            <label htmlFor="version-name" className="text-sm">{t('history.name')}</label>
            <input id="version-name" autoFocus maxLength={100} value={name} disabled={busy} onChange={event => { setName(event.target.value); setManualOperation(crypto.randomUUID()) }} className="w-full rounded border bg-transparent p-2 text-sm dark:border-neutral-600" placeholder={t('history.optionalName')} />
            <div className="flex gap-2"><button className={button} disabled={busy || !connected} type="submit">{t('history.save')}</button><button className={button} disabled={busy} type="button" onClick={() => setCreating(false)}>{t('history.cancel')}</button></div>
          </form> : <button className={`${button} w-full`} disabled={busy || !connected} onClick={() => setCreating(true)}>{t('history.create')}</button>}
          {!connected && <p className="mt-2 text-sm text-muted-foreground">{t('history.offline')}</p>}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-2" aria-label={t('history.versions')}>
          <button className={`mb-1 w-full rounded p-3 text-left text-sm ${!selected ? 'bg-neutral-100 dark:bg-neutral-800' : ''}`} disabled={busy} onClick={() => { setSelected(''); setConfirmation(null); setMobilePreview(true) }} aria-pressed={!selected}>{t('history.current')}</button>
          {entries.map(version => <button key={version.id} aria-pressed={selected === version.id} disabled={busy} className={`mb-1 w-full rounded p-3 text-left text-sm hover:bg-neutral-100 dark:hover:bg-neutral-800 ${selected === version.id ? 'bg-neutral-100 dark:bg-neutral-800' : ''}`} onClick={() => { setSelected(version.id); setConfirmation(null); setMobilePreview(true) }}>
            <span className="block truncate font-medium">{version.name || date(version.created_at)}</span>
            {version.name && <span className="block text-xs text-muted-foreground">{date(version.created_at)}</span>}
            <span className="mt-1 block text-xs text-muted-foreground">{t(`history.sources.${version.source}`)} · {version.created_by_name || version.created_by}</span>
          </button>)}
          {versions.isPending && <p className="p-3 text-sm" role="status">{t('history.loading')}</p>}
          {versions.isError && <div className="p-3 text-sm" role="alert"><p>{t('history.failed')}</p><button className={button} onClick={() => versions.refetch()}>{t('history.retry')}</button></div>}
          {!versions.isPending && !versions.isError && !entries.length && <p className="p-3 text-sm text-muted-foreground">{t('history.empty')}</p>}
          {versions.hasNextPage && <button className={`${button} w-full`} disabled={versions.isFetchingNextPage} onClick={() => versions.fetchNextPage()}>{t('history.more')}</button>}
        </div>
      </aside>
    </div>
  </section>
}
