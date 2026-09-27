import axios from 'axios'

export interface NoteVersion {
  id: string
  sequence: number
  title: string
  content?: string
  name: string
  source: 'initial' | 'auto' | 'manual' | 'before_restore' | 'restore'
  source_version_id: string
  created_at: string
  created_by: string
  created_by_name?: string
}

const base = (workspaceId: string, noteId: string) => `/api/v1/workspaces/${workspaceId}/notes/${noteId}/versions`

export async function listNoteVersions(workspaceId: string, noteId: string, cursor = '') {
  return (await axios.get<{ items: NoteVersion[]; next_cursor: string }>(base(workspaceId, noteId), { params: { cursor, limit: 30 } })).data
}
export async function getNoteVersion(workspaceId: string, noteId: string, id: string) {
  return (await axios.get<NoteVersion>(`${base(workspaceId, noteId)}/${id}`)).data
}
export async function createNoteVersion(workspaceId: string, noteId: string, name: string, operationId: string) {
  return (await axios.post(base(workspaceId, noteId), { name, operation_id: operationId })).data
}
export async function prepareNoteVersion(workspaceId: string, noteId: string) {
  return (await axios.post<{ revision: number; generation: number }>(`${base(workspaceId, noteId)}/prepare`, {})).data
}
export async function restoreNoteVersion(workspaceId: string, noteId: string, id: string, revision: number, operationId: string) {
  return (await axios.post(`${base(workspaceId, noteId)}/${id}/restore`, { expected_revision: revision, operation_id: operationId })).data
}
