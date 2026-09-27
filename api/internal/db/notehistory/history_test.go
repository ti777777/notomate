package notehistory

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/notomate/notomate/internal/model"
	"gorm.io/driver/postgres"
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

// Set HISTORY_TEST_POSTGRES_DSN to run the same suite in an isolated Postgres schema.
func testDatabases(t *testing.T, run func(*testing.T, *gorm.DB)) {
	t.Helper()
	dialects := []string{"sqlite3"}
	if os.Getenv("HISTORY_TEST_POSTGRES_DSN") != "" {
		dialects = append(dialects, "postgres")
	}
	for _, dialect := range dialects {
		t.Run(dialect, func(t *testing.T) {
			t.Setenv("NOTE_HISTORY_ENABLED", "true")
			var driver gorm.Dialector = sqlite.Open(filepath.Join(t.TempDir(), "history.db") + "?_foreign_keys=on&_busy_timeout=5000")
			if dialect == "postgres" {
				driver = postgres.New(postgres.Config{DSN: os.Getenv("HISTORY_TEST_POSTGRES_DSN"), PreferSimpleProtocol: true})
			}
			db, err := gorm.Open(driver, &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
			if err != nil {
				t.Fatal(err)
			}
			sqlDB, _ := db.DB()
			t.Cleanup(func() { sqlDB.Close() })
			if dialect == "postgres" {
				sqlDB.SetMaxOpenConns(1)
				schema := fmt.Sprintf("history_test_%d", time.Now().UnixNano())
				if err := db.Exec("CREATE SCHEMA " + schema).Error; err != nil {
					t.Fatal(err)
				}
				t.Cleanup(func() { db.Exec("DROP SCHEMA " + schema + " CASCADE") })
				if err := db.Exec("SET search_path TO " + schema).Error; err != nil {
					t.Fatal(err)
				}
			}
			// Base migrations create the production schema, not a test-only AutoMigrate approximation.
			entries, err := filepath.Glob("../../../migrations/" + dialect + "/*.up.sql")
			if err != nil {
				t.Fatal(err)
			}
			if len(entries) == 0 {
				t.Fatal("migration files missing")
			}
			for _, path := range entries {
				content, err := os.ReadFile(path)
				if err != nil {
					t.Fatal(err)
				}
				if err := db.Exec(string(content)).Error; err != nil {
					t.Fatalf("%s: %v", path, err)
				}
			}
			run(t, db)
		})
	}
}

func TestHistoryLifecycle(t *testing.T) {
	testDatabases(t, func(t *testing.T, db *gorm.DB) {
		must := func(err error) {
			t.Helper()
			if err != nil {
				t.Fatal(err)
			}
		}
		workspace := "history-test-workspace"
		must(db.Create(&model.User{ID: "history-owner", Name: "Owner"}).Error)
		must(db.Create(&model.Workspace{ID: workspace, Name: "History"}).Error)
		must(db.Create(&model.WorkspaceUser{WorkspaceID: workspace, UserID: "history-owner", Role: "owner"}).Error)
		n := model.Note{ID: "history-note", WorkspaceID: workspace, Visibility: "workspace", Title: "original", Content: `{"type":"doc","content":[]}`, CreatedBy: "history-owner", UpdatedBy: "history-owner"}
		must(Create(db, n))
		versions, err := List(db, n.ID, 0, 30)
		must(err)
		if len(versions) != 1 || versions[0].Source != "initial" || versions[0].Content != "" {
			t.Fatalf("bad initial summary: %+v", versions)
		}
		initialID := versions[0].ID
		load := func() model.Note {
			var current model.Note
			must(db.First(&current, "id = ?", n.ID).Error)
			return current
		}
		n = load()
		stale := n
		n.Title = "edited"
		must(Update(db, n))
		n = load()
		if n.Revision != 1 || n.DirtySince != 0 {
			t.Fatalf("edit not tracked: %+v", n)
		}
		if !errors.Is(Update(db, stale), ErrConflict) {
			t.Fatal("stale write accepted")
		}
		must(SaveDue(db, n.LastContentAt+29999))
		versions, err = List(db, n.ID, 0, 30)
		must(err)
		if len(versions) != 2 {
			t.Fatal("successful update must immediately snapshot")
		}
		must(SaveDue(db, n.LastContentAt+30000))
		versions, err = List(db, n.ID, 0, 30)
		must(err)
		if len(versions) != 2 || versions[0].Source != "auto" {
			t.Fatal("automatic snapshot missing")
		}
		// No-op writes and periodic worker retries must not create extra snapshots.
		must(Update(db, load()))
		must(SaveDue(db, time.Now().Add(time.Hour).UnixMilli()))
		versions, err = List(db, n.ID, 0, 30)
		must(err)
		if len(versions) != 2 {
			t.Fatal("duplicate automatic snapshot")
		}
		request := model.VersionOperation{NoteID: n.ID, WorkspaceID: workspace, UserID: "history-owner", Name: "Milestone", OperationID: "manual-1"}
		manual, err := Operation(db, request)
		must(err)
		retry, err := Operation(db, request)
		must(err)
		if retry.Version.ID != manual.Version.ID || !retry.Replayed {
			t.Fatal("manual operation not idempotent")
		}
		request.UserID = "outsider"
		if _, err := Operation(db, request); !errors.Is(err, ErrForbidden) {
			t.Fatal("history accessible to outsider")
		}
		request.UserID = "history-owner"
		request.WorkspaceID = "wrong"
		if _, err := Operation(db, request); !errors.Is(err, ErrForbidden) {
			t.Fatal("cross-workspace operation accepted")
		}
		n = load()
		revision := n.Revision
		request = model.VersionOperation{NoteID: n.ID, WorkspaceID: workspace, UserID: "history-owner", VersionID: initialID, ExpectedRevision: &revision, OperationID: "restore-1"}
		result, err := Operation(db, request)
		must(err)
		if result.Note.Title != "original" || result.Note.Generation != n.Generation+1 || result.Note.Revision != revision+1 {
			t.Fatalf("restore incorrect: %+v", result.Note)
		}
		versions, err = List(db, n.ID, 0, 30)
		must(err)
		if len(versions) != 5 || versions[0].Source != "restore" || versions[1].Source != "before_restore" {
			t.Fatalf("missing restore audit: %+v", versions)
		}
		backup, err := Get(db, n.ID, versions[1].ID)
		must(err)
		if backup.Title != "edited" {
			t.Fatal("backup lost current content")
		}
		if !errors.Is(Update(db, n), ErrConflict) {
			t.Fatal("pre-restore room overwrote restored note")
		}
		retry, err = Operation(db, request)
		must(err)
		if !retry.Replayed {
			t.Fatal("restore retry not idempotent")
		}
		request.OperationID = "restore-2"
		if _, err := Operation(db, request); !errors.Is(err, ErrConflict) {
			t.Fatal("outdated restore confirmation accepted")
		}
		page, err := List(db, n.ID, versions[1].Sequence, 2)
		must(err)
		if len(page) != 2 || page[0].Sequence >= versions[1].Sequence {
			t.Fatal("cursor pagination incorrect")
		}
		// A nonexistent version rolls back the operation without leaving a backup.
		revision = load().Revision
		request.VersionID = "missing"
		request.OperationID = "missing-version"
		if _, err := Operation(db, request); !errors.Is(err, gorm.ErrRecordNotFound) {
			t.Fatal("missing version accepted")
		}
		unchanged, err := List(db, n.ID, 0, 30)
		must(err)
		if len(unchanged) != len(versions) {
			t.Fatal("failed restore left partial history")
		}
		// Empty title/content are values, and restoring must not revert note metadata.
		n = load()
		n.Title = ""
		n.Content = ""
		n.Pinned = true
		n.Visibility = "private"
		must(Update(db, n))
		empty, err := Operation(db, model.VersionOperation{NoteID: n.ID, WorkspaceID: workspace, UserID: "history-owner", OperationID: "empty"})
		must(err)
		n = load()
		n.Title = "temporary"
		must(Update(db, n))
		revision = load().Revision
		request.VersionID = empty.Version.ID
		request.OperationID = "restore-empty"
		emptyResult, err := Operation(db, request)
		must(err)
		if emptyResult.Note.Title != "" || emptyResult.Note.Content != "" || !emptyResult.Note.Pinned || emptyResult.Note.Visibility != "private" {
			t.Fatal("empty restore or metadata preservation failed")
		}
		must(Delete(db, load()))
		var count int64
		must(db.Model(&model.NoteVersion{}).Count(&count).Error)
		if count != 0 {
			t.Fatal("orphaned versions")
		}
		dialect := db.Dialector.Name()
		if dialect == "sqlite" {
			dialect = "sqlite3"
		}
		for _, direction := range []string{"down", "up"} {
			migration, err := os.ReadFile("../../../migrations/" + dialect + "/000025_create_note_versions." + direction + ".sql")
			must(err)
			must(db.Exec(string(migration)).Error)
		}
	})
}

func TestContinuousEditsAndLegacyBaseline(t *testing.T) {
	t.Setenv("NOTE_HISTORY_ENABLED", "true")
	db, err := gorm.Open(sqlite.Open(filepath.Join(t.TempDir(), "worker.db")), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	sqlDB, _ := db.DB()
	t.Cleanup(func() { sqlDB.Close() })
	if err := db.AutoMigrate(&model.Note{}, &model.NoteVersion{}); err != nil {
		t.Fatal(err)
	}
	n := model.Note{ID: "legacy", Title: "before", Content: "old"}
	if err := db.Create(&n).Error; err != nil {
		t.Fatal(err)
	}
	n.Title = "after"
	if err := Update(db, n); err != nil {
		t.Fatal(err)
	}
	versions, err := List(db, n.ID, 0, 30)
	if err != nil {
		t.Fatal(err)
	}
	if len(versions) != 2 || versions[1].Title != "before" || versions[0].Title != "after" {
		t.Fatalf("baseline/immediate snapshot wrong: %+v", versions)
	}
	for i := 0; i < 3; i++ {
		if err := db.First(&n, "id = ?", n.ID).Error; err != nil {
			t.Fatal(err)
		}
		n.Content = fmt.Sprintf("edit %d", i)
		if err := Update(db, n); err != nil {
			t.Fatal(err)
		}
	}
	versions, err = List(db, n.ID, 0, 30)
	if err != nil || len(versions) != 5 {
		t.Fatalf("continuous updates must each snapshot: %d, %v", len(versions), err)
	}
	if err := db.First(&n, "id = ?", n.ID).Error; err != nil {
		t.Fatal(err)
	}
	if err := Update(db, n); err != nil {
		t.Fatal(err)
	}
	if err := db.Exec("CREATE TRIGGER fail_snapshot BEFORE INSERT ON note_versions BEGIN SELECT RAISE(ABORT, 'snapshot unavailable'); END").Error; err != nil {
		t.Fatal(err)
	}
	before := n
	n.Content = "must roll back"
	if err := Update(db, n); err == nil {
		t.Fatal("snapshot failure must reject update")
	}
	if err := db.First(&n, "id = ?", n.ID).Error; err != nil {
		t.Fatal(err)
	}
	if n.Content != before.Content || n.Revision != before.Revision {
		t.Fatal("failed snapshot committed note changes")
	}
	versions, err = List(db, n.ID, 0, 30)
	if err != nil || len(versions) != 5 {
		t.Fatalf("no-op/failed update created versions: %d, %v", len(versions), err)
	}
}

func TestCanonicalContentHash(t *testing.T) {
	if Hash("title", `{"a":1,"b":2}`) != Hash("title", "{ \"b\": 2, \"a\": 1 }") {
		t.Fatal("JSON property order caused duplicate")
	}
	if Hash("title", `{"a":1}`) == Hash("changed", `{"a":1}`) {
		t.Fatal("title missing from hash")
	}
	if Hash("title", `{"a":9007199254740992}`) == Hash("title", `{"a":9007199254740993}`) {
		t.Fatal("large JSON numbers lost precision")
	}
}
