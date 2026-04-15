# Heimdall v2: Jira-to-PR Autonomous Implementation

**Date:** 2026-04-14
**Status:** Design approved, pending implementation plan

## Overview

Evolve Heimdall from a PR review watcher into an autonomous coding agent. When a Jira issue is assigned to the user, Heimdall triages it (evaluates quality, scope, complexity), notifies the user with a structured assessment, and — upon approval — implements the issue in an isolated git worktree, runs tests, and opens a draft PR on GitHub.

## Architecture: Two-Loop Model

Two independent processes, separated by a file-based queue:

```
┌─────────────────────────────────────────────────────────┐
│                    JIRA CLOUD                           │
│              (issues assigned to you)                   │
└──────────────────────┬──────────────────────────────────┘
                       │ REST API (fetch + API token)
                       ▼
┌─────────────────────────────────────────────────────────┐
│              WATCHER (launchd, every 10min)              │
│                                                         │
│  JiraSource.poll()  →  TriageAction  →  NotifyAction    │
│  (fetch assigned)     (Claude -p)      (terminal-notifier)
│                       scores 0-9       [Approve] [Click] │
│                       size S/M/L                         │
│                                                         │
│  On approve: write to ~/.heimdall/queue/PROJ-123.json   │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│              WORKER (spawned on demand)                  │
│                                                         │
│  Picks up from queue/  →  git worktree  →  claude -p    │
│                           (isolated)     (brainstorm →   │
│                                           plan →         │
│                                           implement)     │
│                                                         │
│  On finish:  gh pr create --draft                       │
│              notify with summary (cost, confidence, time)│
│              move queue item to completed/               │
└─────────────────────────────────────────────────────────┘
```

**Watcher:** Fast, stateless poll cycle. Same launchd model as existing Heimdall. Polls Jira, triages new issues, sends notifications. Writes approved items to queue.

**Worker:** Long-running, spawned per approved issue. Creates worktree, spawns Claude Code, creates draft PR, reports results. Runs independently from the watcher.

## Component 1: Jira Source

**Module:** `src/sources/jira.ts` — implements existing `Source` interface.

**Integration method:** Direct Jira REST API via `fetch()`. Zero external dependencies.

**Implementation note:** When implementing the Jira REST API integration, use context7 MCP tool to fetch current Jira Cloud REST API documentation. Do not rely on training data for API endpoints, field names, or query parameters — the API evolves and context7 will provide the latest correct reference.

**Authentication:** API token + email. Token stored via `"env:JIRA_API_TOKEN"` syntax in config (reads from environment variable at runtime).

**Polling:** `GET /rest/api/3/search?jql=<configured JQL>` returns assigned issues. Response normalized into Heimdall's internal `PollResult` type. Deduplication via existing `seen.json` state, keyed by Jira issue key.

**Configuration:**

```json
{
  "type": "jira",
  "baseUrl": "https://team.atlassian.net",
  "email": "you@company.com",
  "apiToken": "env:JIRA_API_TOKEN",
  "jql": "assignee = currentUser() AND status = 'To Do'",
  "projects": {
    "PROJ": { "repo": "org/repo-name", "cwd": "/path/to/local/checkout" },
    "SIG": { "repo": "org/signal-iq", "cwd": "/path/to/signal-iq" }
  }
}
```

**Projects map:** Links Jira project keys to local Git repos and checkout paths. Required for worktree creation and Claude context.

## Component 2: Triage Action

**Module:** `src/actions/triage.ts` — implements existing `Action` interface.

### Phase 1: Claude Evaluation

Spawns a short `claude -p` session with the issue data and a structured rubric prompt. Uses `--output-format json` for structured output + token usage tracking. Model: Sonnet by default (fast, cheap).

Claude returns structured JSON:

```json
{
  "criteria": {
    "acceptance_clarity": 2,
    "scope_boundedness": 3,
    "technical_detail": 1
  },
  "total": 6,
  "max": 9,
  "size": "M",
  "verdict": "Well-defined. Touches auth middleware and its tests.",
  "concerns": "No error handling scenarios specified.",
  "suggested_files": ["src/auth/middleware.ts", "src/auth/middleware.test.ts"]
}
```

### Phase 2: Threshold Check

Configurable rubric:

