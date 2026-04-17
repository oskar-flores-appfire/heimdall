# Heimdall

The All-Seeing PR Guardian. Watches for GitHub PR review requests and Jira issues, sends macOS notifications, automatically dispatches Claude Code reviews, and autonomously implements Jira tickets.

## Prerequisites

- [Bun](https://bun.sh) 1.3+ (for development) or use the compiled binary
- [GitHub CLI](https://cli.github.com/) (`gh`) — authenticated (`gh auth login`)
- [Claude Code](https://claude.ai/code) (`claude`) — for automated reviews
- [terminal-notifier](https://github.com/julienXX/terminal-notifier) (optional, recommended) — for clickable notifications

```bash
brew install terminal-notifier  # optional but recommended
```

## Quick Start

```bash
# Clone and run
cd ~/code/stuff/heimdall
bun run src/index.ts run        # single poll cycle

# Or build the binary first
bun run build.ts
./dist/heimdall run
```

On first run, Heimdall generates a config at `~/.heimdall/config.json` with `appfire-team/signal-iq` pre-configured. Edit it to add your repos.

## Install as Daemon

```bash
heimdall install    # generates launchd plist, starts polling every 10 min
heimdall status     # check if running + recent reviews
heimdall logs       # tail the log file
heimdall stop       # stop the daemon
heimdall start      # restart it
heimdall uninstall  # remove the daemon completely
```

## Commands

| Command | Description |
|---|---|
| `heimdall run` | Execute a single poll cycle (GitHub + Jira) |
| `heimdall install` | Generate and load launchd plist |
| `heimdall uninstall` | Remove launchd plist |
| `heimdall reinstall` | Stop, rebuild, and reload daemon |
| `heimdall start` | Start the daemon |
| `heimdall stop` | Stop the daemon |
| `heimdall status` | Show running state + recent reviews |
| `heimdall logs` | Tail the log file |
| `heimdall triage <KEY>` | View triage report for a Jira issue and approve |
| `heimdall approve <KEY>` | Queue a Jira issue for autonomous implementation |
| `heimdall worker` | Start the worker (picks up queued items) |
| `heimdall queue` | List queue items with status |
| `heimdall clean` | Remove completed/old worktrees |

## Configuration

Config lives at `~/.heimdall/config.json`:

```jsonc
{
  "interval": 600,                    // poll every 10 minutes
  "sources": [
    {
      "type": "github",
      "repos": ["appfire-team/signal-iq"],  // add more repos here
      "trigger": "review-requested"
    },
    {
      "type": "jira",
      "baseUrl": "https://your-domain.atlassian.net",
      "email": "you@example.com",
      "apiToken": "file:~/.heimdall/secrets/jira-api-token",  // see "Jira Setup" below
      "jql": "project = PROJ AND status != Done",
      "projects": {
        "PROJ": { "repo": "owner/repo", "cwd": "/path/to/local/checkout" }
      }
    }
  ],
  "actions": {
    "notify": {
      "enabled": true,
      "sound": "Glass",
      "maxPerCycle": 5,               // max individual notifications per poll
      "batchThreshold": 3             // batch into one notification above this
    },
    "review": {
      "enabled": true,
      "command": "claude",
      "defaultArgs": ["-p", "--permission-mode", "auto", "--output-format", "text"],
      "repos": {
        "appfire-team/signal-iq": {
          "prompt": "Review PR #{{pr_number}} against DDD/Clean Architecture rules...",
          "cwd": "/path/to/local/checkout"
        }
      }
    }
  },
  "triage": {
    "threshold": 6,                   // minimum triage score to auto-approve
    "maxSize": "L",                   // max issue size (S/M/L/XL)
    "model": "sonnet",
    "timeoutMinutes": 120
  },
  "worker": {
    "maxParallel": 1,
    "model": "opus",
    "worktreeDir": "~/.heimdall/worktrees",
    "maxTurns": 100,
    "claudeArgs": ["--permission-mode", "auto", "--output-format", "stream-json"]
  }
}
```

### Adding a new GitHub repo

1. Add the repo to `sources[0].repos`
2. Add a review config entry under `actions.review.repos`

### Jira Setup

1. Generate an API token at https://id.atlassian.com/manage-profile/security/api-tokens
2. Store the token in a file:
   ```bash
   mkdir -p ~/.heimdall/secrets
   echo "your-token-here" > ~/.heimdall/secrets/jira-api-token
   chmod 600 ~/.heimdall/secrets/jira-api-token
   ```
3. Add a Jira source to `sources` in `~/.heimdall/config.json` (see example above), referencing the file:
   ```json
   "apiToken": "file:~/.heimdall/secrets/jira-api-token"
   ```
4. Map each Jira project key to a local repo via the `projects` field

The `apiToken` field supports three formats:
- `"file:~/.heimdall/secrets/jira-api-token"` — reads from a file (recommended, works under launchd)
- `"env:JIRA_API_TOKEN"` — reads from an environment variable
- `"your-token-here"` — inline (not recommended)

### Jira Autonomous Implementation

Heimdall can autonomously implement Jira tickets using Claude Code:

1. **`heimdall run`** — polls Jira and triages new issues (scores them for clarity, scope, and detail)
2. **`heimdall triage <KEY>`** — view the triage report and optionally approve the issue
3. **`heimdall approve <KEY>`** — queue the issue for implementation
4. **`heimdall worker`** — starts a worker that picks up queued issues, creates a git worktree, and runs Claude Code to implement them
5. **`heimdall queue`** — check the status of queued items
6. **`heimdall clean`** — remove completed worktrees

### Prompt placeholders

Use these in review prompts: `{{pr_number}}`, `{{pr_title}}`, `{{pr_author}}`, `{{pr_repo}}`, `{{pr_branch}}`, `{{pr_url}}`

## Notifications

Heimdall sends two notifications per PR:

1. **Review started** — "Reviewing PR #53..." (click opens PR in browser)
2. **Review complete** — "Review ready: PR #53" (click opens report file)

With `terminal-notifier`, these replace each other (same group per PR). Without it, falls back to `osascript` (no click-to-open).

**Flood protection:**
- More than 3 PRs in one cycle sends a single batch notification instead of individual ones
- Max 5 notifications per cycle (configurable)

## File Layout

```
~/.heimdall/
├── config.json                     # your settings
├── seen.json                       # tracked PRs (auto-managed)
├── heimdall.log                    # activity log
├── secrets/                        # API tokens (chmod 600)
│   └── jira-api-token
├── reviews/
│   └── appfire-team/
│       └── signal-iq/
│           ├── PR-42.md            # review reports
│           └── PR-53.md
├── triage/                         # Jira triage reports
│   └── PROJ-123.json
├── queue/                          # implementation queue items
│   └── PROJ-123.json
├── worktrees/                      # git worktrees for implementation
└── runs/                           # implementation run logs
```

## Build

```bash
bun run build.ts          # compiles to ./dist/heimdall (~58MB standalone binary)
./dist/heimdall run       # works without bun installed
```

## Development

```bash
bun test                  # run all tests
bun run src/index.ts run  # test a poll cycle
```

## Architecture

Plugin-based with two extension points:

- **Sources** — where events come from (`GitHubSource` polls `gh pr list`, `JiraSource` polls Jira REST API)
- **Actions** — what to do (`NotifyAction`, `ReviewAction`, `TriageAction`)

The Jira autonomous pipeline adds:

- **Triage** — Claude scores issues for readiness (acceptance clarity, scope, technical detail)
- **Queue** — approved issues are queued for implementation
- **Worker** — picks up queue items, creates git worktrees, and runs Claude Code to implement

Zero npm dependencies. Built entirely on Bun built-ins.
