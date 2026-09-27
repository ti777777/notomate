package model

// NoteVersion is an immutable, complete title/content snapshot.
type NoteVersion struct {
	ID              string  `json:"id" gorm:"primaryKey"`
	NoteID          string  `json:"note_id"`
	WorkspaceID     string  `json:"workspace_id"`
	Sequence        int64   `json:"sequence"`
	Title           string  `json:"title"`
	Content         string  `json:"content"`
	ContentHash     string  `json:"content_hash"`
	FormatVersion   int     `json:"format_version"`
	Name            string  `json:"name"`
	Source          string  `json:"source"`
	SourceVersionID string  `json:"source_version_id"`
	CreatedAt       string  `json:"created_at"`
	CreatedBy       string  `json:"created_by"`
	OperationID     *string `json:"-"`
}

type VersionOperation struct {
	NoteID           string `json:"note_id"`
	WorkspaceID      string `json:"workspace_id"`
	UserID           string `json:"user_id"`
	VersionID        string `json:"version_id"`
	Name             string `json:"name"`
	OperationID      string `json:"operation_id"`
	ExpectedRevision *int64 `json:"expected_revision"`
}

type VersionResult struct {
	Note     Note        `json:"note"`
	Version  NoteVersion `json:"version"`
	Replayed bool        `json:"replayed"`
}
