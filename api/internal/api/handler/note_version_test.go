package handler

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/labstack/echo/v4"
	"github.com/notomate/notomate/internal/config"
	"github.com/notomate/notomate/internal/db"
	"github.com/notomate/notomate/internal/model"
)

type historyDB struct {
	db.DB
	note    model.Note
	members []model.WorkspaceUser
}

func (d historyDB) FindNote(model.Note) (model.Note, error) { return d.note, nil }
func (d historyDB) FindWorkspaceUsers(model.WorkspaceUserFilter) ([]model.WorkspaceUser, error) {
	return d.members, nil
}
func (d historyDB) ListNoteVersions(string, int64, int) ([]model.NoteVersion, error) {
	return []model.NoteVersion{}, nil
}

func historyContext(method, body, workspace, user string) (echo.Context, *httptest.ResponseRecorder) {
	e := echo.New()
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(method, "/", strings.NewReader(body))
	req.Header.Set(echo.HeaderContentType, echo.MIMEApplicationJSON)
	c := e.NewContext(req, rec)
	c.SetParamNames("workspaceId", "id", "versionId")
	c.SetParamValues(workspace, "n", "v")
	if user != "" {
		c.Set("user", model.User{ID: user})
	}
	return c, rec
}

func TestHistoryPermissionsAndWorkspaceScope(t *testing.T) {
	t.Setenv("NOTE_HISTORY_ENABLED", "true")
	for _, tc := range []struct {
		name, visibility, workspace, user string
		member                            bool
		code                              int
	}{
		{"anonymous public", "public", "w", "", false, 401},
		{"public outsider", "public", "w", "other", false, 403},
		{"private member", "private", "w", "other", true, 403},
		{"private owner", "private", "w", "owner", false, 200},
		{"workspace member", "workspace", "w", "other", true, 200},
		{"wrong workspace", "public", "different", "owner", true, 404},
	} {
		t.Run(tc.name, func(t *testing.T) {
			d := historyDB{note: model.Note{ID: "n", WorkspaceID: "w", Visibility: tc.visibility, CreatedBy: "owner"}}
			if tc.member {
				d.members = []model.WorkspaceUser{{UserID: tc.user, WorkspaceID: "w"}}
			}
			h := Handler{db: d}
			c, rec := historyContext(http.MethodGet, "", tc.workspace, tc.user)
			err := h.ListNoteVersions(c)
			if err != nil {
				c.Echo().HTTPErrorHandler(err, c)
			}
			if rec.Code != tc.code {
				t.Fatalf("got %d, want %d: %s", rec.Code, tc.code, rec.Body.String())
			}
		})
	}
}

func TestHistoryControlUsesAuthenticatedIdentity(t *testing.T) {
	config.Init()
	t.Setenv("NOTE_HISTORY_ENABLED", "true")
	t.Setenv("APP_SECRET", "history-test-secret")
	var received model.VersionOperation
	control := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer history-test-secret" {
			t.Error("service authentication missing")
		}
		if err := json.NewDecoder(r.Body).Decode(&received); err != nil {
			t.Error(err)
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"version":{"id":"saved"}}`))
	}))
	defer control.Close()
	t.Setenv("COLLAB_CONTROL_ADDR", control.URL)
	h := Handler{db: historyDB{note: model.Note{ID: "n", WorkspaceID: "w", Visibility: "private", CreatedBy: "owner"}}}
	c, rec := historyContext(http.MethodPost, `{"user_id":"spoofed","workspace_id":"wrong","note_id":"other","version_id":"unexpected","operation_id":"op"}`, "w", "owner")
	if err := h.CreateNoteVersion(c); err != nil {
		t.Fatal(err)
	}
	if rec.Code != 200 || received.UserID != "owner" || received.WorkspaceID != "w" || received.NoteID != "n" || received.VersionID != "" {
		t.Fatalf("identity override failed: %+v", received)
	}
}
