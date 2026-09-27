package grpcserver

import (
	"context"
	"crypto/subtle"
	"errors"
	"github.com/notomate/notomate/internal/config"
	"google.golang.org/grpc/metadata"
	"log"
	"net"
	"strings"
	"time"

	"golang.org/x/crypto/bcrypt"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"gorm.io/gorm"

	"github.com/notomate/notomate/internal/db"
	"github.com/notomate/notomate/internal/db/notehistory"
	"github.com/notomate/notomate/internal/model"
	"github.com/notomate/notomate/internal/storage"
	"github.com/notomate/notomate/internal/util"
	"github.com/notomate/notomate/internal/workflow"
)

// ---------- Request / Response types (JSON-serialized) ----------

type GetUserRequest struct {
	ID string `json:"id"`
}
type GetUserResponse struct {
	Found    bool   `json:"found"`
	ID       string `json:"id"`
	Name     string `json:"name"`
	Disabled bool   `json:"disabled"`
}

type ValidateAPIKeyRequest struct {
	Key string `json:"key"`
}
type ValidateAPIKeyResponse struct {
	Valid    bool   `json:"valid"`
	UserID   string `json:"user_id"`
	UserName string `json:"user_name"`
	Disabled bool   `json:"disabled"`
}

type IsWorkspaceMemberRequest struct {
	UserID      string `json:"user_id"`
	WorkspaceID string `json:"workspace_id"`
}
type IsWorkspaceMemberResponse struct {
	IsMember bool `json:"is_member"`
}

type GetNoteRequest struct {
	ID string `json:"id"`
}
type GetNoteResponse struct {
	Revision    int64  `json:"revision"`
	Generation  int64  `json:"generation"`
	Found       bool   `json:"found"`
	ID          string `json:"id"`
	Title       string `json:"title"`
	Content     string `json:"content"`
	Visibility  string `json:"visibility"`
	WorkspaceID string `json:"workspace_id"`
	CreatedBy   string `json:"created_by"`
}

type GetViewRequest struct {
	ID string `json:"id"`
}
type GetViewResponse struct {
	Found       bool   `json:"found"`
	ID          string `json:"id"`
	Data        string `json:"data"`
	Visibility  string `json:"visibility"`
	WorkspaceID string `json:"workspace_id"`
	CreatedBy   string `json:"created_by"`
}

type UpdateNoteRequest struct {
	Revision   *int64 `json:"revision"`
	Generation *int64 `json:"generation"`
	ID         string `json:"id"`
	Title      string `json:"title"`
	Content    string `json:"content"`
	UpdatedAt  string `json:"updated_at"`
	UpdatedBy  string `json:"updated_by"`
}
type UpdateNoteResponse struct {
	Revision int64 `json:"revision"`
}

type UpdateViewDataRequest struct {
	ID        string `json:"id"`
	Data      string `json:"data"`
	UpdatedAt string `json:"updated_at"`
}
type UpdateViewDataResponse struct{}

// ---------- Service interface ----------

type CollabServiceServer interface {
	VersionOperation(context.Context, *model.VersionOperation) (*model.VersionResult, error)
	GetUser(ctx context.Context, req *GetUserRequest) (*GetUserResponse, error)
	ValidateAPIKey(ctx context.Context, req *ValidateAPIKeyRequest) (*ValidateAPIKeyResponse, error)
	IsWorkspaceMember(ctx context.Context, req *IsWorkspaceMemberRequest) (*IsWorkspaceMemberResponse, error)
	GetNote(ctx context.Context, req *GetNoteRequest) (*GetNoteResponse, error)
	GetView(ctx context.Context, req *GetViewRequest) (*GetViewResponse, error)
	UpdateNote(ctx context.Context, req *UpdateNoteRequest) (*UpdateNoteResponse, error)
	UpdateViewData(ctx context.Context, req *UpdateViewDataRequest) (*UpdateViewDataResponse, error)
}

// ---------- Unary handler wrappers ----------

