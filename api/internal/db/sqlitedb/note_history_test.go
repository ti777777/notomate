package sqlitedb

import (
	"github.com/notomate/notomate/internal/model"
	"testing"
)

func TestDeleteWorkspaceRemovesNoteHistoryWithoutForeignKeys(t *testing.T) {
	db := newTestDB(t)
	if err := db.CreateWorkspace(model.Workspace{ID: "history-w", Name: "History"}); err != nil {
		t.Fatal(err)
	}
	if err := db.CreateNote(model.Note{ID: "history-n", WorkspaceID: "history-w", Title: "Note"}); err != nil {
		t.Fatal(err)
	}
	versions, err := db.ListNoteVersions("history-n", 0, 30)
	if err != nil || len(versions) != 1 {
		t.Fatalf("initial snapshot: %v, %v", versions, err)
	}
	if err := db.DeleteWorkspace("history-w"); err != nil {
		t.Fatal(err)
	}
	versions, err = db.ListNoteVersions("history-n", 0, 30)
	if err != nil || len(versions) != 0 {
		t.Fatalf("orphaned history: %v, %v", versions, err)
	}
}
