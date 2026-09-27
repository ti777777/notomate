# Note history

Notes keep immutable, complete title and TipTap JSON snapshots. Automatic versions are
created in the same database transaction as every successful changed-content update,
including collab gRPC UpdateNote. Snapshot failure rolls back the note update. The
one-second worker only collects pending drafts left by the previous timed implementation.
Unchanged normalized content is
deduplicated. Initial, manual, pre-restore and restored snapshots are retained forever,
as are automatic snapshots. Deleting the note/workspace also deletes its history.

Manual snapshots can have a name of up to 100 Unicode code points. They intentionally
allow identical content. Existing notes receive a baseline before their first changed
write or manual snapshot. History before this feature was installed cannot be recovered.

## Access and preview

Only the current note editors may list, preview, save or restore versions: private
notes belong to their creator; workspace/public notes require workspace membership.
Public visitors never receive history. Version lookups are scoped to their note and
workspace, and the authenticated identity overrides any identity in the request body.

The note menu opens a read-only history view with a paginated timeline. The mobile view
switches between timeline and preview. Embedded views, child notes and external social
embeds are reference cards in history; they do not mount interactive apps or display
current embedded content as if it were historical. File references are preserved, but
file binaries, deleted attachments, external resources, comments and embedded app data
are not backed up by note history. Note permissions, parent and pin state are not restored.

## HTTP API

All paths below are relative to `/api/v1/workspaces/:workspaceId/notes/:id`.

| Method/path | Request / response |
| --- | --- |
| `GET /versions?cursor=&limit=30` | `{items: NoteVersion[], next_cursor: string}`; summaries omit content; limit 1–100 |
| `GET /versions/:versionId` | Complete `NoteVersion` |
| `POST /versions/prepare` | Flush live room and return `{revision, generation}` before confirmation |
| `POST /versions` | `{name?, operation_id}`; returns `{note, version, replayed}` |
| `POST /versions/:versionId/restore` | `{expected_revision, operation_id}`; same result shape |

Clients must reuse the operation ID when retrying an uncertain result. A stale restore
confirmation returns 409; read the latest content and explicitly confirm again with a
new operation ID. Permission errors return 401/403, missing/scoped resources 404,
invalid operations 400 and unavailable collaboration/persistence 503. Note responses
include `revision` and `generation`; REST updates may submit those fields for explicit
optimistic concurrency. External content updates advance generation and invalidate
existing collaboration rooms.

`NoteVersion` contains `id`, `note_id`, `workspace_id`, `sequence`, `title`, `content`,
`content_hash`, `format_version` (currently 1), `name`, `source`, `source_version_id`,
`created_at`, and `created_by`. List items also include `created_by_name`. Sources are
`initial`, `auto`, `manual`, `before_restore`, and `restore`. Automatic snapshots identify
the last editor, not every contributor. There are no individual version edit/delete APIs.

## Collaboration and failures

The browser sends an ordered `history-sync` message before manual actions. The collab
service acknowledges it after persistence. A private HTTP control listener serializes
flush/snapshot/restore per note and pauses incoming messages during the operation.
The Go API rechecks permissions and performs backup + restore + new version in one
database transaction. It emits one note-updated workflow event for a successful new
restore, and none for snapshots or idempotent replays.

Rooms are named `note:<id>:<generation>`. gRPC writes require the room's revision and
generation, and service authentication through `x-collab-secret`. Old rooms cannot
overwrite a restore. Clients receive `note-replaced`, destroy the old Y.Doc and editor
undo state, fetch the authoritative generation, and reconnect. Disconnected edited
sessions remain editable. Every title/body edit is written to localStorage before the
network document changes, scoped by user, workspace, note and browser tab. Reloads retain
the draft; reconnects retain the editor unless the generation changes. Drafts are removed
only after matching database persistence acknowledgement (or a matching REST snapshot).
If the server still matches the draft's base, local edits are replayed automatically.
Independent title/body edits can merge; competing edits to the same field or a changed
generation require review. A dialog preserves the local text and offers saving its full
rich content as a new private note, or explicitly discarding it for the server version.
Another tab's draft is recovered conservatively without silently replaying it. Save
status and the recovery entry appear inside the note menu, with no extra row above the
editor. Storage failures show an error and warn before leaving; clearing browser storage
removes local-only drafts. This is recovery for disconnected editing, not a full offline
application shell.

The collab service retries failed persistence during its two-second room check; failure
is also propagated to manual action callers. A committed restore is safe even if its HTTP
response is lost: retry with the same ID. Snapshot worker failures are logged, retain
their dirty marker and retry. The current architecture supports one collab instance;
horizontal room ownership/coordination is not included.

## Deployment and checks

1. Back up the database and apply migration 25 through the normal API startup migration.
2. Deploy API, collab and web together: older note clients do not send generation names,
   and older collab clients do not send revision/generation or service metadata.
3. Set `APP_SECRET` identically for API and collab. The control listener uses that secret
   as its bearer token and defaults to `127.0.0.1:3001`. Docker Compose binds it only on
   the private container network (`CONTROL_HOST=0.0.0.0`) and does not publish its port.
   API uses `COLLAB_CONTROL_ADDR`, default `http://127.0.0.1:3001`.
4. `NOTE_HISTORY_ENABLED=false` hides history endpoints and skips new snapshots. The
   default is enabled; leave it disabled during a coordinated rollout if necessary.
   This switch does not make old collab/client protocols compatible.
5. Monitor API `note history snapshot failed` and collab `[Note history]` logs. Storage
   can be measured with `COUNT(*)` and `SUM(LENGTH(content))` on `note_versions`; no
   retention job removes history. Content strings are not written to diagnostic logs.

Tests:

```text
cd api
go test ./...
# Optional: set HISTORY_TEST_POSTGRES_DSN for an isolated schema in a test Postgres DB.
# The lifecycle suite always runs on SQLite and also runs on Postgres when configured.

cd ../collab
node --test src/note-history.test.js src/note-history.integration.test.js
# Integration test uses the web app's installed provider package.

cd ../web
node --experimental-strip-types --test tests/note-draft.test.mjs
npm run build
```

Migration rollback removes version history. Do not roll it back on a production database
without first retaining a database backup containing `note_versions`.
