# Review Web UI, Verdict Notifications & CLI Open

**Date:** 2026-04-17
**Status:** Draft
**Author:** Oskar + Claude

## Summary

Three connected improvements to Heimdall's PR review experience:

1. **Verdict in notifications** — Parse the existing `VERDICT:` line from review reports and show `PASS`, `PASS (conditional)`, or `FAIL` in the macOS notification
2. **Review web UI** — Embedded `Bun.serve()` in the daemon that renders review reports as HTML, accessible via notification click or browser
3. **CLI `open` command** — `heimdall open 65` opens the review for PR #65 in the browser, auto-detecting the repo from cwd

## Verdict Parsing

### Type

```typescript
type ReviewVerdict = "PASS" | "PASS (conditional)" | "FAIL" | "unknown";
```

### Logic

New file `src/verdict.ts` with a single function:

```typescript
function parseVerdict(reportContent: string): ReviewVerdict
```

Parses the `VERDICT:` line from review markdown. The existing reports use these patterns:

- `VERDICT: **PASS**` -> `"PASS"`
- `VERDICT: **PASS (conditional — ...)** ` -> `"PASS (conditional)"`
- `VERDICT: **FAIL**` -> `"FAIL"`
- Not found / unparseable -> `"unknown"`

Regex: match `VERDICT:\s*\*\*(.+?)\*\*`, then normalize the captured group:
- Contains "PASS" and "conditional" -> `"PASS (conditional)"`
- Contains "PASS" -> `"PASS"`
- Contains "FAIL" -> `"FAIL"`
- Otherwise -> `"unknown"`

### Where Used

- `scheduler.ts` — after review completes, read report, call `parseVerdict()`, pass to `notifyComplete()`
- `server.ts` — render verdict badge on listing and report pages

## Notification Changes

### `notifyComplete()` — New Signature

```typescript
async notifyComplete(
  pr: PullRequest,
  reportPath: string,
  verdict: ReviewVerdict,
  reviewUrl: string     // http://localhost:{port}/reviews/{owner}/{repo}/PR-{number}
): Promise<ActionResult>
```

### Notification Content

| Field | Value |
|-------|-------|
| Title | `Heimdall ✓` (PASS) / `Heimdall ⚠` (conditional) / `Heimdall ✗` (FAIL/unknown) |
| Subtitle | `{repo}` |
| Message | `PR #{number}: {verdict} — {title}` |
| Click | Opens `reviewUrl` (local web server) |
| Action button | "Open PR" — opens GitHub PR URL |

### terminal-notifier Integration

```
terminal-notifier \
  -title "Heimdall ✓" \
  -subtitle "appfire-team/signal-iq" \
  -message "PR #64: PASS — Implement base structure of action layer" \
  -open "http://localhost:7878/reviews/appfire-team/signal-iq/PR-64" \
  -actions "Open PR" \
  -execute "open https://github.com/appfire-team/signal-iq/pull/64" \
  -sound Glass \
  -group heimdall-appfire-team/signal-iq-64
```

Click -> review in browser. "Open PR" button -> GitHub.

### `notifyStart()` — Unchanged

Still opens GitHub PR URL. No verdict available yet.

## Daemon Model Change

The current daemon model is **ephemeral**: launchd calls `heimdall run` every 600s via `StartInterval`, it does one poll cycle and exits. A `Bun.serve()` web server needs a **persistent** process.

### Change

Convert `heimdall run` to a persistent process:
1. Start the web server (`Bun.serve()`)
2. Run one poll cycle immediately
3. Schedule subsequent cycles via `setInterval(runCycle, config.interval * 1000)`
4. Process stays alive (kept alive by `Bun.serve()` + `setInterval`)

Add `--once` flag to preserve the current single-cycle behavior for testing/debugging:
```
heimdall run          # persistent (server + poll loop)
heimdall run --once   # single cycle, no server, exits when done
```

### launchd Plist Change

Replace `StartInterval` with `KeepAlive`:

```xml
<!-- Before -->
<key>StartInterval</key>
<integer>600</integer>

<!-- After -->
<key>KeepAlive</key>
<true/>
```

This means launchd restarts Heimdall if it crashes, but doesn't call it repeatedly — Heimdall manages its own poll schedule internally.

### Files Affected

- `src/cli/run.ts` — add server startup, setInterval loop, `--once` flag
- `src/cli/install.ts` — update plist template from StartInterval to KeepAlive

