package handler

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/labstack/echo/v4"
	"github.com/notomate/notomate/internal/config"
	"github.com/notomate/notomate/internal/db/notehistory"
	"github.com/notomate/notomate/internal/model"
	"gorm.io/gorm"
)

func (h Handler) historyNote(c echo.Context) (model.Note, error) {
	if !notehistory.Enabled() {
		return model.Note{}, echo.NewHTTPError(404)
	}
	n, err := h.db.FindNote(model.Note{ID: c.Param("id")})
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return n, echo.NewHTTPError(404)
	}
	if err != nil {
		return n, err
	}
	if n.WorkspaceID != c.Param("workspaceId") {
		return n, echo.NewHTTPError(404)
	}
	u, ok := c.Get("user").(model.User)
	if !ok || u.ID == "" {
		return n, echo.NewHTTPError(401)
	}
	allowed := n.Visibility == "private" && n.CreatedBy == u.ID
	if n.Visibility == "workspace" || n.Visibility == "public" {
		allowed = h.isUserWorkspaceMember(u.ID, n.WorkspaceID)
	}
	if !allowed {
		return n, echo.NewHTTPError(403)
	}
	return n, nil
}

func (h Handler) ListNoteVersions(c echo.Context) error {
	n, err := h.historyNote(c)
	if err != nil {
		return err
	}
	before := int64(0)
	limit := 30
	if raw := c.QueryParam("cursor"); raw != "" {
		before, err = strconv.ParseInt(raw, 10, 64)
		if err != nil || before < 1 {
			return echo.NewHTTPError(400, "invalid cursor")
		}
	}
	if raw := c.QueryParam("limit"); raw != "" {
		limit, err = strconv.Atoi(raw)
		if err != nil || limit < 1 || limit > 100 {
			return echo.NewHTTPError(400, "invalid limit")
		}
	}
	versions, err := h.db.ListNoteVersions(n.ID, before, limit+1)
	if err != nil {
		return err
	}
	next := ""
	if len(versions) > limit {
		versions = versions[:limit]
		next = strconv.FormatInt(versions[len(versions)-1].Sequence, 10)
	}
	type summary struct {
		model.NoteVersion
		Content       *string `json:"content,omitempty"`
		CreatedByName string  `json:"created_by_name"`
	}
	items := make([]summary, 0, len(versions))
	names := map[string]string{}
	for _, v := range versions {
		name, ok := names[v.CreatedBy]
		if !ok {
			name = h.getUserNameByID(v.CreatedBy)
			names[v.CreatedBy] = name
		}
		items = append(items, summary{NoteVersion: v, CreatedByName: name})
	}
	return c.JSON(200, echo.Map{"items": items, "next_cursor": next})
}

func (h Handler) GetNoteVersion(c echo.Context) error {
	n, err := h.historyNote(c)
	if err != nil {
		return err
	}
	v, err := h.db.GetNoteVersion(n.ID, c.Param("versionId"))
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return echo.NewHTTPError(404)
	}
	if err != nil {
		return err
	}
	return c.JSON(200, v)
}

// The collab service serializes the flush and operation against its live room.
func (h Handler) noteVersionControl(c echo.Context, action string) error {
	n, err := h.historyNote(c)
	if err != nil {
		return err
	}
	var req model.VersionOperation
	if err := c.Bind(&req); err != nil {
		return echo.NewHTTPError(400, "invalid request")
	}
	req.NoteID, req.WorkspaceID, req.UserID = n.ID, n.WorkspaceID, c.Get("user").(model.User).ID
	req.VersionID = ""
	if action == "restore" {
		req.VersionID = c.Param("versionId")
	}
	endpoint := os.Getenv("COLLAB_CONTROL_ADDR")
	if endpoint == "" {
		endpoint = "http://127.0.0.1:3001"
	}
	body, err := json.Marshal(req)
	if err != nil {
		return err
	}
	r, err := http.NewRequestWithContext(c.Request().Context(), http.MethodPost, strings.TrimRight(endpoint, "/")+"/"+action, bytes.NewReader(body))
	if err != nil {
		return err
	}
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Authorization", "Bearer "+config.C.GetString(config.APP_SECRET))
	res, err := (&http.Client{Timeout: 20 * time.Second}).Do(r)
	if err != nil {
		return echo.NewHTTPError(503, "collaboration service unavailable; retry with the same operation ID")
	}
	defer res.Body.Close()
	data, err := io.ReadAll(io.LimitReader(res.Body, 32<<20))
	if err != nil {
		return echo.NewHTTPError(503, "could not read collaboration response")
	}
	return c.Blob(res.StatusCode, "application/json", data)
}

func (h Handler) CreateNoteVersion(c echo.Context) error  { return h.noteVersionControl(c, "snapshot") }
func (h Handler) RestoreNoteVersion(c echo.Context) error { return h.noteVersionControl(c, "restore") }
func (h Handler) PrepareNoteVersion(c echo.Context) error { return h.noteVersionControl(c, "prepare") }
