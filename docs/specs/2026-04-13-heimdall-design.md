# Heimdall — The All-Seeing PR Guardian

**Date:** 2026-04-13
**Status:** Draft
**Author:** Oskar + Claude

## Summary

Heimdall is a standalone Bun/TypeScript CLI daemon that watches for GitHub PR review requests, sends macOS notifications, and automatically dispatches Claude Code review sessions in parallel. It compiles to a single binary and is designed for extensibility (Slack, new repos, autonomous actions, Claude Channels).

## Goals

1. Detect when a PR review is requested on configured GitHub repos
2. Send a clickable macOS notification (opens the PR in browser)
3. Automatically run `/signaliq-code-review` (or any configured review prompt) via `claude -p`
4. Save review reports locally
5. Run as a macOS launchd daemon (survives reboots, handles sleep/wake)
6. Compile to a standalone binary via `bun build --compile`

## Non-Goals (for v1)

- Post review comments on the PR (future v2)
- Slack integration (future — source + action plugins ready)
- Claude Channels mode (future — when Channels exits research preview)
- Auto-fix or auto-merge (future autonomous work)

## Architecture

### Plugin Architecture

Two extension points — **Sources** (where events come from) and **Actions** (what to do about them):

```
Sources → Scheduler → State Filter → Actions
```

```typescript
interface Source {
  name: string;
  poll(): Promise<PullRequest[]>;
}

interface Action {
  name: string;
  execute(pr: PullRequest, repoConfig: RepoConfig): Promise<ActionResult>;
}
```

v1 ships with:
- **Sources:** `GitHubSource` (polls via `gh pr list`)
- **Actions:** `NotifyAction` (macOS notification), `ReviewAction` (Claude Code review)

### Data Types

```typescript
interface PullRequest {
  number: number;
  title: string;
  url: string;
  headRefName: string;
  baseRefName: string;
  repo: string;               // "appfire-team/signal-iq"
  author: string;
}

interface RepoConfig {
  prompt: string;              // "/signaliq-code-review {{pr_number}}"
  cwd: string;                 // local checkout path
  allowedTools?: string[];     // CC tools to auto-approve
}

interface ActionResult {
  action: string;
  success: boolean;
  message?: string;
  reportPath?: string;         // for review action
}
```

## Project Structure

```
heimdall/
├── src/
│   ├── index.ts               # CLI entry: start|stop|status|logs|run|install|build
│   ├── config.ts              # Load + validate ~/.heimdall/config.json
│   ├── scheduler.ts           # Polling loop (setInterval-based)
│   ├── state.ts               # Seen PR tracking (~/.heimdall/seen.json)
│   ├── sources/
│   │   ├── source.ts          # Source interface
│   │   └── github.ts          # GitHubSource — Bun.spawn(["gh", ...])
│   ├── actions/
│   │   ├── action.ts          # Action interface
│   │   ├── notify.ts          # NotifyAction — terminal-notifier / osascript
│   │   └── review.ts          # ReviewAction — Bun.spawn(["claude", "-p", ...])
│   └── logger.ts              # File + stdout logger
├── package.json
├── tsconfig.json
├── build.ts                   # bun build --compile script
└── docs/
    └── specs/
        └── 2026-04-13-heimdall-design.md
```

## Configuration

Location: `~/.heimdall/config.json`

```jsonc
{
  "interval": 600,
  "sources": [
    {
      "type": "github",
      "repos": ["appfire-team/signal-iq"],
      "trigger": "review-requested"
    }
  ],
  "actions": {
    "notify": {
      "enabled": true,
      "sound": "Glass"
    },
    "review": {
      "enabled": true,
      "command": "claude",
      "defaultArgs": ["-p", "--worktree", "--permission-mode", "auto"],
      "repos": {
        "appfire-team/signal-iq": {
          "prompt": "/signaliq-code-review {{pr_number}}",
          "cwd": "/Users/oskarflores/code/innovation/signal-iq"
        }
      }
    }
  },
  "reports": {
    "dir": "~/.heimdall/reviews"
  },
  "log": {
    "file": "~/.heimdall/heimdall.log",
    "level": "info"
  }
}
```

Adding a new repo requires two edits:
1. Add to `sources[0].repos`
2. Add entry to `actions.review.repos`

## CLI Commands

| Command | Description |
|---|---|
| `heimdall start` | Start the daemon via launchd (or foreground with `--foreground`) |
| `heimdall stop` | Stop the daemon |
| `heimdall status` | Show running state, last poll time, recent reviews |
| `heimdall logs` | Tail the log file |
| `heimdall run` | Execute a single poll cycle (for testing/debugging) |
| `heimdall install` | Generate and load the launchd plist |
| `heimdall uninstall` | Unload and remove the launchd plist |
| `heimdall build` | Compile to standalone binary at `./dist/heimdall` |

