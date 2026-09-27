// Package notehistory shares the transactional history implementation between SQL engines.
package notehistory

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/notomate/notomate/internal/model"
	"github.com/notomate/notomate/internal/util"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

var ErrConflict = errors.New("note changed; refresh and try again")
var ErrForbidden = errors.New("note history access denied")
var ErrInvalid = errors.New("invalid version operation")

func Enabled() bool { return os.Getenv("NOTE_HISTORY_ENABLED") != "false" }

func Hash(title, content string) string {
	var value any
	decoder := json.NewDecoder(strings.NewReader(content))
	decoder.UseNumber()
	if json.Valid([]byte(content)) && decoder.Decode(&value) == nil {
		b, _ := json.Marshal(value)
		content = string(b)
	}
	b, _ := json.Marshal([]string{title, content})
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:])
}

func locked(tx *gorm.DB, id string) (model.Note, error) {
	var n model.Note
	q := tx
	if tx.Dialector.Name() == "postgres" {
		q = q.Clauses(clause.Locking{Strength: "UPDATE"})
	}
	err := q.Where("id = ?", id).First(&n).Error
	return n, err
}

func snapshot(tx *gorm.DB, n *model.Note, source, name, actor, origin string, operation *string) (model.NoteVersion, error) {
	n.VersionSequence++
	v := model.NoteVersion{ID: util.NewId(), NoteID: n.ID, WorkspaceID: n.WorkspaceID,
		Sequence: n.VersionSequence, Title: n.Title, Content: n.Content, ContentHash: Hash(n.Title, n.Content),
		FormatVersion: 1, Name: name, Source: source, SourceVersionID: origin,
		CreatedAt: time.Now().UTC().Format(time.RFC3339Nano), CreatedBy: actor, OperationID: operation}
	if err := tx.Create(&v).Error; err != nil {
		return v, err
	}
	return v, tx.Model(&model.Note{}).Where("id = ?", n.ID).Update("version_sequence", n.VersionSequence).Error
}

func baseline(tx *gorm.DB, n *model.Note) error {
	if n.VersionSequence != 0 {
		return nil
	}
	_, err := snapshot(tx, n, "initial", "", n.UpdatedBy, "", nil)
	return err
}

func Create(db *gorm.DB, n model.Note) error {
	return db.Transaction(func(tx *gorm.DB) error {
		insert := tx
		if n.ParentID == "" {
			insert = insert.Omit("parent_id")
		}
		if err := insert.Create(&n).Error; err != nil {
			return err
		}
		if Enabled() {
			return baseline(tx, &n)
		}
		return nil
	})
}

// Update uses optimistic concurrency even when history creation is disabled.
func Update(db *gorm.DB, n model.Note) error {
	return db.Transaction(func(tx *gorm.DB) error {
		old, err := locked(tx, n.ID)
		if err != nil {
			return err
		}
		if old.Revision != n.Revision || old.Generation != n.Generation {
			return ErrConflict
		}
		changed := Hash(old.Title, old.Content) != Hash(n.Title, n.Content)
		if changed && Enabled() {
			if err := baseline(tx, &old); err != nil {
				return err
			}
		}
		values := map[string]any{"title": n.Title, "content": n.Content, "visibility": n.Visibility,
			"parent_id": n.ParentID, "pinned": n.Pinned, "updated_at": n.UpdatedAt, "updated_by": n.UpdatedBy}
		if n.ParentID == "" {
			values["parent_id"] = nil
		}
		if changed {
			values["revision"] = old.Revision + 1
			if n.AdvanceGeneration {
				values["generation"] = old.Generation + 1
			}
			if Enabled() {
				values["last_content_at"] = 0
				values["dirty_since"] = 0
			}
		}
		res := tx.Model(&model.Note{}).Where("id = ? AND revision = ? AND generation = ?", n.ID, n.Revision, n.Generation).Updates(values)
		if res.Error != nil {
			return res.Error
		}
		if res.RowsAffected != 1 {
			return ErrConflict
		}
		if changed && Enabled() {
			// The note and its version commit together. Never acknowledge a content
			// update whose history snapshot failed to persist.
			n.VersionSequence = old.VersionSequence
			_, err := snapshot(tx, &n, "auto", "", n.UpdatedBy, "", nil)
			return err
		}
		return nil
	})
}

func Delete(db *gorm.DB, n model.Note) error {
	return db.Transaction(func(tx *gorm.DB) error {
		if _, err := locked(tx, n.ID); err != nil {
			return err
		}
		if err := tx.Where("note_id = ?", n.ID).Delete(&model.NoteVersion{}).Error; err != nil {
			return err
		}
		return tx.Where("id = ?", n.ID).Delete(&model.Note{}).Error
	})
}