func makeHandler[Req any](fullMethod string, impl func(context.Context, *Req) (interface{}, error)) grpc.MethodDesc {
	name := fullMethod[strings.LastIndex(fullMethod, "/")+1:]
	return grpc.MethodDesc{
		MethodName: name,
		Handler: func(srv interface{}, ctx context.Context, dec func(interface{}) error, interceptor grpc.UnaryServerInterceptor) (interface{}, error) {
			in := new(Req)
			if err := dec(in); err != nil {
				return nil, err
			}
			if interceptor == nil {
				return impl(ctx, in)
			}
			info := &grpc.UnaryServerInfo{Server: srv, FullMethod: fullMethod}
			handler := func(ctx context.Context, req interface{}) (interface{}, error) {
				return impl(ctx, req.(*Req))
			}
			return interceptor(ctx, in, info, handler)
		},
	}
}

// ---------- Service descriptor ----------

func registerCollabServiceServer(s *grpc.Server, srv CollabServiceServer) {
	desc := grpc.ServiceDesc{
		ServiceName: "collab.CollabService",
		HandlerType: (*CollabServiceServer)(nil),
		Methods: []grpc.MethodDesc{
			makeHandler("/collab.CollabService/VersionOperation", func(ctx context.Context, req *model.VersionOperation) (interface{}, error) {
				return srv.VersionOperation(ctx, req)
			}),
			makeHandler("/collab.CollabService/GetUser", func(ctx context.Context, req *GetUserRequest) (interface{}, error) {
				return srv.GetUser(ctx, req)
			}),
			makeHandler("/collab.CollabService/ValidateAPIKey", func(ctx context.Context, req *ValidateAPIKeyRequest) (interface{}, error) {
				return srv.ValidateAPIKey(ctx, req)
			}),
			makeHandler("/collab.CollabService/IsWorkspaceMember", func(ctx context.Context, req *IsWorkspaceMemberRequest) (interface{}, error) {
				return srv.IsWorkspaceMember(ctx, req)
			}),
			makeHandler("/collab.CollabService/GetNote", func(ctx context.Context, req *GetNoteRequest) (interface{}, error) {
				return srv.GetNote(ctx, req)
			}),
			makeHandler("/collab.CollabService/GetView", func(ctx context.Context, req *GetViewRequest) (interface{}, error) {
				return srv.GetView(ctx, req)
			}),
			makeHandler("/collab.CollabService/UpdateNote", func(ctx context.Context, req *UpdateNoteRequest) (interface{}, error) {
				return srv.UpdateNote(ctx, req)
			}),
			makeHandler("/collab.CollabService/UpdateViewData", func(ctx context.Context, req *UpdateViewDataRequest) (interface{}, error) {
				return srv.UpdateViewData(ctx, req)
			}),
		},
		Streams:  []grpc.StreamDesc{},
		Metadata: "collab.proto",
	}
	s.RegisterService(&desc, srv)
}

// ---------- Implementation ----------

type collabServer struct {
	db     db.DB
	engine *workflow.Engine
}

// doGetUser/doValidateAPIKey/doIsWorkspaceMember hold the shared auth-lookup
// logic used by both CollabService and MessagingService — each service
// keeps its own thin wrapper methods (independent client protocols) but
// delegates to the same implementation to avoid duplicating the bcrypt/
// prefix-lookup logic.
func doGetUser(database db.DB, req *GetUserRequest) (*GetUserResponse, error) {
	user, err := database.FindUserByID(req.ID)
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return &GetUserResponse{Found: false}, nil
		}
		return nil, status.Errorf(codes.Internal, "find user: %v", err)
	}
	return &GetUserResponse{
		Found:    true,
		ID:       user.ID,
		Name:     user.Name,
		Disabled: user.Disabled,
	}, nil
}

func doValidateAPIKey(database db.DB, req *ValidateAPIKeyRequest) (*ValidateAPIKeyResponse, error) {
	if !util.ValidateAPIKeyFormat(req.Key) {
		return &ValidateAPIKeyResponse{Valid: false}, nil
	}

	prefix := util.ExtractPrefix(req.Key)
	apiKeyRecord, err := database.FindAPIKeyByPrefix(prefix)
	if err != nil {
		return &ValidateAPIKeyResponse{Valid: false}, nil
	}

	if apiKeyRecord.ExpiresAt != "" {
		expiresAt, err := time.Parse(time.RFC3339, apiKeyRecord.ExpiresAt)
		if err == nil && time.Now().UTC().After(expiresAt) {
			return &ValidateAPIKeyResponse{Valid: false}, nil
		}
	}

	if err := bcrypt.CompareHashAndPassword([]byte(apiKeyRecord.KeyHash), []byte(req.Key)); err != nil {
		return &ValidateAPIKeyResponse{Valid: false}, nil
	}

	user, err := database.FindUserByID(apiKeyRecord.UserID)
	if err != nil {
		return &ValidateAPIKeyResponse{Valid: false}, nil
	}

	go func() {
		apiKeyRecord.LastUsedAt = time.Now().UTC().Format(time.RFC3339)
		database.UpdateAPIKey(apiKeyRecord)
	}()

	return &ValidateAPIKeyResponse{
		Valid:    true,
		UserID:   user.ID,
		UserName: user.Name,
		Disabled: user.Disabled,
	}, nil
}

