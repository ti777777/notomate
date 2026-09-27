package grpcserver

import (
	"context"
	"github.com/notomate/notomate/internal/model"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"testing"
)

func TestNoteWritesRequireCollabServiceAuthentication(t *testing.T) {
	s := &collabServer{}
	if _, err := s.UpdateNote(context.Background(), &UpdateNoteRequest{}); status.Code(err) != codes.Unauthenticated {
		t.Fatalf("unauthenticated write: %v", err)
	}
	if _, err := s.VersionOperation(context.Background(), &model.VersionOperation{}); status.Code(err) != codes.Unauthenticated {
		t.Fatalf("unauthenticated restore: %v", err)
	}
}