## Embedded Web Server

### Config

New field in `HeimdallConfig`:

```typescript
server: { port: number }  // default: 7878
```

Added to `DEFAULT_CONFIG` in `config.ts`.

### Startup

`startServer(config, logger)` called from the `run` command before the poll loop. Returns the `Server` instance. Single file: `src/server.ts`.

### Routes

| Route | Response |
|-------|----------|
| `GET /` | Redirect to `/reviews` |
| `GET /reviews` | HTML listing of all reviews, grouped by repo, sorted newest first |
| `GET /reviews/:owner/:repo/PR-:number` | Single review rendered as HTML |

### Review Listing (`/reviews`)

- Glob `~/.heimdall/reviews/**/*.md` to discover all reports
- For each report: extract PR number, repo (from path), title, date, verdict (from content)
- Group by repo, sort by review date descending
- Each row: PR number, title, author, date, verdict badge (green/yellow/red)
- Each row links to the full review page

### Single Review (`/reviews/:owner/:repo/PR-:number`)

- Read the `.md` file from `~/.heimdall/reviews/{owner}/{repo}/PR-{number}.md`
- Convert markdown to HTML using simple regex-based converter:
  - Headers (`#` -> `<h1>`, etc.)
  - Code blocks (fenced ``` -> `<pre><code>`)
  - Tables (`|` delimited -> `<table>`)
  - Bold/italic
  - Lists
- Inline CSS: clean, dark-friendly, monospace for code
- Verdict badge at top, prominently displayed
- Link to GitHub PR in header
- 404 if report not found

### No npm Dependencies

The markdown converter is regex-based, covering the patterns used in review reports. Not a full markdown parser — just enough for headers, code, tables, bold, italic, and lists.

## CLI `open` Command

### Usage

```
heimdall open <pr-number>
```

### Behavior

1. Run `git remote get-url origin` in cwd to detect `owner/repo`
2. Check if `~/.heimdall/reviews/{owner}/{repo}/PR-{number}.md` exists
3. If found: `open http://localhost:7878/reviews/{owner}/{repo}/PR-{number}`
4. If not found: error with `No review found for PR #{number} in {owner}/{repo}`
5. If not in a git repo: error with `Not in a git repository. Available repos:` + list repos from reviews dir

### New File

`src/cli/open.ts` — exports `open()` function.

### CLI Entry

Add `case "open"` to `src/index.ts`.

## Scheduler Integration

In `scheduler.ts`, after `ReviewAction.execute()` returns a `reportPath`:

```typescript
// Current flow
if (result.reportPath) {
  await state.markReviewed(pr, result.reportPath);
  if (notifyAction) {
    await notifyAction.notifyComplete(pr, result.reportPath);
  }
}

// New flow
if (result.reportPath) {
  await state.markReviewed(pr, result.reportPath);
  if (notifyAction) {
    const content = await Bun.file(result.reportPath).text();
    const verdict = parseVerdict(content);
    const reviewUrl = `http://localhost:${config.server.port}/reviews/${pr.repo}/PR-${pr.number}`;
    await notifyAction.notifyComplete(pr, result.reportPath, verdict, reviewUrl);
  }
}
```

## Files Changed

| File | Change |
|------|--------|
| `src/types.ts` | Add `ReviewVerdict` type, `server: { port: number }` to `HeimdallConfig` |
| `src/config.ts` | Add `server: { port: 7878 }` to `DEFAULT_CONFIG` |
| `src/verdict.ts` | **New** — `parseVerdict()` function |
| `src/server.ts` | **New** — `startServer()` with routes + markdown renderer |
| `src/actions/notify.ts` | Update `notifyComplete()` — new signature, two-button behavior, verdict in message |
| `src/scheduler.ts` | Parse verdict after review, pass to `notifyComplete()` with review URL |
| `src/cli/run.ts` | Convert to persistent process — server startup, `setInterval` poll loop, `--once` flag |
| `src/cli/install.ts` | Update launchd plist from `StartInterval` to `KeepAlive` |
| `src/cli/open.ts` | **New** — `open` command |
| `src/index.ts` | Add `case "open"` |
| `docs/specs/2026-04-13-heimdall-design.md` | Update project structure, CLI commands, data flow, config, daemon model, notifications sections |

## Not Changed

Sources, review action, triage, worker, state, queue, git helpers — no reason to touch them.
