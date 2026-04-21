# Local UI Action Center — Design Spec

## Problem

Heimdall sends macOS notifications for triage completions and review results, but clicking a notification leads to a read-only report page. The user must switch to a terminal to act (approve triage, start worker, check queue). This breaks the notification-to-action flow.

Additionally, terminal-notifier 2.0.0 dropped action button support, so the `-actions "Approve"` and `-execute` flags in `notify.ts` are dead code.

## Solution

Upgrade the existing HTTP server (port 7878) from a read-only report viewer to a lightweight action center. Add actionable endpoints, a dashboard home page, a queue page, and shared navigation. Complement the CLI — don't replace it.

## Scope

**In scope:**
- Dashboard home page (`/`)
- Queue page with worker status (`/queue`)
- Approve action on triage detail page (POST endpoint + sticky bottom bar UI)
- Start Worker button on queue page (POST endpoint)
- Worker heartbeat/PID file for status detection
- Shared navigation bar across all pages
- Clean up dead terminal-notifier flags

**Out of scope:**
- Replacing CLI commands (daemon lifecycle, logs, re-triage, clean)
- Frontend framework, client-side JS beyond form submission
- Authentication (localhost only)
- WebSocket live updates

## Pages

### 1. Dashboard (`/`)

Compact, terminal-style layout. Monospace font, dense information. Three sections stacked vertically:

**Worker status line:**
- Read `~/.heimdall/worker.pid` and `~/.heimdall/worker.heartbeat`
- Display one of:
  - `Worker: idle` (no PID file or stale heartbeat > 60s)
  - `Worker: ITRE-159 (12m)` (active heartbeat + in_progress queue item)
  - `Worker: dead (stale heartbeat)` (PID file exists but heartbeat > 60s)
- Status dot: green (active), gray (idle), red (dead)

**Queue summary table:**
- Show items with status `pending` or `in_progress` (max ~5 most recent)
- Columns: issue key (link to triage), title (truncated), status, approved time
- "Start Worker" button if worker is idle and pending items exist

**Recent activity:**
- Last 5 triage verdicts + review verdicts, one line each
- Format: `ITRE-159 triaged → ready` / `PR #42 reviewed → PASS`
- Each links to its detail page

### 2. Triage Detail (`/triage/:key`) — Modified

Existing page unchanged except:

**Sticky bottom bar** (fixed to bottom of viewport):
- Left side: verdict badge + confidence text (e.g., `ready · high confidence`)
- Right side: Approve button
- Approve button only shown when:
  - `verdict === "ready"`
  - Item is not already in the queue
- Button submits `POST /triage/:key/approve`
- After approve: redirect to `/queue`

**Already-approved state:**
- If item exists in queue, bottom bar shows status instead: `Queued (pending)` / `In progress` / `Completed → PR #123`

### 3. Queue Page (`/queue`) — New

**Worker status** at top (same as dashboard).

**Queue table:**
- All queue items from `~/.heimdall/queue/*.json`
- Columns: issue key, title, status badge, approved time, branch, PR link (if exists)
- Status badges: pending (gray), in_progress (yellow), completed (green), failed (red)
- Sorted: in_progress first, then pending, then completed/failed by date

**Start Worker button:**
- Shown when worker is idle (no active heartbeat) and at least one `pending` item exists
- Submits `POST /worker/start`
- Spawns `heimdall worker` as detached child process
- After start: redirect to `/queue`

### 4. Existing Pages — Minimal Changes

**Reviews listing (`/reviews`):** Add nav bar only.

**Review detail (`/reviews/:owner/:repo/PR-:n`):** Add nav bar only.

**Triage listing (`/triage`):** Add nav bar only.

## Navigation Bar

Added to `pageShell()` via new `activePage` parameter:

```ts
function pageShell(title: string, body: string, activePage?: string): string
```

Renders as:

```
Dashboard  |  Reviews  |  Triage  |  Queue
```

- Current page highlighted (bold + accent color)
- Same monospace, minimal style as existing theme
- Error flash messages (from `?error=` query params) rendered as a red banner at the top of the page body

## New API Endpoints

### `POST /triage/:key/approve`

