# Heimdall

The All-Seeing PR Guardian. Watches for GitHub PR review requests, sends macOS notifications, and automatically dispatches Claude Code reviews.

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
| `heimdall run` | Execute a single poll cycle |
| `heimdall install` | Generate and load launchd plist |
| `heimdall uninstall` | Remove launchd plist |
| `heimdall start` | Start the daemon |
| `heimdall stop` | Stop the daemon |
| `heimdall status` | Show running state + recent reviews |
| `heimdall logs` | Tail the log file |

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
  }
}
```

### Adding a new repo

1. Add the repo to `sources[0].repos`
2. Add a review config entry under `actions.review.repos`

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
└── reviews/
    └── appfire-team/
        └── signal-iq/
            ├── PR-42.md            # review reports
            └── PR-53.md
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

- **Sources** — where events come from (`GitHubSource` polls `gh pr list`)
- **Actions** — what to do (`NotifyAction`, `ReviewAction`)

Zero npm dependencies. Built entirely on Bun built-ins.

### Future

- Slack source/notifications
- PR comment posting
- Claude Channels integration (when it exits research preview)
- Auto-fix based on review findings