func doIsWorkspaceMember(database db.DB, req *IsWorkspaceMemberRequest) (*IsWorkspaceMemberResponse, error) {
	members, err := database.FindWorkspaceUsers(model.WorkspaceUserFilter{
		UserID:      req.UserID,
		WorkspaceID: req.WorkspaceID,
	})
	if err != nil {
		return nil, status.Errorf(codes.Internal, "find workspace users: %v", err)
	}
	return &IsWorkspaceMemberResponse{IsMember: len(members) > 0}, nil
}

func (s *collabServer) GetUser(ctx context.Context, req *GetUserRequest) (*GetUserResponse, error) {
	return doGetUser(s.db, req)
}

func (s *collabServer) ValidateAPIKey(ctx context.Context, req *ValidateAPIKeyRequest) (*ValidateAPIKeyResponse, error) {
	return doValidateAPIKey(s.db, req)
}

func (s *collabServer) IsWorkspaceMember(ctx context.Context, req *IsWorkspaceMemberRequest) (*IsWorkspaceMemberResponse, error) {
	return doIsWorkspaceMember(s.db, req)
}

func (s *collabServer) GetNote(ctx context.Context, req *GetNoteRequest) (*GetNoteResponse, error) {
	note, err := s.db.FindNote(model.Note{ID: req.ID})
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return &GetNoteResponse{Found: false}, nil
		}
		return nil, status.Errorf(codes.Internal, "find note: %v", err)
	}
	return &GetNoteResponse{
		Revision: note.Revision, Generation: note.Generation,
		Found:       true,
		ID:          note.ID,
		Title:       note.Title,
		Content:     note.Content,
		Visibility:  note.Visibility,
		WorkspaceID: note.WorkspaceID,
		CreatedBy:   note.CreatedBy,
	}, nil
}

func (s *collabServer) GetView(ctx context.Context, req *GetViewRequest) (*GetViewResponse, error) {
	view, err := s.db.FindView(model.View{ID: req.ID})
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return &GetViewResponse{Found: false}, nil
		}
		return nil, status.Errorf(codes.Internal, "find view: %v", err)
	}
	return &GetViewResponse{
		Found:       true,
		ID:          view.ID,
		Data:        view.Data,
		Visibility:  view.Visibility,
		WorkspaceID: view.WorkspaceID,
		CreatedBy:   view.CreatedBy,
	}, nil
}

func (s *collabServer) UpdateNote(ctx context.Context, req *UpdateNoteRequest) (*UpdateNoteResponse, error) {
	if !isCollabService(ctx) {
		return nil, status.Error(codes.Unauthenticated, "collab service authentication required")
	}
	note, err := s.db.FindNote(model.Note{ID: req.ID})
	if err != nil {
		return nil, status.Error(codes.NotFound, "note not found")
	}
	if req.Revision == nil || req.Generation == nil || *req.Revision != note.Revision || *req.Generation != note.Generation {
		return nil, status.Error(codes.Aborted, "stale note room")
	}
	if !s.canEditNote(note, req.UpdatedBy) {
		return nil, status.Error(codes.PermissionDenied, "access denied")
	}
	changed := notehistory.Hash(note.Title, note.Content) != notehistory.Hash(req.Title, req.Content)
	if !changed {
		return &UpdateNoteResponse{Revision: note.Revision}, nil
	}
	note.Title, note.Content, note.UpdatedBy = req.Title, req.Content, req.UpdatedBy
	note.UpdatedAt = time.Now().UTC().Format(time.RFC3339Nano)
	if err := s.db.UpdateNote(note); err != nil {
		if errors.Is(err, notehistory.ErrConflict) {
			return nil, status.Error(codes.Aborted, err.Error())
		}
		return nil, status.Error(codes.Internal, "note save failed")
	}
	note.Revision++
	if s.engine != nil {
		s.engine.NotifyNoteEvent(model.WorkflowEventNoteUpdated, note, req.UpdatedBy)
	}
	return &UpdateNoteResponse{Revision: note.Revision}, nil
}