```json
{
  "triage": {
    "threshold": 6,
    "maxSize": "L",
    "model": "sonnet",
    "timeoutMinutes": 120
  }
}
```

- Score >= threshold AND size <= maxSize: **"ready"** — notification with Approve button
- Below threshold: **"needs detail"** — notification with what's missing
- Size XL: **"too big"** — notification suggesting decomposition

### Triage Report

Saved to `~/.heimdall/triage/PROJ-123.md`. This is what `heimdall triage PROJ-123` renders in terminal.

## Component 3: Notification & Approval Flow

Extends existing `NotifyAction` with new notification types.

### Triage Notification (ready)

```
Title:    "Heimdall — PROJ-123"
Subtitle: "Auth middleware refactor"
Message:  "Score: 7/9 (High) | Size: M | 3 files\nReady for implementation"
Click:    executes `heimdall triage PROJ-123`
Action:   "Approve" → executes `heimdall approve PROJ-123`
```

- **Default click** opens terminal with full triage report + y/n prompt (via `heimdall triage`)
- **Approve button** queues directly without viewing (fast path)
- **Ignore** = skip. Unapproved issues older than `timeoutMinutes` are marked "skipped" in `seen.json`

### Needs-Detail Notification

```
Title:    "Heimdall — PROJ-123"
Message:  "Score: 3/9 — Missing acceptance criteria, scope unclear"
Click:    opens Jira issue URL in browser
```

### Terminal Triage View

`heimdall triage PROJ-123` renders the full report via `glow` or `bat` (pretty markdown in terminal) and prompts:

```
┌─ PROJ-123: Auth middleware refactor ───────────────┐
│ Confidence: 7/9  │  Size: M  │  Files: 3          │
├────────────────────────────────────────────────────┤
│ ... full triage report ...                          │
└────────────────────────────────────────────────────┘

Approve this for Heimdall? [y/n]:
```

## Component 4: Queue

File-based queue in `~/.heimdall/queue/`.

**Queue item** (`PROJ-123.json`):

```json
{
  "issueKey": "PROJ-123",
  "title": "Auth middleware refactor",
  "description": "...",
  "approvedAt": "2026-04-14T10:30:00Z",
  "status": "pending",
  "triageReport": "~/.heimdall/triage/PROJ-123.md",
  "repo": "org/repo-name",
  "cwd": "/path/to/checkout"
}
```

**Statuses:** `pending` → `in_progress` → `completed` | `failed`

FIFO ordering. Worker picks up oldest pending item. Configurable max parallel workers (default: 1).

## Component 5: Worker & Implementation Engine

**Module:** `src/worker.ts` + CLI command `heimdall worker`.

### Lifecycle Per Queue Item

1. Pick up `PROJ-123.json` from queue → set status: `"in_progress"`
2. Create worktree: `git worktree add ~/.heimdall/worktrees/PROJ-123 -b heimdall/PROJ-123`
3. Spawn `claude -p` with implementation prompt in worktree directory
4. On exit → parse `stream-json` output for token usage, test results
5. Push branch → `gh pr create --draft`
6. Send completion notification with summary
7. Update queue item to `"completed"` or `"failed"`
8. Clean up worktree (on success) or preserve (on failure)

### Claude Invocation

```bash
claude -p "<prompt>" --permission-mode auto --output-format stream-json
```

**Prompt template:**

```
You are implementing Jira issue PROJ-123: <title>

## Issue Description
<full description + acceptance criteria from Jira>

## Triage Analysis
<contents of triage report>

## Instructions
- Working directory: <worktree path>
- Use the brainstorming skill if the approach isn't obvious
- Use the writing-plans skill to create a plan before coding
- Run tests after implementation
- Commit your changes with a descriptive message referencing PROJ-123
- If you get stuck or tests won't pass after 3 attempts, commit what you have and stop
```

Claude picks up the user's installed skills (superpowers brainstorming, writing-plans, etc.), CLAUDE.md, CodeGraph, and MCP servers automatically.

### Configuration

```json
{
  "worker": {
    "maxParallel": 1,
    "model": "opus",
    "worktreeDir": "~/.heimdall/worktrees",
    "maxTurns": 100,
    "claudeArgs": ["--permission-mode", "auto", "--output-format", "stream-json"]
  }
}
```