func List(db *gorm.DB, noteID string, before int64, limit int) ([]model.NoteVersion, error) {
	result := []model.NoteVersion{}
	q := db.Omit("content", "operation_id").Where("note_id = ?", noteID)
	if before > 0 {
		q = q.Where("sequence < ?", before)
	}
	err := q.Order("sequence DESC").Limit(limit).Find(&result).Error
	return result, err
}

func Get(db *gorm.DB, noteID, versionID string) (model.NoteVersion, error) {
	var v model.NoteVersion
	err := db.Where("id = ? AND note_id = ?", versionID, noteID).First(&v).Error
	return v, err
}

func Operation(db *gorm.DB, req model.VersionOperation) (result model.VersionResult, err error) {
	if !Enabled() || strings.TrimSpace(req.OperationID) == "" || len(req.OperationID) > 100 || utf8.RuneCountInString(req.Name) > 100 || (req.VersionID != "" && req.ExpectedRevision == nil) {
		return result, ErrInvalid
	}
	err = db.Transaction(func(tx *gorm.DB) error {
		n, err := locked(tx, req.NoteID)
		if err != nil {
			return err
		}
		if n.WorkspaceID != req.WorkspaceID || req.UserID == "" {
			return ErrForbidden
		}
		if n.Visibility == "private" {
			if n.CreatedBy != req.UserID {
				return ErrForbidden
			}
		} else if n.Visibility == "public" || n.Visibility == "workspace" {
			var count int64
			if err := tx.Model(&model.WorkspaceUser{}).Where("workspace_id = ? AND user_id = ?", n.WorkspaceID, req.UserID).Count(&count).Error; err != nil {
				return err
			}
			if count == 0 {
				return ErrForbidden
			}
		} else {
			return ErrForbidden
		}
		var previous model.NoteVersion
		err = tx.Where("note_id = ? AND operation_id = ?", n.ID, req.OperationID).First(&previous).Error
		if err == nil {
			if previous.CreatedBy != req.UserID || previous.SourceVersionID != req.VersionID || previous.Name != strings.TrimSpace(req.Name) {
				return ErrInvalid
			}
			result = model.VersionResult{Note: n, Version: previous, Replayed: true}
			return nil
		}
		if !errors.Is(err, gorm.ErrRecordNotFound) {
			return err
		}
		if req.ExpectedRevision != nil && n.Revision != *req.ExpectedRevision {
			return ErrConflict
		}
		if err := baseline(tx, &n); err != nil {
			return err
		}
		source := "manual"
		if req.VersionID != "" {
			v, err := Get(tx, n.ID, req.VersionID)
			if err != nil {
				return err
			}
			if _, err := snapshot(tx, &n, "before_restore", "", req.UserID, v.ID, nil); err != nil {
				return err
			}
			n.Title, n.Content = v.Title, v.Content
			n.Revision++
			n.Generation++
			n.UpdatedAt = time.Now().UTC().Format(time.RFC3339Nano)
			n.UpdatedBy = req.UserID
			source = "restore"
		}
		v, err := snapshot(tx, &n, source, strings.TrimSpace(req.Name), req.UserID, req.VersionID, &req.OperationID)
		if err != nil {
			return err
		}
		n.DirtySince = 0
		n.LastContentAt = 0
		if err := tx.Model(&model.Note{}).Where("id = ?", n.ID).Select("title", "content", "revision", "generation", "updated_at", "updated_by", "dirty_since", "last_content_at").Updates(n).Error; err != nil {
			return err
		}
		result = model.VersionResult{Note: n, Version: v}
		return nil
	})
	return
}

// SaveDue drains snapshots queued by the earlier timed-snapshot implementation.
// New updates create their snapshot in Update's transaction instead.
func SaveDue(db *gorm.DB, now int64) error {
	if !Enabled() {
		return nil
	}
	var ids []string
	if err := db.Model(&model.Note{}).Where("dirty_since > 0 AND (last_content_at <= ? OR dirty_since <= ?)", now-30000, now-300000).Limit(100).Pluck("id", &ids).Error; err != nil {
		return err
	}
	for _, id := range ids {
		if err := db.Transaction(func(tx *gorm.DB) error {
			n, err := locked(tx, id)
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return nil
			}
			if err != nil {
				return err
			}
			if n.DirtySince == 0 || (n.LastContentAt > now-30000 && n.DirtySince > now-300000) {
				return nil
			}
			var last model.NoteVersion
			err = tx.Where("note_id = ?", id).Order("sequence DESC").First(&last).Error
			if err != nil && !errors.Is(err, gorm.ErrRecordNotFound) {
				return err
			}
			if last.ContentHash != Hash(n.Title, n.Content) {
				if _, err := snapshot(tx, &n, "auto", "", n.UpdatedBy, "", nil); err != nil {
					return err
				}
			}
			return tx.Model(&model.Note{}).Where("id = ? AND revision = ?", id, n.Revision).Updates(map[string]any{"dirty_since": 0, "last_content_at": 0}).Error
		}); err != nil {
			return err
		}
	}
	return nil
}