**Logic** (extracted from `src/cli/approve.ts`):
1. Load triage report JSON from `~/.heimdall/triage/:key.json`
2. Validate verdict is `ready`
3. Look up project config (same as CLI `approve`)
4. Check item not already in queue
5. Create `QueueItem` and enqueue via `QueueManager`
6. Redirect to `/queue` with 303

**Error handling:**
- No triage report → redirect to `/triage` with flash message (query param `?error=no-report`)
- Verdict not ready → redirect back with `?error=not-ready`
- Already queued → redirect to `/queue` (idempotent)
- No project config → redirect back with `?error=no-config`

### `POST /worker/start`

**Logic:**
1. Check heartbeat — if worker already running, redirect to `/queue`
2. Spawn `heimdall worker` as detached child:
   ```ts
   Bun.spawn(["heimdall", "worker"], {
     cwd: "/",
     stdout: "ignore",
     stderr: "ignore",
     detached: true,
   });
   ```
3. Redirect to `/queue` with 303

The spawned process is fully detached — server doesn't track it. Status comes from heartbeat files.

## Worker Heartbeat

Small addition to `Worker` class in `src/worker.ts`:

**On worker start:**
- Write `~/.heimdall/worker.pid` containing `process.pid`
- Start interval: write current ISO timestamp to `~/.heimdall/worker.heartbeat` every 10 seconds

**On worker exit (normal or error):**
- Remove `worker.pid` and `worker.heartbeat` files
- Use `process.on("exit", cleanup)` and `process.on("SIGTERM", cleanup)`

**Status detection (used by dashboard + queue page):**

```ts
function getWorkerStatus(): "active" | "idle" | "dead" {
  const pidPath = join(heimdallDir, "worker.pid");
  const heartbeatPath = join(heimdallDir, "worker.heartbeat");

  if (!existsSync(pidPath)) return "idle";

  if (!existsSync(heartbeatPath)) return "dead";

  const heartbeat = readFileSync(heartbeatPath, "utf-8").trim();
  const age = Date.now() - new Date(heartbeat).getTime();

  if (age > 60_000) return "dead";
  return "active";
}
```

## Refactoring: Shared Approve Logic

The approval logic currently lives in `src/cli/approve.ts` and reads `process.argv` directly. Extract the core logic into a reusable function:

**New:** `src/approve.ts` (or add to existing module)
```ts
export async function approveIssue(issueKey: string): Promise<{ ok: true } | { ok: false; error: string }>
```

Contains the config lookup, queue check, and enqueue logic. Both CLI (`src/cli/approve.ts`) and server POST handler call this.

## Notification Cleanup

In `src/actions/notify.ts`:

**`sendTriageNotification`** — Remove `-actions "Approve"` and `-execute` flags (dead on terminal-notifier 2.0.0). Keep `-open triageUrl` — this is the click-through to the web UI where the approve button now lives.

**`sendReviewComplete`** — Remove `-actions "Open PR"` and `-execute "open ${prUrl}"`. Keep `-open reviewUrl`.

## File Changes Summary

| File | Change |
|------|--------|
| `src/server.ts` | Add nav bar to `pageShell()`, add `/queue` page, add `POST /triage/:key/approve`, add `POST /worker/start`, modify `/` to render dashboard, modify triage detail to include sticky bottom bar |
| `src/approve.ts` | New: extracted `approveIssue()` function |
| `src/cli/approve.ts` | Refactor to call `approveIssue()` |
| `src/worker.ts` | Add PID file + heartbeat interval + cleanup on exit |
| `src/actions/notify.ts` | Remove dead `-actions`/`-execute` flags from `sendTriageNotification` and `sendReviewComplete` |
| `src/types.ts` | No changes needed — existing types sufficient |

## Testing

- **`approveIssue()`** — unit test: validates report, rejects non-ready verdicts, creates queue item, is idempotent
- **`getWorkerStatus()`** — unit test: returns correct state for missing/stale/fresh heartbeat files
- **Server routes** — manual testing: start server, hit endpoints, verify redirects and HTML output
- **Worker heartbeat** — manual testing: start worker, verify PID + heartbeat files appear and update, kill worker, verify cleanup