### Failure Handling

- Non-zero exit or max turns hit → status: `"failed"`
- Still pushes branch + creates draft PR marked `## Incomplete Implementation`
- Notification: "PROJ-123 failed — partial PR opened, branch preserved"
- Worktree preserved for manual pickup. `heimdall clean` prunes old worktrees.

## Component 6: Draft PR & Summary

Heimdall creates the PR after Claude exits via `gh pr create --draft`.

### PR Format

**Title:** `[Heimdall] PROJ-123: <issue title>`

**Body:**

```markdown
## Summary
<Claude's commit message / implementation description>

## Heimdall Report
| Metric | Value |
|--------|-------|
| Jira Issue | [PROJ-123](https://team.atlassian.net/browse/PROJ-123) |
| Confidence | 7/9 (High) |
| Size | M |
| Time | Triage: 1m 12s — Implementation: 8m 34s |
| Cost | ~$0.47 (input: 82k, output: 12k, cache: 45k) |
| Model | claude-opus-4-6 |
| Tests | 14 passing, 0 failing |
| Files changed | 3 |

## Status
✅ Complete (or ⚠️ Incomplete — <reason>)

## Triage Analysis
<embedded triage report>

---
Generated by Heimdall — The All-Seeing PR Guardian
```

### Cost Calculation

Token counts from `stream-json` output, multiplied by configurable per-model pricing:

```json
{
  "costs": {
    "claude-opus-4-6": { "inputPer1k": 0.015, "outputPer1k": 0.075 },
    "claude-sonnet-4-6": { "inputPer1k": 0.003, "outputPer1k": 0.015 }
  }
}
```

Accumulated across triage + implementation phases.

### Completion Notification

```
Title:    "Heimdall ✓ — PROJ-123"
Message:  "PR opened | 7/9 confidence | $0.47 | 8m 34s"
Click:    opens the PR URL in browser
```

## New CLI Commands

| Command | Purpose |
|---------|---------|
| `heimdall triage <KEY>` | Render triage report in terminal + approve prompt |
| `heimdall approve <KEY>` | Queue issue for implementation, spawn worker |
| `heimdall worker` | Start worker process (picks up queue items) |
| `heimdall queue` | List queue items with status |
| `heimdall clean` | Remove completed/old worktrees |

Existing commands (`run`, `install`, `start`, `stop`, `status`, `logs`, `uninstall`, `reinstall`) unchanged.

## Filesystem Layout

```
~/.heimdall/
├── config.json          # all configuration
├── seen.json            # deduplication state
├── heimdall.log         # watcher logs
├── queue/               # pending/in-progress items
│   └── PROJ-123.json
├── triage/              # triage reports
│   └── PROJ-123.md
├── worktrees/           # git worktrees (temporary)
│   └── PROJ-123/
├── runs/                # completed run artifacts
│   └── PROJ-123/
│       ├── triage.md
│       ├── implementation.log
│       └── summary.json
└── reviews/             # existing PR reviews (unchanged)
```

## Design Decisions

1. **Two-loop over monolith:** Watcher stays fast (launchd-friendly). Worker runs as long as needed without blocking polls.
2. **File-based queue over SQLite:** Simpler, zero deps, inspectable. Upgradeable to SQLite later without architectural change.
3. **Direct Jira REST API over MCP:** Self-contained, no runtime dependency on MCP infrastructure. Claude still gets MCP tools during implementation.
4. **`claude -p` over Agent SDK:** Reuses user's existing Claude Code installation with all skills, CLAUDE.md, hooks, and MCP servers. No npm dependency.
5. **Heimdall owns PR creation over Claude:** Consistent format, structured summary, reliable metadata.
6. **Worktree per issue:** Full isolation, shared Git object store, clean branch management.
7. **Notification + terminal approval over web/Slack:** Terminal-native, matches existing UX, no new infrastructure.
8. **Structured triage rubric over black-box yes/no:** Tunable threshold, transparent scoring, auditable.

## Out of Scope (for now)

- Jira write-back (commenting on issues, transitioning status)
- Retry with different approach on failure
- Multi-repo issues (single repo per issue)
- Automatic decomposition of large issues
- Cost budgets / spending limits
- PR review feedback loop (Claude responding to review comments)