func isCollabService(ctx context.Context) bool {
	md, ok := metadata.FromIncomingContext(ctx)
	if !ok || config.C == nil {
		return false
	}
	values := md.Get("x-collab-secret")
	if len(values) != 1 {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(values[0]), []byte(config.C.GetString(config.APP_SECRET))) == 1
}

func (s *collabServer) canEditNote(n model.Note, userID string) bool {
	if userID == "" || userID == "anonymous" {
		return false
	}
	user, err := s.db.FindUserByID(userID)
	if err != nil || user.Disabled {
		return false
	}
	if n.Visibility == "private" {
		return n.CreatedBy == userID
	}
	if n.Visibility != "public" && n.Visibility != "workspace" {
		return false
	}
	members, err := s.db.FindWorkspaceUsers(model.WorkspaceUserFilter{WorkspaceID: n.WorkspaceID})
	if err != nil {
		return false
	}
	for _, m := range members {
		if m.UserID == userID {
			return true
		}
	}
	return false
}

func (s *collabServer) VersionOperation(ctx context.Context, req *model.VersionOperation) (*model.VersionResult, error) {
	if !isCollabService(ctx) {
		return nil, status.Error(codes.Unauthenticated, "collab service authentication required")
	}
	note, err := s.db.FindNote(model.Note{ID: req.NoteID})
	if err != nil {
		return nil, status.Error(codes.NotFound, "note not found")
	}
	if !s.canEditNote(note, req.UserID) || note.WorkspaceID != req.WorkspaceID {
		return nil, status.Error(codes.PermissionDenied, "access denied")
	}
	result, err := s.db.ApplyVersionOperation(*req)
	if err != nil {
		switch {
		case errors.Is(err, notehistory.ErrConflict):
			return nil, status.Error(codes.Aborted, err.Error())
		case errors.Is(err, notehistory.ErrForbidden):
			return nil, status.Error(codes.PermissionDenied, err.Error())
		case errors.Is(err, notehistory.ErrInvalid):
			return nil, status.Error(codes.InvalidArgument, err.Error())
		case errors.Is(err, gorm.ErrRecordNotFound):
			return nil, status.Error(codes.NotFound, "version not found")
		default:
			return nil, status.Error(codes.Internal, "version operation failed")
		}
	}
	if req.VersionID != "" && !result.Replayed && s.engine != nil {
		s.engine.NotifyNoteEvent(model.WorkflowEventNoteUpdated, result.Note, req.UserID)
	}
	return &result, nil
}

func (s *collabServer) UpdateViewData(ctx context.Context, req *UpdateViewDataRequest) (*UpdateViewDataResponse, error) {
	// UpdateView with struct uses GORM Updates which skips zero-value fields,
	// so only Data and UpdatedAt are changed.
	if err := s.db.UpdateView(model.View{ID: req.ID, Data: req.Data, UpdatedAt: req.UpdatedAt}); err != nil {
		return nil, status.Errorf(codes.Internal, "update view: %v", err)
	}
	return &UpdateViewDataResponse{}, nil
}

// ---------- Start ----------

// NewServer builds the gRPC server with both the collab service and the
// runner service registered. Shared with tests.
func NewServer(database db.DB, engine *workflow.Engine, store storage.Storage) *grpc.Server {
	srv := grpc.NewServer(grpc.ChainUnaryInterceptor(runnerAuthInterceptor(database)))
	registerCollabServiceServer(srv, &collabServer{db: database, engine: engine})
	registerRunnerServiceServer(srv, &runnerServer{db: database, engine: engine, storage: store})
	registerMessagingServiceServer(srv, &messagingServer{db: database, engine: engine})
	return srv
}

func Start(database db.DB, port string, engine *workflow.Engine, store storage.Storage) {
	lis, err := net.Listen("tcp", ":"+port)
	if err != nil {
		log.Fatalf("[gRPC] listen on :%s failed: %v", port, err)
	}
	srv := NewServer(database, engine, store)
	log.Printf("[gRPC] CollabService and RunnerService listening on :%s", port)
	if err := srv.Serve(lis); err != nil {
		log.Fatalf("[gRPC] serve failed: %v", err)
	}
}