## Data Flow — Single Poll Cycle

```
1. Scheduler triggers poll

2. GitHubSource.poll()
   └─ Bun.spawn(["gh", "pr", "list",
        "--repo", repo,
        "--search", "review-requested:@me",
        "--json", "number,title,url,headRefName,baseRefName,author"])
   └─ Parse JSON output → PullRequest[]

3. State.filterNew(prs)
   └─ Read ~/.heimdall/seen.json
   └─ Return only PRs not in seen set

4. For each new PR (Promise.all — parallel):
   │
   ├─ NotifyAction.execute(pr)
   │   └─ Bun.spawn(["terminal-notifier",
   │        "-title", "Heimdall",
   │        "-subtitle", pr.repo,
   │        "-message", `PR #${pr.number}: ${pr.title}`,
   │        "-open", pr.url,
   │        "-sound", "Glass"])
   │   └─ Fallback: osascript if terminal-notifier not found
   │
   └─ ReviewAction.execute(pr, repoConfig)
       └─ Bun.spawn(["claude", "-p",
            repoConfig.prompt.replace("{{pr_number}}", pr.number),
            "--permission-mode", "auto",
            "--output-format", "text"],
            { cwd: repoConfig.cwd })
       └─ Note: `/skill` syntax may not work in -p mode.
            The prompt should embed the review instructions directly
            or use --append-system-prompt to load the skill content.
            The config `prompt` field supports both styles:
            - Skill shorthand: "/signaliq-code-review 53"
            - Direct: "Review PR #53 against DDD/Clean Architecture rules..."
            At build time, if skill shorthand is detected, Heimdall reads
            the skill file from the repo's .claude/skills/ and injects it
            via --append-system-prompt.
       └─ Capture stdout → write to ~/.heimdall/reviews/{repo}/PR-{number}.md

5. State.markSeen(prs)
   └─ Append PR identifiers to seen.json with timestamp
```

## State Management

`~/.heimdall/seen.json`:

```jsonc
{
  "appfire-team/signal-iq": {
    "53": { "seenAt": "2026-04-13T10:30:00Z", "reviewed": true, "reportPath": "..." },
    "42": { "seenAt": "2026-04-12T14:00:00Z", "reviewed": true, "reportPath": "..." }
  }
}
```

Cleanup: entries older than 30 days are pruned on each cycle.

## launchd Integration

Plist generated by `heimdall install` at `~/Library/LaunchAgents/com.heimdall.watcher.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.heimdall.watcher</string>
  <key>ProgramArguments</key>
  <array>
    <string>/Users/oskarflores/code/stuff/heimdall/dist/heimdall</string>
    <string>run</string>
  </array>
  <key>StartInterval</key>
  <integer>600</integer>
  <key>StandardOutPath</key>
  <string>/Users/oskarflores/.heimdall/heimdall.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/oskarflores/.heimdall/heimdall.log</string>
  <key>RunAtLoad</key>
  <true/>
</dict>
</plist>
```

launchd calls `heimdall run` every 600 seconds. Each invocation is a single poll cycle — no persistent process needed.

## Notifications

Priority order:
1. `terminal-notifier` (if installed) — clickable, opens PR URL in browser
2. `osascript display notification` — fallback, no click-to-open

Detection at startup: check `which terminal-notifier`. Log a suggestion to install it if missing.

## Error Handling

- **`gh` not authenticated:** Log error, skip poll, notify user
- **`claude` not found:** Log error, skip review action, still notify
- **Network failure:** Log, retry next cycle
- **One PR review fails:** Does not affect other parallel reviews
- **Seen state corruption:** Rebuild from empty (worst case: re-review already-seen PRs once)

## Dependencies

### Runtime (must be on PATH)
- `gh` — GitHub CLI, authenticated
- `claude` — Claude Code CLI
- `terminal-notifier` — optional, recommended (`brew install terminal-notifier`)

### Build
- `bun` — for development and compilation

### Zero npm dependencies
The entire project uses only Bun built-ins: `Bun.spawn`, `Bun.file`, `Bun.write`, `fetch`. No node_modules.

## Future Extensibility

| Feature | How | Effort |
|---|---|---|
| **New repo** | Add to config.json | 2 lines |
| **PR comments** | New `CommentAction` using `gh pr comment` | Small |
| **Slack source** | New `SlackSource` polling Slack API or webhook | Medium |
| **Slack notification** | New `SlackNotifyAction` using `fetch()` to webhook URL | Small |
| **Claude Channel mode** | New `ChannelAction` that runs as MCP server | Medium |
| **Auto-fix** | New `FixAction` that runs `claude -p "fix issues from review"` | Medium |
| **Custom review prompts** | Already supported per-repo in config | Config only |
| **Cross-platform** | `bun build --compile --target=bun-linux-x64` | One flag |
