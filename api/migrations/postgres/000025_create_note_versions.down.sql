DROP TABLE note_versions;
DROP INDEX idx_notes_history_due;
ALTER TABLE notes DROP COLUMN last_content_at;
ALTER TABLE notes DROP COLUMN dirty_since;
ALTER TABLE notes DROP COLUMN version_sequence;
ALTER TABLE notes DROP COLUMN generation;
ALTER TABLE notes DROP COLUMN revision;
