---
description: Heimdall — autonomous PR review watcher and Jira-to-PR implementation agent. Use Bun, not Node.js.
globs: "*.ts, *.tsx, *.html, *.css, *.js, *.jsx, package.json"
alwaysApply: true
---

## Project: Heimdall (investingfate)

**Heimdall** is a macOS daemon — an "All-Seeing PR Guardian" and autonomous coding agent. Two workflows:

1. **PR Review Watcher** — Polls GitHub for PRs awaiting review, sends macOS notifications, dispatches Claude Code to review in parallel.
2. **Jira-to-PR Autonomous Implementation** — Polls Jira for new issues, AI-triages them (feasibility, scope, clarity), and upon approval, autonomously implements via Claude Code in an isolated git worktree, runs tests, opens a draft PR.

### Architecture

- **Two-loop model**: Watcher (fast, launchd-managed poll cycle) + Worker (long-lived Claude sessions for implementation)
- **Plugin pattern**: `Source` interface (poll for items) + `Action` interface (execute side effects)
  - Sources: `GitHubSource` (via `gh` CLI), `JiraSource` (REST API)
  - Actions: `NotifyAction` (macOS notifications), `ReviewAction` (spawns `claude -p`), `TriageAction` (Claude triage)
- **State**: JSON files in `~/.heimdall/` — `seen.json`, `queue/`, `triage/`, `reviews/`
- **Daemon**: launchd LaunchAgent, embedded HTTP server on port 7878 for review + triage reports
- **Triage pipeline**: 3-gate AI scoring (acceptance clarity, feasibility, confidence) → verdict: ready/needs_detail/too_big/not_feasible
- **Reference doc fetching**: Triage auto-fetches Confluence pages and GitHub docs linked in Jira descriptions (allowlisted to configured base URLs and repos)

### Key Entry Points

| File | Purpose |
|------|---------|
| `src/index.ts` | CLI router |
| `src/cli/run.ts` | Watcher orchestration (config → server → poll loop) |
| `src/scheduler.ts` | Core cycle: `Source.poll()` → `filterNew()` → `Action.execute()` |
| `src/claude.ts` | Shared Claude CLI spawn utility (args, env, stderr, timeout) |
| `src/worker.ts` | Picks queued items, spawns Claude, creates PR |
| `src/actions/triage.ts` | Structured triage, parses JSON verdict |
| `src/actions/review.ts` | Creates worktree, runs review, saves report |
| `src/reference-docs.ts` | Fetches Confluence/GitHub docs referenced in Jira issues (allowlisted) |
| `src/types.ts` | All shared types |
| `src/config.ts` | Config loading/validation from `~/.heimdall/config.json` |

### Commands

```
heimdall run [--once]     # Start daemon or single poll cycle
heimdall start|stop|status|logs  # Daemon lifecycle
heimdall triage <KEY>     # View triage report + approve
heimdall approve <KEY>    # Queue issue for implementation
heimdall worker           # Start worker (picks up queued items)
heimdall queue            # List queue items
heimdall clean            # Remove old worktrees
heimdall open <number>    # Open PR review in browser
heimdall install|uninstall|reinstall  # launchd management
```

### Dependencies

Only npm dep: `marked` (markdown rendering). Everything else is Bun built-ins + CLI tools (`gh`, `claude`, `git`, `terminal-notifier`).

### Dev Commands

```bash
bun run src/index.ts run --once  # Dev: single poll cycle
bun test                         # Run all tests
bun run build                    # Compile to standalone macOS binary
```

### Design Docs

- `docs/specs/2026-04-13-heimdall-design.md` — Architecture & data flow
- `docs/superpowers/specs/2026-04-14-jira-autonomous-implementation-design.md` — Two-loop design, triage, worker
- `docs/superpowers/specs/2026-04-20-triage-gates-design.md` — Gate implementation details

---

## CLI Tools

- Use `rg` instead of `grep` for searching file contents.
- Use `fd` instead of `find` for file searches.
- Use `duckdb` for ad-hoc data queries and CSV/JSON/Parquet analysis.
- Use `sd` instead of `sed` for find-and-replace in files.
- Use `bat` instead of `cat` for reading file contents.
- Use `jq` for querying/filtering JSON output.
- Use `yq` for querying/filtering YAML, TOML, and XML files.
- Use `ast-grep` (`sg`) instead of regex for structural code search and refactoring.
- Use `scc` for codebase statistics and language breakdowns.
- Use `shellcheck` to validate any generated shell scripts.
- BEFORE using any preferred tool, verify it exists with `command -v <tool>`.
  Default to using Bun instead of Node.js.
- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun build <file.html|file.ts|file.css>` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>` or `yarn run <script>` or `pnpm run <script>`
- Use `bunx <package> <command>` instead of `npx <package> <command>`
- Bun automatically loads .env, so don't use dotenv.

## APIs

- `Bun.serve()` supports WebSockets, HTTPS, and routes. Don't use `express`.
- `bun:sqlite` for SQLite. Don't use `better-sqlite3`.
- `Bun.redis` for Redis. Don't use `ioredis`.
- `Bun.sql` for Postgres. Don't use `pg` or `postgres.js`.
- `WebSocket` is built-in. Don't use `ws`.
- Prefer `Bun.file` over `node:fs`'s readFile/writeFile
- Bun.$`ls` instead of execa.

## Testing

Use `bun test` to run tests.

```ts#index.test.ts
import { test, expect } from "bun:test";

test("hello world", () => {
  expect(1).toBe(1);
});
```

## Frontend

Use HTML imports with `Bun.serve()`. Don't use `vite`. HTML imports fully support React, CSS, Tailwind.

Server:

```ts#index.ts
import index from "./index.html"

Bun.serve({
  routes: {
    "/": index,
    "/api/users/:id": {
      GET: (req) => {
        return new Response(JSON.stringify({ id: req.params.id }));
      },
    },
  },
  // optional websocket support
  websocket: {
    open: (ws) => {
      ws.send("Hello, world!");
    },
    message: (ws, message) => {
      ws.send(message);
    },
    close: (ws) => {
      // handle close
    }
  },
  development: {
    hmr: true,
    console: true,
  }
})
```

HTML files can import .tsx, .jsx or .js files directly and Bun's bundler will transpile & bundle automatically. `<link>` tags can point to stylesheets and Bun's CSS bundler will bundle.

```html#index.html
<html>
  <body>
    <h1>Hello, world!</h1>
    <script type="module" src="./frontend.tsx"></script>
  </body>
</html>
```

With the following `frontend.tsx`:

```tsx#frontend.tsx
import React from "react";
import { createRoot } from "react-dom/client";

// import .css files directly and it works
import './index.css';

const root = createRoot(document.body);

export default function Frontend() {
  return <h1>Hello, world!</h1>;
}

root.render(<Frontend />);
```

Then, run index.ts

```sh
bun --hot ./index.ts
```

Behavioral guidelines to reduce common LLM coding mistakes. Merge with project-specific instructions as needed.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:

- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:

- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:

- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:

- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:

```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

---

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.
