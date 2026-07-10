package workflow

import (
	"sync"

	"github.com/collabreef/collabreef/internal/db"
	"github.com/collabreef/collabreef/internal/model"
)

// Engine ties together the note-event dispatcher, the cron scheduler and the
// job queue. A single instance lives in the API process; handlers and the
// runner gRPC service both talk to it.
type Engine struct {
	db         db.DB
	queue      *Queue
	dispatcher *Dispatcher
	scheduler  *Scheduler
}

func NewEngine(database db.DB) *Engine {
	q := NewQueue()
	return &Engine{
		db:         database,
		queue:      q,
		dispatcher: NewDispatcher(database, q),
		scheduler:  NewScheduler(database, q),
	}
}

// Start loads cron schedules and begins firing them.
func (e *Engine) Start() {
	e.scheduler.Reload()
}

func (e *Engine) Stop() {
	e.scheduler.Stop()
	e.dispatcher.Stop()
}

// ReloadSchedules rebuilds cron entries after workflow definitions change.
func (e *Engine) ReloadSchedules() {
	e.scheduler.Reload()
}

// WakeQueue wakes runners long-polling for queued jobs.
func (e *Engine) WakeQueue() {
	e.queue.Wake()
}

// NotifyNoteEvent reports a note change from either write path (REST handler
// or collab gRPC write-back).
func (e *Engine) NotifyNoteEvent(event string, note model.Note, actorID string) {
	e.dispatcher.NotifyNoteEvent(event, note, actorID)
}

// ClaimJob hands the oldest matching queued job to a runner.
func (e *Engine) ClaimJob(runnerID string, labels []string) (model.WorkflowJob, error) {
	return e.queue.Claim(e.db, runnerID, labels)
}

// WakeChan returns a channel closed on the next queue wake-up; long-pollers
// select on it.
func (e *Engine) WakeChan() <-chan struct{} {
	return e.queue.WakeChan()
}

// Queue coordinates queued-job handoff between the trigger sources and
// long-polling runners. Claims are serialized so sqlite never sees two
// concurrent claim transactions.
type Queue struct {
	mu      sync.Mutex
	wake    chan struct{}
	claimMu sync.Mutex
}

func NewQueue() *Queue {
	return &Queue{wake: make(chan struct{})}
}

// Wake releases every waiter by closing the current wake channel and
// replacing it with a fresh one.
func (q *Queue) Wake() {
	q.mu.Lock()
	defer q.mu.Unlock()
	close(q.wake)
	q.wake = make(chan struct{})
}

func (q *Queue) WakeChan() <-chan struct{} {
	q.mu.Lock()
	defer q.mu.Unlock()
	return q.wake
}

func (q *Queue) Claim(database db.DB, runnerID string, labels []string) (model.WorkflowJob, error) {
	q.claimMu.Lock()
	defer q.claimMu.Unlock()
	return database.ClaimQueuedWorkflowJob(runnerID, labels)
}
