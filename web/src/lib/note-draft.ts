export interface NoteSnapshot { title: string; content: string }
export interface NoteDraft extends NoteSnapshot {
  base: NoteSnapshot
  generation: number
  savedAt: number
}

export function sameSnapshot(a: NoteSnapshot, b: NoteSnapshot): boolean {
  return a.title === b.title && a.content === b.content
}

// Merge only independent fields. Rich text is a whole-document value in this app;
// competing edits to it must never be resolved by silently picking one side.
export function reconcileDraft(draft: NoteDraft, remote: NoteSnapshot, generation: number): NoteSnapshot | null {
  if (sameSnapshot(draft, remote)) return { ...remote }
  if (draft.generation !== generation) return null
  const result = { ...remote }
  for (const field of ['title', 'content'] as const) {
    if (draft[field] === draft.base[field]) continue
    if (remote[field] !== draft.base[field] && remote[field] !== draft[field]) return null
    result[field] = draft[field]
  }
  return result
}

export function parseDraft(raw: string | null): NoteDraft | null {
  try {
    const value = JSON.parse(raw || 'null')
    if (typeof value?.title !== 'string' || typeof value?.content !== 'string' ||
        typeof value?.base?.title !== 'string' || typeof value?.base?.content !== 'string' ||
        !Number.isSafeInteger(value.generation) || !Number.isFinite(value.savedAt)) return null
    return value
  } catch { return null }
}
