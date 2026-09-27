ALTER TABLE notes ADD COLUMN revision BIGINT NOT NULL DEFAULT 0;
ALTER TABLE notes ADD COLUMN generation BIGINT NOT NULL DEFAULT 0;
ALTER TABLE notes ADD COLUMN version_sequence BIGINT NOT NULL DEFAULT 0;
ALTER TABLE notes ADD COLUMN dirty_since BIGINT NOT NULL DEFAULT 0;
ALTER TABLE notes ADD COLUMN last_content_at BIGINT NOT NULL DEFAULT 0;
CREATE TABLE note_versions (
 id TEXT PRIMARY KEY,
 note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
 workspace_id TEXT NOT NULL,
 sequence BIGINT NOT NULL,
 title TEXT NOT NULL,
 content TEXT NOT NULL,
 content_hash TEXT NOT NULL,
 format_version INTEGER NOT NULL,
 name TEXT NOT NULL DEFAULT '',
 source TEXT NOT NULL,
 source_version_id TEXT NOT NULL DEFAULT '',
 created_at TEXT NOT NULL,
 created_by TEXT NOT NULL,
 operation_id TEXT,
 UNIQUE(note_id, sequence),
 UNIQUE(note_id, operation_id)
);
CREATE INDEX idx_note_versions_list ON note_versions(note_id, sequence DESC);
CREATE INDEX idx_notes_history_due ON notes(dirty_since, last_content_at);
