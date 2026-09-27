import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useNavigate, useParams } from "react-router-dom"
import useCurrentWorkspaceId from "@/hooks/use-currentworkspace-id"
import { useEffect, useRef, useState } from "react"
import { MessageCircle } from "lucide-react"
import { createNote, getNote, NoteData } from "@/api/note"
import NoteDetailView from "@/components/notedetail/NoteDetailView"
import { useNoteCollab } from "@/hooks/use-note-collab"
import NoteDetailMenu from "@/components/notedetailmenu/NoteDetailMenu"
import CommentSidebar from "@/components/commentsidebar/CommentSidebar"
import NoteHistory from '@/components/notehistory/NoteHistory'
import { useTranslation } from 'react-i18next'
import { useToastStore } from "@/stores/toast"
import { setLastNoteId } from "@/lib/recent-visits"

function recoveryText(title: string, content: string) {
    try {
        const text = (node: { text?: string; type?: string; content?: any[] }): string => node.text ??
            (node.content?.map(text).join(node.type === 'doc' ? '\n' : '') || '')
        return `${title}\n${text(JSON.parse(content))}`
    } catch { return `${title}\n${content}` }
}

const NoteDetailPage = () => {
    const [note, setNote] = useState<NoteData | null>(null)
    const { t } = useTranslation()
    const [history, setHistory] = useState<null | { create: boolean }>(null)
    const navigate = useNavigate()
    const draftDialog = useRef<HTMLDialogElement>(null)
    const { addToast } = useToastStore()
    const [copying, setCopying] = useState(false)
    const [copyError, setCopyError] = useState(false)
    const [showDraft, setShowDraft] = useState(false)
    const [showComments, setShowComments] = useState(false)
    const currentWorkspaceId = useCurrentWorkspaceId()
    const { noteId } = useParams()
    const queryClient = useQueryClient()

    // Connect to Hocuspocus for real-time collaboration
    const {
        isReady,
        title: wsTitle,
        sendUpdateTitle,
        content: liveContent, hasContent, canEdit, saveStatus, sendUpdateContent,
        flush, generation, draft, discardDraft, getDraft
    } = useNoteCollab({
        noteId: noteId || '',
        workspaceId: currentWorkspaceId || '',
        enabled: !!noteId && !!currentWorkspaceId
    })

    const hasConflict = !!draft
    useEffect(() => { if (hasConflict) setShowDraft(true) }, [hasConflict])
    useEffect(() => {
        if (showDraft && draft) draftDialog.current?.showModal()
        else draftDialog.current?.close()
    }, [showDraft, hasConflict])
    useEffect(() => {
        if (saveStatus === 'storage-error') addToast({ title: t('history.saveStatus.storage-error'), type: 'error' })
    }, [saveStatus, addToast, t])

    // Always fetch note metadata from REST API
    // gcTime: 0 ensures stale content is not shown when navigating back to a note,
    // since content is the source of truth in Y.js (not the REST API snapshot).
    const { data: fetchedNote } = useQuery({
        queryKey: ['note', currentWorkspaceId, noteId],
        queryFn: () => getNote(currentWorkspaceId, noteId!),
        enabled: !!noteId && !!currentWorkspaceId,
        gcTime: 0,
    })

    // Reset note when navigating to a different note to avoid showing stale content
    useEffect(() => {
        setNote(null)
        setHistory(null)
        setShowDraft(false)
    }, [noteId])

    useEffect(() => {
        if (noteId && currentWorkspaceId) setLastNoteId(currentWorkspaceId, noteId)
    }, [noteId, currentWorkspaceId])

    useEffect(() => {
        if (fetchedNote) {
            setNote(fetchedNote)
        }
    }, [fetchedNote])

    // Track current noteId in a ref so the wsTitle sync effect can read it
    // without taking noteId as a dependency (prevents stale-title cross-note pollution)
    const noteIdRef = useRef(noteId ?? '')
    useEffect(() => {
        noteIdRef.current = noteId ?? ''
    }, [noteId])

    // Sync WebSocket title changes back into React Query cache.
    // noteId is intentionally read from a ref (not a dep) so this effect only fires
    // when wsTitle itself changes — not when noteId changes. Without this, navigating
    // away from a titled note would momentarily write the old title into the new note's
    // cache entry before the WS cleanup resets wsTitle to ''.
    useEffect(() => {
        if (!isReady || !currentWorkspaceId) return
        const currentNoteId = noteIdRef.current
        if (!currentNoteId) return

        queryClient.setQueryData(['note', currentWorkspaceId, currentNoteId], (old: NoteData | undefined) => {
            if (!old) return old
            return { ...old, title: wsTitle }
        })

        queryClient.setQueriesData(
            { queryKey: ['notes', currentWorkspaceId], exact: false },
            (old: any) => {
                if (!old?.pages) return old
                return {
                    ...old,
                    pages: old.pages.map((page: NoteData[]) =>
                        page.map((n: NoteData) => n.id === currentNoteId ? { ...n, title: wsTitle } : n)
                    )
                }
            }
        )
    }, [wsTitle, currentWorkspaceId, queryClient])

    const copyDraft = async () => {
        const copy = getDraft()
        if (!copy) return
        setCopying(true); setCopyError(false)
        try {
            const created = await createNote(currentWorkspaceId, { ...copy, visibility: 'private' })
            const latest = getDraft()
            if (latest?.title === copy.title && latest.content === copy.content) discardDraft()
            void queryClient.invalidateQueries({ queryKey: ['notes', currentWorkspaceId] })
            navigate(`/workspaces/${currentWorkspaceId}/notes/${created.id}`)
        } catch { setCopyError(true) }
        finally { setCopying(false) }
    }

    const openHistory = (create = false) => {
        setHistory({ create }); setShowComments(false)
    }
    const closeHistory = () => {
        setHistory(null)
        requestAnimationFrame(() => document.querySelector<HTMLButtonElement>('[data-note-menu]')?.focus())
    }

    return (
        <div className="flex flex-col bg-white dark:bg-neutral-800 xl:w-full h-full min-w-0">
            {draft && <dialog ref={draftDialog} aria-labelledby="note-draft-title" onCancel={() => setShowDraft(false)} onClose={() => setShowDraft(false)} className="m-auto w-[calc(100%_-_2rem)] max-w-lg rounded-lg border bg-white p-5 text-foreground shadow-lg backdrop:bg-black/40 dark:bg-neutral-900">
                <h2 id="note-draft-title" className="text-lg font-medium">{t('history.viewDraft')}</h2>
                <p className="my-3 text-sm">{t('history.recovery')}</p>
                <textarea readOnly aria-label={t('history.viewDraft')} value={recoveryText(draft.title, draft.content)} className="h-40 w-full rounded border bg-transparent p-2 text-sm" />
                {copyError && <p role="alert">{t('history.copyFailed')}</p>}
                <div className="mt-4 flex flex-wrap gap-3 text-sm">
                    <button className="rounded border px-3 py-2" disabled={copying} onClick={copyDraft}>{t('history.copyDraft')}</button>
                    <button className="rounded border px-3 py-2" disabled={copying} onClick={() => { if (window.confirm(t('history.discardConfirm'))) { discardDraft(); setShowDraft(false) } }}>{t('history.useServer')}</button>
                    <button className="rounded border px-3 py-2" disabled={copying} onClick={() => setShowDraft(false)}>{t('history.dismiss')}</button>
                </div>
            </dialog>}
            <div className="flex min-h-0 min-w-0 flex-1">
            {history && noteId && <NoteHistory workspaceId={currentWorkspaceId} noteId={noteId} currentTitle={hasContent ? wsTitle : note?.title || ''} currentContent={hasContent ? liveContent || '' : note?.content || ''} connected={isReady} flush={flush} onClose={closeHistory} initialCreate={history.create} />}
            <div className={`${history ? 'hidden' : 'flex'} min-h-0 min-w-0 flex-1`}>
            <NoteDetailView
                key={noteId}
                editorSessionKey={String(generation)}
                note={note && { ...note, content: liveContent ?? note.content }}
                menu={note ? (
                    <div className="flex items-center gap-1">
                        <button
                            className={`p-2 rounded ${showComments ? 'text-primary' : 'text-muted-foreground'} hover:bg-gray-100 dark:hover:bg-neutral-800`}
                            onClick={() => setShowComments(prev => !prev)}
                        >
                            <MessageCircle size={16} />
                        </button>
                        <NoteDetailMenu note={note} onHistory={openHistory} saveStatus={saveStatus} onDraft={draft ? () => setShowDraft(true) : undefined} />
                    </div>
                ) : undefined}
                wsTitle={wsTitle}
                wsReady={hasContent}
                editable={canEdit && hasContent}
                onTitleChange={sendUpdateTitle}
                onContentChange={sendUpdateContent}
            />
            </div>
            {!history && currentWorkspaceId && noteId && (
                <CommentSidebar
                    workspaceId={currentWorkspaceId}
                    noteId={noteId}
                    open={showComments}
                    onOpenChange={setShowComments}
                />
            )}
            </div>
        </div>
    )
}

export default NoteDetailPage
