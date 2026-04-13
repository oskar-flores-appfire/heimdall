# Heimdall Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a standalone Bun/TypeScript CLI daemon that polls GitHub for PR review requests, sends macOS notifications, and dispatches parallel Claude Code review sessions.

**Architecture:** Plugin-based with Source (poll for PRs) and Action (notify + review) interfaces. State tracked in `~/.heimdall/seen.json`. Managed by launchd on macOS. Zero npm dependencies — Bun built-ins only.

**Tech Stack:** Bun 1.3+, TypeScript (strict), `Bun.spawn` for `gh`/`claude` CLI, `Bun.file`/`Bun.write` for state, `bun build --compile` for binary.

**Working Directory:** `/Users/oskarflores/code/stuff/heimdall`

---

## File Map

| File | Responsibility |
|---|---|
| `src/index.ts` | CLI entry — parse command, dispatch to handler |
| `src/types.ts` | All shared interfaces and types (PullRequest, Source, Action, Config, etc.) |
| `src/config.ts` | Load, validate, and provide defaults for `~/.heimdall/config.json` |
| `src/state.ts` | Read/write `~/.heimdall/seen.json`, filter new PRs, prune old entries |
| `src/logger.ts` | Append to log file + stdout, level-aware |
| `src/sources/github.ts` | GitHubSource — `Bun.spawn(["gh", ...])`, parse JSON, return PullRequest[] |
| `src/actions/notify.ts` | NotifyAction — terminal-notifier with osascript fallback |
| `src/actions/review.ts` | ReviewAction — `Bun.spawn(["claude", "-p", ...])`, save report |
| `src/scheduler.ts` | Orchestrate: poll sources → filter state → run actions → update state |
| `src/cli/run.ts` | `heimdall run` — single poll cycle |
| `src/cli/start.ts` | `heimdall start` — launchctl load |
| `src/cli/stop.ts` | `heimdall stop` — launchctl unload |
| `src/cli/status.ts` | `heimdall status` — daemon status + recent reviews |
| `src/cli/logs.ts` | `heimdall logs` — tail log file |
| `src/cli/install.ts` | `heimdall install` — generate + load plist |
| `src/cli/uninstall.ts` | `heimdall uninstall` — unload + remove plist |
| `build.ts` | `bun build --compile` wrapper |
| `package.json` | Project metadata, `bin` field, scripts |
| `tsconfig.json` | Strict TS config for Bun |
| `test/state.test.ts` | State unit tests |
| `test/sources/github.test.ts` | GitHubSource tests (mock Bun.spawn) |
| `test/actions/notify.test.ts` | NotifyAction tests |
| `test/actions/review.test.ts` | ReviewAction tests |
| `test/scheduler.test.ts` | Scheduler integration test |
| `test/config.test.ts` | Config loading/validation tests |

---

### Task 1: Project Scaffold

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `src/types.ts`

- [ ] **Step 1: Initialize Bun project**

```bash
cd /Users/oskarflores/code/stuff/heimdall
bun init -y
```

- [ ] **Step 2: Replace package.json with project config**

Write `package.json`:

```json
{
  "name": "heimdall",
  "version": "0.1.0",
  "description": "The All-Seeing PR Guardian",
  "type": "module",
  "bin": {
    "heimdall": "./src/index.ts"
  },
  "scripts": {
    "dev": "bun run src/index.ts",
    "test": "bun test",
    "build": "bun run build.ts"
  }
}
```

- [ ] **Step 3: Write tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "./dist",
    "rootDir": ".",
    "types": ["bun-types"],
    "paths": {
      "@/*": ["./src/*"]
    }
  },
  "include": ["src/**/*.ts", "test/**/*.ts", "build.ts"]
}
```

- [ ] **Step 4: Write src/types.ts — all shared types**

```typescript
// --- Domain types ---

export interface PullRequest {
  number: number;
  title: string;
  url: string;
  headRefName: string;
  baseRefName: string;
  repo: string;
  author: string;
}

export interface ActionResult {
  action: string;
  success: boolean;
  message?: string;
  reportPath?: string;
}

// --- Plugin interfaces ---

export interface Source {
  name: string;
  poll(): Promise<PullRequest[]>;
}

export interface Action {
  name: string;
  execute(pr: PullRequest, repoConfig: RepoConfig): Promise<ActionResult>;
}

// --- Config types ---

export interface HeimdallConfig {
  interval: number;
  sources: SourceConfig[];
  actions: ActionsConfig;
  reports: { dir: string };
  log: { file: string; level: LogLevel };
}

export interface SourceConfig {
  type: "github";
  repos: string[];
  trigger: "review-requested";
}

export interface ActionsConfig {
  notify: { enabled: boolean; sound: string };
  review: {
    enabled: boolean;
    command: string;
    defaultArgs: string[];
    repos: Record<string, RepoConfig>;
  };
}

export interface RepoConfig {
  prompt: string;
  cwd: string;
  systemPromptFile?: string;
  allowedTools?: string[];
}

export interface SeenEntry {
  seenAt: string;
  reviewed: boolean;
  reportPath?: string;
}

export type SeenState = Record<string, Record<string, SeenEntry>>;

export type LogLevel = "debug" | "info" | "warn" | "error";
```

- [ ] **Step 5: Verify it compiles**

```bash
cd /Users/oskarflores/code/stuff/heimdall
bun build src/types.ts --no-bundle 2>&1
```

Expected: no errors.

- [ ] **Step 6: Initialize git and commit**

```bash
cd /Users/oskarflores/code/stuff/heimdall
git init
echo 'node_modules/\ndist/\n.DS_Store' > .gitignore
git add package.json tsconfig.json src/types.ts .gitignore docs/
git commit -m "chore: scaffold Heimdall project with types"
```

---

### Task 2: Logger

**Files:**
- Create: `src/logger.ts`
- Test: `test/logger.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/logger.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createLogger } from "../src/logger";
import { existsSync, unlinkSync, mkdirSync } from "fs";
import { join } from "path";

const TEST_LOG = "/tmp/heimdall-test.log";

describe("Logger", () => {
  beforeEach(() => {
    if (existsSync(TEST_LOG)) unlinkSync(TEST_LOG);
  });

  afterEach(() => {
    if (existsSync(TEST_LOG)) unlinkSync(TEST_LOG);
  });

  it("writes info messages to file", async () => {
    const log = createLogger({ file: TEST_LOG, level: "info" });
    log.info("hello world");
    await Bun.sleep(50); // flush
    const content = await Bun.file(TEST_LOG).text();
    expect(content).toContain("hello world");
    expect(content).toContain("[INFO]");
  });

  it("respects log level", async () => {
    const log = createLogger({ file: TEST_LOG, level: "warn" });
    log.info("should not appear");
    log.warn("should appear");
    await Bun.sleep(50);
    const content = await Bun.file(TEST_LOG).text();
    expect(content).not.toContain("should not appear");
    expect(content).toContain("should appear");
  });

  it("includes timestamp", async () => {
    const log = createLogger({ file: TEST_LOG, level: "info" });
    log.info("timestamped");
    await Bun.sleep(50);
    const content = await Bun.file(TEST_LOG).text();
    expect(content).toMatch(/\d{4}-\d{2}-\d{2}T/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /Users/oskarflores/code/stuff/heimdall
bun test test/logger.test.ts
```

Expected: FAIL — `createLogger` not found.

- [ ] **Step 3: Implement logger**

Create `src/logger.ts`:

```typescript
import { appendFileSync, mkdirSync } from "fs";
import { dirname } from "path";
import type { LogLevel } from "./types";

const LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export interface Logger {
  debug(msg: string): void;
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

export function createLogger(config: { file: string; level: LogLevel }): Logger {
  const minLevel = LEVELS[config.level];
  mkdirSync(dirname(config.file), { recursive: true });

  function write(level: LogLevel, msg: string) {
    if (LEVELS[level] < minLevel) return;
    const line = `${new Date().toISOString()} [${level.toUpperCase()}] ${msg}\n`;
    appendFileSync(config.file, line);
    if (level === "error") {
      console.error(line.trimEnd());
    } else {
      console.log(line.trimEnd());
    }
  }

  return {
    debug: (msg) => write("debug", msg),
    info: (msg) => write("info", msg),
    warn: (msg) => write("warn", msg),
    error: (msg) => write("error", msg),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd /Users/oskarflores/code/stuff/heimdall
bun test test/logger.test.ts
```

Expected: 3 passing.

- [ ] **Step 5: Commit**

```bash
git add src/logger.ts test/logger.test.ts
git commit -m "feat: add logger with file output and level filtering"
```

---

### Task 3: Config

**Files:**
- Create: `src/config.ts`
- Test: `test/config.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/config.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { loadConfig, DEFAULT_CONFIG, resolveHomePath } from "../src/config";
import { mkdirSync, rmSync, existsSync } from "fs";

const TEST_DIR = "/tmp/heimdall-config-test";
const TEST_CONFIG = `${TEST_DIR}/config.json`;

describe("Config", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  it("returns defaults when no config file exists", async () => {
    const config = await loadConfig("/tmp/nonexistent/config.json");
    expect(config.interval).toBe(DEFAULT_CONFIG.interval);
    expect(config.actions.notify.sound).toBe("Glass");
  });

  it("merges user config over defaults", async () => {
    await Bun.write(TEST_CONFIG, JSON.stringify({ interval: 300 }));
    const config = await loadConfig(TEST_CONFIG);
    expect(config.interval).toBe(300);
    expect(config.actions.notify.sound).toBe("Glass"); // default preserved
  });

  it("resolves ~ in paths", () => {
    const resolved = resolveHomePath("~/.heimdall/reviews");
    expect(resolved).not.toContain("~");
    expect(resolved).toContain("heimdall/reviews");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /Users/oskarflores/code/stuff/heimdall
bun test test/config.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement config**

Create `src/config.ts`:

```typescript
import { existsSync, mkdirSync } from "fs";
import { dirname } from "path";
import { homedir } from "os";
import type { HeimdallConfig } from "./types";

export const HEIMDALL_DIR = `${homedir()}/.heimdall`;
export const DEFAULT_CONFIG_PATH = `${HEIMDALL_DIR}/config.json`;

export const DEFAULT_CONFIG: HeimdallConfig = {
  interval: 600,
  sources: [
    {
      type: "github",
      repos: [],
      trigger: "review-requested",
    },
  ],
  actions: {
    notify: { enabled: true, sound: "Glass" },
    review: {
      enabled: true,
      command: "claude",
      defaultArgs: ["-p", "--permission-mode", "auto", "--output-format", "text"],
      repos: {},
    },
  },
  reports: { dir: `${HEIMDALL_DIR}/reviews` },
  log: { file: `${HEIMDALL_DIR}/heimdall.log`, level: "info" },
};

export function resolveHomePath(p: string): string {
  return p.startsWith("~") ? p.replace("~", homedir()) : p;
}

function deepMerge(target: any, source: any): any {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (
      source[key] &&
      typeof source[key] === "object" &&
      !Array.isArray(source[key]) &&
      target[key] &&
      typeof target[key] === "object" &&
      !Array.isArray(target[key])
    ) {
      result[key] = deepMerge(target[key], source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

export async function loadConfig(
  path: string = DEFAULT_CONFIG_PATH
): Promise<HeimdallConfig> {
  const resolvedPath = resolveHomePath(path);

  if (!existsSync(resolvedPath)) {
    return { ...DEFAULT_CONFIG };
  }

  const userConfig = await Bun.file(resolvedPath).json();
  return deepMerge(DEFAULT_CONFIG, userConfig) as HeimdallConfig;
}

export async function ensureHeimdallDir(): Promise<void> {
  mkdirSync(HEIMDALL_DIR, { recursive: true });
  mkdirSync(resolveHomePath(DEFAULT_CONFIG.reports.dir), { recursive: true });
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd /Users/oskarflores/code/stuff/heimdall
bun test test/config.test.ts
```

Expected: 3 passing.

- [ ] **Step 5: Commit**

```bash
git add src/config.ts test/config.test.ts
git commit -m "feat: add config loading with defaults and deep merge"
```

---

### Task 4: State Manager

**Files:**
- Create: `src/state.ts`
- Test: `test/state.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/state.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { StateManager } from "../src/state";
import { existsSync, rmSync, mkdirSync } from "fs";
import type { PullRequest } from "../src/types";

const TEST_STATE = "/tmp/heimdall-state-test/seen.json";

const pr1: PullRequest = {
  number: 42,
  title: "Fix bug",
  url: "https://github.com/org/repo/pull/42",
  headRefName: "feature/fix",
  baseRefName: "main",
  repo: "org/repo",
  author: "alice",
};

const pr2: PullRequest = {
  number: 53,
  title: "Add feature",
  url: "https://github.com/org/repo/pull/53",
  headRefName: "feature/add",
  baseRefName: "main",
  repo: "org/repo",
  author: "bob",
};

describe("StateManager", () => {
  beforeEach(() => {
    mkdirSync("/tmp/heimdall-state-test", { recursive: true });
    if (existsSync(TEST_STATE)) rmSync(TEST_STATE);
  });

  afterEach(() => {
    rmSync("/tmp/heimdall-state-test", { recursive: true, force: true });
  });

  it("returns all PRs as new when state file is empty", async () => {
    const state = new StateManager(TEST_STATE);
    const newPrs = await state.filterNew([pr1, pr2]);
    expect(newPrs).toHaveLength(2);
  });

  it("filters out already-seen PRs", async () => {
    const state = new StateManager(TEST_STATE);
    await state.markSeen(pr1);
    const newPrs = await state.filterNew([pr1, pr2]);
    expect(newPrs).toHaveLength(1);
    expect(newPrs[0].number).toBe(53);
  });

  it("marks PR as reviewed with report path", async () => {
    const state = new StateManager(TEST_STATE);
    await state.markSeen(pr1);
    await state.markReviewed(pr1, "/path/to/report.md");
    const data = await Bun.file(TEST_STATE).json();
    expect(data["org/repo"]["42"].reviewed).toBe(true);
    expect(data["org/repo"]["42"].reportPath).toBe("/path/to/report.md");
  });

  it("prunes entries older than maxAgeDays", async () => {
    const state = new StateManager(TEST_STATE);
    // Write a stale entry directly
    const staleDate = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
    await Bun.write(
      TEST_STATE,
      JSON.stringify({
        "org/repo": {
          "1": { seenAt: staleDate, reviewed: true },
          "2": { seenAt: new Date().toISOString(), reviewed: true },
        },
      })
    );
    const state2 = new StateManager(TEST_STATE);
    await state2.prune(30);
    const data = await Bun.file(TEST_STATE).json();
    expect(data["org/repo"]["1"]).toBeUndefined();
    expect(data["org/repo"]["2"]).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /Users/oskarflores/code/stuff/heimdall
bun test test/state.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement state manager**

Create `src/state.ts`:

```typescript
import { existsSync, mkdirSync } from "fs";
import { dirname } from "path";
import type { PullRequest, SeenState, SeenEntry } from "./types";

export class StateManager {
  constructor(private readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
  }

  private async load(): Promise<SeenState> {
    if (!existsSync(this.path)) return {};
    return Bun.file(this.path).json();
  }

  private async save(state: SeenState): Promise<void> {
    await Bun.write(this.path, JSON.stringify(state, null, 2));
  }

  async filterNew(prs: PullRequest[]): Promise<PullRequest[]> {
    const state = await this.load();
    return prs.filter((pr) => {
      const repoState = state[pr.repo];
      if (!repoState) return true;
      return !repoState[String(pr.number)];
    });
  }

  async markSeen(pr: PullRequest): Promise<void> {
    const state = await this.load();
    if (!state[pr.repo]) state[pr.repo] = {};
    state[pr.repo][String(pr.number)] = {
      seenAt: new Date().toISOString(),
      reviewed: false,
    };
    await this.save(state);
  }

  async markReviewed(pr: PullRequest, reportPath: string): Promise<void> {
    const state = await this.load();
    if (!state[pr.repo]) state[pr.repo] = {};
    const entry = state[pr.repo][String(pr.number)];
    if (entry) {
      entry.reviewed = true;
      entry.reportPath = reportPath;
    } else {
      state[pr.repo][String(pr.number)] = {
        seenAt: new Date().toISOString(),
        reviewed: true,
        reportPath,
      };
    }
    await this.save(state);
  }

  async prune(maxAgeDays: number): Promise<void> {
    const state = await this.load();
    const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
    for (const repo of Object.keys(state)) {
      for (const prNum of Object.keys(state[repo])) {
        const entry = state[repo][prNum];
        if (new Date(entry.seenAt).getTime() < cutoff) {
          delete state[repo][prNum];
        }
      }
      if (Object.keys(state[repo]).length === 0) {
        delete state[repo];
      }
    }
    await this.save(state);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd /Users/oskarflores/code/stuff/heimdall
bun test test/state.test.ts
```

Expected: 4 passing.

- [ ] **Step 5: Commit**

```bash
git add src/state.ts test/state.test.ts
git commit -m "feat: add state manager for tracking seen PRs"
```

---

### Task 5: GitHubSource

**Files:**
- Create: `src/sources/github.ts`
- Test: `test/sources/github.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/sources/github.test.ts`:

```typescript
import { describe, it, expect, mock, beforeEach } from "bun:test";
import { GitHubSource } from "../../src/sources/github";
import { createLogger } from "../../src/logger";

const logger = createLogger({ file: "/tmp/heimdall-gh-test.log", level: "debug" });

describe("GitHubSource", () => {
  it("parses gh pr list JSON output into PullRequest[]", async () => {
    const source = new GitHubSource(["appfire-team/signal-iq"], "review-requested", logger);

    // Integration test — requires gh to be authenticated
    // If gh is not available, skip
    const proc = Bun.spawnSync(["gh", "auth", "status"]);
    if (proc.exitCode !== 0) {
      console.log("Skipping: gh not authenticated");
      return;
    }

    const prs = await source.poll();
    // We can't assert exact count but we can assert shape
    for (const pr of prs) {
      expect(pr).toHaveProperty("number");
      expect(pr).toHaveProperty("title");
      expect(pr).toHaveProperty("url");
      expect(pr).toHaveProperty("repo");
      expect(pr).toHaveProperty("author");
      expect(typeof pr.number).toBe("number");
      expect(pr.repo).toBe("appfire-team/signal-iq");
    }
  });

  it("returns empty array when no PRs match", async () => {
    // Use a repo that likely has no review requests
    const source = new GitHubSource(
      ["appfire-team/nonexistent-repo-12345"],
      "review-requested",
      logger
    );
    const prs = await source.poll();
    expect(prs).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /Users/oskarflores/code/stuff/heimdall
bun test test/sources/github.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement GitHubSource**

Create `src/sources/github.ts`:

```typescript
import type { Source, PullRequest } from "../types";
import type { Logger } from "../logger";

interface GhPrJson {
  number: number;
  title: string;
  url: string;
  headRefName: string;
  baseRefName: string;
  author: { login: string };
}

export class GitHubSource implements Source {
  readonly name = "github";

  constructor(
    private readonly repos: string[],
    private readonly trigger: string,
    private readonly logger: Logger
  ) {}

  async poll(): Promise<PullRequest[]> {
    const allPrs: PullRequest[] = [];

    for (const repo of this.repos) {
      try {
        const prs = await this.pollRepo(repo);
        allPrs.push(...prs);
      } catch (err) {
        this.logger.error(`Failed to poll ${repo}: ${err}`);
      }
    }

    return allPrs;
  }

  private async pollRepo(repo: string): Promise<PullRequest[]> {
    const proc = Bun.spawn(
      [
        "gh", "pr", "list",
        "--repo", repo,
        "--search", `${this.trigger}:@me`,
        "--json", "number,title,url,headRefName,baseRefName,author",
        "--limit", "30",
      ],
      { stdout: "pipe", stderr: "pipe" }
    );

    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      this.logger.error(`gh pr list failed for ${repo}: ${stderr}`);
      return [];
    }

    const stdout = await new Response(proc.stdout).text();
    if (!stdout.trim()) return [];

    const raw: GhPrJson[] = JSON.parse(stdout);
    return raw.map((pr) => ({
      number: pr.number,
      title: pr.title,
      url: pr.url,
      headRefName: pr.headRefName,
      baseRefName: pr.baseRefName,
      repo,
      author: pr.author.login,
    }));
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd /Users/oskarflores/code/stuff/heimdall
bun test test/sources/github.test.ts
```

Expected: passing (or skipped if gh not auth'd).

- [ ] **Step 5: Commit**

```bash
git add src/sources/github.ts test/sources/github.test.ts
git commit -m "feat: add GitHubSource polling via gh CLI"
```

---

### Task 6: NotifyAction

**Files:**
- Create: `src/actions/notify.ts`
- Test: `test/actions/notify.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/actions/notify.test.ts`:

```typescript
import { describe, it, expect } from "bun:test";
import { NotifyAction, detectNotifier } from "../../src/actions/notify";
import { createLogger } from "../../src/logger";
import type { PullRequest, RepoConfig } from "../../src/types";

const logger = createLogger({ file: "/tmp/heimdall-notify-test.log", level: "debug" });

const pr: PullRequest = {
  number: 42,
  title: "Fix the thing",
  url: "https://github.com/org/repo/pull/42",
  headRefName: "feature/fix",
  baseRefName: "main",
  repo: "org/repo",
  author: "alice",
};

const repoConfig: RepoConfig = {
  prompt: "review {{pr_number}}",
  cwd: "/tmp",
};

describe("NotifyAction", () => {
  it("detects available notifier", () => {
    const notifier = detectNotifier();
    // On macOS, at least osascript should be available
    expect(["terminal-notifier", "osascript", "none"]).toContain(notifier);
  });

  it("executes without throwing", async () => {
    const action = new NotifyAction("Glass", logger);
    const result = await action.execute(pr, repoConfig);
    expect(result.action).toBe("notify");
    expect(result.success).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /Users/oskarflores/code/stuff/heimdall
bun test test/actions/notify.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement NotifyAction**

Create `src/actions/notify.ts`:

```typescript
import type { Action, PullRequest, RepoConfig, ActionResult } from "../types";
import type { Logger } from "../logger";

type Notifier = "terminal-notifier" | "osascript" | "none";

export function detectNotifier(): Notifier {
  const tn = Bun.spawnSync(["which", "terminal-notifier"]);
  if (tn.exitCode === 0) return "terminal-notifier";

  const osa = Bun.spawnSync(["which", "osascript"]);
  if (osa.exitCode === 0) return "osascript";

  return "none";
}

export class NotifyAction implements Action {
  readonly name = "notify";
  private readonly notifier: Notifier;

  constructor(
    private readonly sound: string,
    private readonly logger: Logger
  ) {
    this.notifier = detectNotifier();
    if (this.notifier === "none") {
      logger.warn("No notification tool found. Install terminal-notifier: brew install terminal-notifier");
    } else if (this.notifier === "osascript") {
      logger.info("Using osascript for notifications. For clickable notifications: brew install terminal-notifier");
    }
  }

  async execute(pr: PullRequest, _repoConfig: RepoConfig): Promise<ActionResult> {
    const title = "Heimdall";
    const subtitle = pr.repo;
    const message = `PR #${pr.number}: ${pr.title}`;

    try {
      if (this.notifier === "terminal-notifier") {
        await this.terminalNotifier(title, subtitle, message, pr.url);
      } else if (this.notifier === "osascript") {
        await this.osascript(title, subtitle, message);
      } else {
        this.logger.warn(`No notifier available for PR #${pr.number}`);
      }

      this.logger.info(`Notified: ${message}`);
      return { action: "notify", success: true, message };
    } catch (err) {
      this.logger.error(`Notification failed: ${err}`);
      return { action: "notify", success: false, message: String(err) };
    }
  }

  private async terminalNotifier(
    title: string,
    subtitle: string,
    message: string,
    url: string
  ): Promise<void> {
    const proc = Bun.spawn([
      "terminal-notifier",
      "-title", title,
      "-subtitle", subtitle,
      "-message", message,
      "-open", url,
      "-sound", this.sound,
      "-group", "heimdall",
    ]);
    await proc.exited;
  }

  private async osascript(
    title: string,
    subtitle: string,
    message: string
  ): Promise<void> {
    const script = `display notification "${message}" with title "${title}" subtitle "${subtitle}" sound name "${this.sound}"`;
    const proc = Bun.spawn(["osascript", "-e", script]);
    await proc.exited;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd /Users/oskarflores/code/stuff/heimdall
bun test test/actions/notify.test.ts
```

Expected: 2 passing (you'll see/hear a notification on macOS).

- [ ] **Step 5: Commit**

```bash
git add src/actions/notify.ts test/actions/notify.test.ts
git commit -m "feat: add NotifyAction with terminal-notifier and osascript fallback"
```

---

### Task 7: ReviewAction

**Files:**
- Create: `src/actions/review.ts`
- Test: `test/actions/review.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/actions/review.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { ReviewAction, buildPrompt } from "../../src/actions/review";
import { createLogger } from "../../src/logger";
import { mkdirSync, rmSync, existsSync } from "fs";
import type { PullRequest, RepoConfig } from "../../src/types";

const logger = createLogger({ file: "/tmp/heimdall-review-test.log", level: "debug" });
const REPORTS_DIR = "/tmp/heimdall-review-test-reports";

const pr: PullRequest = {
  number: 42,
  title: "Fix the thing",
  url: "https://github.com/org/repo/pull/42",
  headRefName: "feature/fix",
  baseRefName: "main",
  repo: "org/repo",
  author: "alice",
};

describe("ReviewAction", () => {
  beforeEach(() => {
    mkdirSync(REPORTS_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(REPORTS_DIR)) rmSync(REPORTS_DIR, { recursive: true });
  });

  it("builds prompt with pr_number substitution", () => {
    const prompt = buildPrompt("/signaliq-code-review {{pr_number}}", pr);
    expect(prompt).toBe("/signaliq-code-review 42");
  });

  it("builds prompt with multiple placeholders", () => {
    const prompt = buildPrompt(
      "Review PR #{{pr_number}} '{{pr_title}}' by {{pr_author}} on {{pr_repo}}",
      pr
    );
    expect(prompt).toBe("Review PR #42 'Fix the thing' by alice on org/repo");
  });

  it("generates correct report path", () => {
    const action = new ReviewAction(
      "claude",
      ["-p", "--output-format", "text"],
      REPORTS_DIR,
      logger
    );
    const path = action.reportPath(pr);
    expect(path).toContain("org/repo");
    expect(path).toContain("PR-42.md");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /Users/oskarflores/code/stuff/heimdall
bun test test/actions/review.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement ReviewAction**

Create `src/actions/review.ts`:

```typescript
import { mkdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import type { Action, PullRequest, RepoConfig, ActionResult } from "../types";
import type { Logger } from "../logger";

export function buildPrompt(template: string, pr: PullRequest): string {
  return template
    .replace(/\{\{pr_number\}\}/g, String(pr.number))
    .replace(/\{\{pr_title\}\}/g, pr.title)
    .replace(/\{\{pr_author\}\}/g, pr.author)
    .replace(/\{\{pr_repo\}\}/g, pr.repo)
    .replace(/\{\{pr_branch\}\}/g, pr.headRefName)
    .replace(/\{\{pr_url\}\}/g, pr.url);
}

export class ReviewAction implements Action {
  readonly name = "review";

  constructor(
    private readonly command: string,
    private readonly defaultArgs: string[],
    private readonly reportsDir: string,
    private readonly logger: Logger
  ) {}

  reportPath(pr: PullRequest): string {
    return join(this.reportsDir, pr.repo, `PR-${pr.number}.md`);
  }

  async execute(pr: PullRequest, repoConfig: RepoConfig): Promise<ActionResult> {
    const prompt = buildPrompt(repoConfig.prompt, pr);
    const report = this.reportPath(pr);
    mkdirSync(dirname(report), { recursive: true });

    const args = [...this.defaultArgs, prompt];

    // If systemPromptFile is configured and exists, inject it
    if (repoConfig.systemPromptFile && existsSync(repoConfig.systemPromptFile)) {
      const content = await Bun.file(repoConfig.systemPromptFile).text();
      args.push("--append-system-prompt", content);
    }

    this.logger.info(`Reviewing PR #${pr.number} in ${pr.repo} (${pr.author})`);
    this.logger.debug(`Command: ${this.command} ${args.join(" ").substring(0, 200)}...`);

    try {
      const proc = Bun.spawn([this.command, ...args], {
        cwd: repoConfig.cwd,
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, TERM: "dumb" },
      });

      const exitCode = await proc.exited;
      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();

      if (exitCode !== 0) {
        this.logger.error(`Review failed for PR #${pr.number}: ${stderr}`);
        const errorReport = `# Review Failed\n\n**PR:** #${pr.number} - ${pr.title}\n**Error:**\n\`\`\`\n${stderr}\n\`\`\`\n`;
        await Bun.write(report, errorReport);
        return { action: "review", success: false, message: stderr, reportPath: report };
      }

      const header = `# Code Review: PR #${pr.number}\n\n**Title:** ${pr.title}\n**Author:** ${pr.author}\n**Branch:** ${pr.headRefName}\n**Repo:** ${pr.repo}\n**URL:** ${pr.url}\n**Reviewed:** ${new Date().toISOString()}\n\n---\n\n`;
      await Bun.write(report, header + stdout);

      this.logger.info(`Review saved: ${report}`);
      return { action: "review", success: true, reportPath: report };
    } catch (err) {
      this.logger.error(`Review process error for PR #${pr.number}: ${err}`);
      return { action: "review", success: false, message: String(err) };
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd /Users/oskarflores/code/stuff/heimdall
bun test test/actions/review.test.ts
```

Expected: 3 passing.

- [ ] **Step 5: Commit**

```bash
git add src/actions/review.ts test/actions/review.test.ts
git commit -m "feat: add ReviewAction spawning claude -p with report output"
```

---

### Task 8: Scheduler (orchestrator)

**Files:**
- Create: `src/scheduler.ts`
- Test: `test/scheduler.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/scheduler.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { runCycle } from "../../src/scheduler";
import { createLogger } from "../../src/logger";
import { mkdirSync, rmSync, existsSync } from "fs";
import type { Source, Action, PullRequest, RepoConfig, ActionResult, HeimdallConfig } from "../../src/types";
import { StateManager } from "../../src/state";
import { DEFAULT_CONFIG } from "../../src/config";

const TEST_DIR = "/tmp/heimdall-scheduler-test";
const logger = createLogger({ file: `${TEST_DIR}/test.log`, level: "debug" });

const fakePr: PullRequest = {
  number: 99,
  title: "Fake PR",
  url: "https://github.com/org/repo/pull/99",
  headRefName: "feature/fake",
  baseRefName: "main",
  repo: "org/repo",
  author: "tester",
};

class FakeSource implements Source {
  name = "fake";
  constructor(private prs: PullRequest[]) {}
  async poll() { return this.prs; }
}

class FakeAction implements Action {
  name = "fake";
  calls: PullRequest[] = [];
  async execute(pr: PullRequest, _rc: RepoConfig): Promise<ActionResult> {
    this.calls.push(pr);
    return { action: "fake", success: true };
  }
}

describe("Scheduler", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("runs actions for new PRs only", async () => {
    const state = new StateManager(`${TEST_DIR}/seen.json`);
    const source = new FakeSource([fakePr]);
    const action = new FakeAction();

    const config: HeimdallConfig = {
      ...DEFAULT_CONFIG,
      actions: {
        ...DEFAULT_CONFIG.actions,
        review: {
          ...DEFAULT_CONFIG.actions.review,
          repos: { "org/repo": { prompt: "review {{pr_number}}", cwd: "/tmp" } },
        },
      },
    };

    // First cycle: PR is new
    await runCycle(source, [action], state, config, logger);
    expect(action.calls).toHaveLength(1);
    expect(action.calls[0].number).toBe(99);

    // Second cycle: PR already seen
    const action2 = new FakeAction();
    await runCycle(source, [action2], state, config, logger);
    expect(action2.calls).toHaveLength(0);
  });

  it("handles source errors gracefully", async () => {
    const state = new StateManager(`${TEST_DIR}/seen.json`);
    const badSource: Source = {
      name: "bad",
      async poll() { throw new Error("network down"); },
    };
    const action = new FakeAction();

    // Should not throw
    await runCycle(badSource, [action], state, DEFAULT_CONFIG, logger);
    expect(action.calls).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /Users/oskarflores/code/stuff/heimdall
bun test test/scheduler.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement scheduler**

Create `src/scheduler.ts`:

```typescript
import type { Source, Action, PullRequest, HeimdallConfig } from "./types";
import type { Logger } from "./logger";
import type { StateManager } from "./state";

export async function runCycle(
  source: Source,
  actions: Action[],
  state: StateManager,
  config: HeimdallConfig,
  logger: Logger
): Promise<void> {
  logger.info("Poll cycle started");

  let prs: PullRequest[];
  try {
    prs = await source.poll();
    logger.info(`Found ${prs.length} PR(s) requesting review`);
  } catch (err) {
    logger.error(`Source poll failed: ${err}`);
    return;
  }

  const newPrs = await state.filterNew(prs);
  if (newPrs.length === 0) {
    logger.info("No new PRs to process");
    return;
  }

  logger.info(`Processing ${newPrs.length} new PR(s)`);

  await Promise.all(
    newPrs.map(async (pr) => {
      const repoConfig = config.actions.review.repos[pr.repo];
      if (!repoConfig) {
        logger.warn(`No review config for repo ${pr.repo}, skipping review`);
      }

      // Mark seen immediately to avoid double-processing
      await state.markSeen(pr);

      for (const action of actions) {
        try {
          const result = await action.execute(
            pr,
            repoConfig ?? { prompt: "Review PR #{{pr_number}}", cwd: "/tmp" }
          );
          if (result.reportPath) {
            await state.markReviewed(pr, result.reportPath);
          }
          if (!result.success) {
            logger.warn(`Action ${action.name} failed for PR #${pr.number}: ${result.message}`);
          }
        } catch (err) {
          logger.error(`Action ${action.name} threw for PR #${pr.number}: ${err}`);
        }
      }
    })
  );

  // Prune old entries
  await state.prune(30);
  logger.info("Poll cycle completed");
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd /Users/oskarflores/code/stuff/heimdall
bun test test/scheduler.test.ts
```

Expected: 2 passing.

- [ ] **Step 5: Commit**

```bash
git add src/scheduler.ts test/scheduler.test.ts
git commit -m "feat: add scheduler orchestrating poll-filter-act cycle"
```

---

### Task 9: CLI Entry Point

**Files:**
- Create: `src/index.ts`
- Create: `src/cli/run.ts`
- Create: `src/cli/install.ts`
- Create: `src/cli/uninstall.ts`
- Create: `src/cli/start.ts`
- Create: `src/cli/stop.ts`
- Create: `src/cli/status.ts`
- Create: `src/cli/logs.ts`

- [ ] **Step 1: Create src/cli/run.ts — single poll cycle**

```typescript
import { loadConfig, ensureHeimdallDir, resolveHomePath } from "../config";
import { createLogger } from "../logger";
import { StateManager } from "../state";
import { GitHubSource } from "../sources/github";
import { NotifyAction } from "../actions/notify";
import { ReviewAction } from "../actions/review";
import { runCycle } from "../scheduler";
import type { Action } from "../types";

export async function run(): Promise<void> {
  await ensureHeimdallDir();
  const config = await loadConfig();
  const logger = createLogger({
    file: resolveHomePath(config.log.file),
    level: config.log.level,
  });

  logger.info("Heimdall run — single poll cycle");

  const sourceConfig = config.sources[0];
  if (!sourceConfig || sourceConfig.repos.length === 0) {
    logger.error("No repos configured. Edit ~/.heimdall/config.json");
    process.exit(1);
  }

  const source = new GitHubSource(sourceConfig.repos, sourceConfig.trigger, logger);
  const state = new StateManager(resolveHomePath("~/.heimdall/seen.json"));
  const actions: Action[] = [];

  if (config.actions.notify.enabled) {
    actions.push(new NotifyAction(config.actions.notify.sound, logger));
  }

  if (config.actions.review.enabled) {
    actions.push(
      new ReviewAction(
        config.actions.review.command,
        config.actions.review.defaultArgs,
        resolveHomePath(config.reports.dir),
        logger
      )
    );
  }

  await runCycle(source, actions, state, config, logger);
}
```

- [ ] **Step 2: Create src/cli/install.ts — generate and load plist**

```typescript
import { homedir } from "os";
import { join } from "path";
import { existsSync } from "fs";
import { loadConfig, resolveHomePath } from "../config";

const PLIST_NAME = "com.heimdall.watcher";
const PLIST_DIR = join(homedir(), "Library", "LaunchAgents");
const PLIST_PATH = join(PLIST_DIR, `${PLIST_NAME}.plist`);

function generatePlist(binaryPath: string, logPath: string, interval: number): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${PLIST_NAME}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${binaryPath}</string>
    <string>run</string>
  </array>
  <key>StartInterval</key>
  <integer>${interval}</integer>
  <key>StandardOutPath</key>
  <string>${logPath}</string>
  <key>StandardErrorPath</key>
  <string>${logPath}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
</dict>
</plist>`;
}

export async function install(): Promise<void> {
  const config = await loadConfig();
  const logPath = resolveHomePath(config.log.file);

  // Determine binary path: compiled binary or bun script
  const distBinary = join(process.cwd(), "dist", "heimdall");
  const binaryPath = existsSync(distBinary)
    ? distBinary
    : `${process.cwd()}/src/index.ts`;

  // For .ts entry, wrap with bun
  const plistContent = existsSync(distBinary)
    ? generatePlist(distBinary, logPath, config.interval)
    : generatePlistBun(binaryPath, logPath, config.interval);

  await Bun.write(PLIST_PATH, plistContent);
  console.log(`Plist written to ${PLIST_PATH}`);

  const proc = Bun.spawnSync(["launchctl", "load", PLIST_PATH]);
  if (proc.exitCode === 0) {
    console.log(`Heimdall installed and loaded. Polling every ${config.interval}s.`);
  } else {
    console.error("Failed to load plist:", new TextDecoder().decode(proc.stderr));
  }
}

function generatePlistBun(scriptPath: string, logPath: string, interval: number): string {
  const bunPath = Bun.spawnSync(["which", "bun"]).stdout.toString().trim();
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${PLIST_NAME}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${bunPath}</string>
    <string>run</string>
    <string>${scriptPath}</string>
    <string>run</string>
  </array>
  <key>StartInterval</key>
  <integer>${interval}</integer>
  <key>StandardOutPath</key>
  <string>${logPath}</string>
  <key>StandardErrorPath</key>
  <string>${logPath}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
</dict>
</plist>`;
}

export { PLIST_PATH, PLIST_NAME };
```

- [ ] **Step 3: Create src/cli/uninstall.ts**

```typescript
import { existsSync, unlinkSync } from "fs";
import { PLIST_PATH, PLIST_NAME } from "./install";

export async function uninstall(): Promise<void> {
  const proc = Bun.spawnSync(["launchctl", "unload", PLIST_PATH]);
  if (proc.exitCode !== 0) {
    console.warn("Could not unload (may not be loaded)");
  }

  if (existsSync(PLIST_PATH)) {
    unlinkSync(PLIST_PATH);
    console.log(`Removed ${PLIST_PATH}`);
  }

  console.log("Heimdall uninstalled.");
}
```

- [ ] **Step 4: Create src/cli/start.ts and src/cli/stop.ts**

`src/cli/start.ts`:
```typescript
import { PLIST_PATH, PLIST_NAME } from "./install";
import { existsSync } from "fs";

export async function start(): Promise<void> {
  if (!existsSync(PLIST_PATH)) {
    console.error("Heimdall not installed. Run: heimdall install");
    process.exit(1);
  }
  const proc = Bun.spawnSync(["launchctl", "load", PLIST_PATH]);
  if (proc.exitCode === 0) {
    console.log("Heimdall started.");
  } else {
    console.error("Failed to start:", new TextDecoder().decode(proc.stderr));
  }
}
```

`src/cli/stop.ts`:
```typescript
import { PLIST_PATH } from "./install";

export async function stop(): Promise<void> {
  const proc = Bun.spawnSync(["launchctl", "unload", PLIST_PATH]);
  if (proc.exitCode === 0) {
    console.log("Heimdall stopped.");
  } else {
    console.error("Failed to stop:", new TextDecoder().decode(proc.stderr));
  }
}
```

- [ ] **Step 5: Create src/cli/status.ts**

```typescript
import { PLIST_NAME } from "./install";
import { resolveHomePath } from "../config";
import { existsSync } from "fs";

export async function status(): Promise<void> {
  // Check if launchd job is loaded
  const proc = Bun.spawnSync(["launchctl", "list", PLIST_NAME]);
  const isRunning = proc.exitCode === 0;

  console.log(`Heimdall: ${isRunning ? "RUNNING" : "STOPPED"}`);

  // Show recent reviews
  const reviewsDir = resolveHomePath("~/.heimdall/reviews");
  if (existsSync(reviewsDir)) {
    const glob = new Bun.Glob("**/*.md");
    const files: string[] = [];
    for await (const file of glob.scan(reviewsDir)) {
      files.push(file);
    }
    files.sort().reverse();
    const recent = files.slice(0, 5);
    if (recent.length > 0) {
      console.log(`\nRecent reviews (${files.length} total):`);
      for (const f of recent) {
        console.log(`  ${f}`);
      }
    }
  }

  // Show last log lines
  const logFile = resolveHomePath("~/.heimdall/heimdall.log");
  if (existsSync(logFile)) {
    const content = await Bun.file(logFile).text();
    const lines = content.trim().split("\n");
    const last5 = lines.slice(-5);
    console.log("\nRecent logs:");
    for (const line of last5) {
      console.log(`  ${line}`);
    }
  }
}
```

- [ ] **Step 6: Create src/cli/logs.ts**

```typescript
import { resolveHomePath } from "../config";
import { existsSync } from "fs";

export async function logs(): Promise<void> {
  const logFile = resolveHomePath("~/.heimdall/heimdall.log");
  if (!existsSync(logFile)) {
    console.log("No log file yet. Run: heimdall run");
    return;
  }

  // Use tail -f for live following
  const proc = Bun.spawn(["tail", "-f", "-n", "50", logFile], {
    stdout: "inherit",
    stderr: "inherit",
  });
  await proc.exited;
}
```

- [ ] **Step 7: Create src/index.ts — CLI entry point**

```typescript
#!/usr/bin/env bun

const command = process.argv[2];

switch (command) {
  case "run": {
    const { run } = await import("./cli/run");
    await run();
    break;
  }
  case "start": {
    const { start } = await import("./cli/start");
    await start();
    break;
  }
  case "stop": {
    const { stop } = await import("./cli/stop");
    await stop();
    break;
  }
  case "status": {
    const { status } = await import("./cli/status");
    await status();
    break;
  }
  case "logs": {
    const { logs } = await import("./cli/logs");
    await logs();
    break;
  }
  case "install": {
    const { install } = await import("./cli/install");
    await install();
    break;
  }
  case "uninstall": {
    const { uninstall } = await import("./cli/uninstall");
    await uninstall();
    break;
  }
  default:
    console.log(`
Heimdall — The All-Seeing PR Guardian

Usage: heimdall <command>

Commands:
  run          Execute a single poll cycle
  start        Start the daemon (launchd)
  stop         Stop the daemon
  status       Show running state and recent reviews
  logs         Tail the log file
  install      Generate and load launchd plist
  uninstall    Remove launchd plist
    `);
    break;
}
```

- [ ] **Step 8: Make entry point executable and test CLI**

```bash
cd /Users/oskarflores/code/stuff/heimdall
chmod +x src/index.ts
bun run src/index.ts
```

Expected: help text printed.

- [ ] **Step 9: Commit**

```bash
git add src/index.ts src/cli/
git commit -m "feat: add CLI entry point with all commands"
```

---

### Task 10: Build Script + Binary Compilation

**Files:**
- Create: `build.ts`

- [ ] **Step 1: Create build.ts**

```typescript
const result = await Bun.build({
  entrypoints: ["./src/index.ts"],
  outdir: "./dist",
  target: "bun",
  minify: true,
});

if (!result.success) {
  console.error("Build failed:");
  for (const msg of result.logs) {
    console.error(msg);
  }
  process.exit(1);
}

// Compile to standalone binary
const proc = Bun.spawnSync([
  "bun",
  "build",
  "--compile",
  "--minify",
  "./src/index.ts",
  "--outfile",
  "./dist/heimdall",
]);

if (proc.exitCode === 0) {
  console.log("Built: ./dist/heimdall");
} else {
  console.error("Compile failed:", new TextDecoder().decode(proc.stderr));
  process.exit(1);
}
```

- [ ] **Step 2: Test the build**

```bash
cd /Users/oskarflores/code/stuff/heimdall
bun run build.ts
ls -lh dist/heimdall
./dist/heimdall
```

Expected: binary exists (~50-90MB), prints help text.

- [ ] **Step 3: Add dist/ to .gitignore and commit**

```bash
echo 'dist/' >> .gitignore
git add build.ts .gitignore
git commit -m "feat: add build script for standalone binary compilation"
```

---

### Task 11: Default Config Generation + End-to-End Test

**Files:**
- Modify: `src/cli/run.ts` (add config init on first run)

- [ ] **Step 1: Update run.ts to generate default config if missing**

In `src/cli/run.ts`, after `await ensureHeimdallDir()`, add config generation:

```typescript
import { existsSync } from "fs";
import { DEFAULT_CONFIG_PATH, DEFAULT_CONFIG, resolveHomePath, loadConfig, ensureHeimdallDir } from "../config";

export async function run(): Promise<void> {
  await ensureHeimdallDir();

  // Generate default config on first run
  if (!existsSync(DEFAULT_CONFIG_PATH)) {
    const defaultWithRepo: typeof DEFAULT_CONFIG = {
      ...DEFAULT_CONFIG,
      sources: [
        {
          type: "github",
          repos: ["appfire-team/signal-iq"],
          trigger: "review-requested",
        },
      ],
      actions: {
        ...DEFAULT_CONFIG.actions,
        review: {
          ...DEFAULT_CONFIG.actions.review,
          repos: {
            "appfire-team/signal-iq": {
              prompt: "Review PR #{{pr_number}} in appfire-team/signal-iq against the project's DDD/Clean Architecture rules. Run automated scans. Report findings grouped by severity: FLAGRANT, VIOLATION, SUGGESTION.",
              cwd: "/Users/oskarflores/code/innovation/signal-iq",
            },
          },
        },
      },
    };
    await Bun.write(DEFAULT_CONFIG_PATH, JSON.stringify(defaultWithRepo, null, 2));
    console.log(`Config created at ${DEFAULT_CONFIG_PATH} — edit repos and paths.`);
  }

  // ... rest of existing run() code
```

- [ ] **Step 2: Run full end-to-end test**

```bash
cd /Users/oskarflores/code/stuff/heimdall
bun run src/index.ts run
```

Expected: Polls GitHub, finds any pending review requests, sends notification, and (if `claude` is available) starts a review. Check `~/.heimdall/heimdall.log` for output.

- [ ] **Step 3: Verify status command**

```bash
bun run src/index.ts status
```

Expected: shows RUNNING/STOPPED + any recent reviews.

- [ ] **Step 4: Run all tests**

```bash
cd /Users/oskarflores/code/stuff/heimdall
bun test
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/cli/run.ts
git commit -m "feat: auto-generate default config on first run"
```

---

### Task 12: Final Verification + Documentation

- [ ] **Step 1: Run full test suite**

```bash
cd /Users/oskarflores/code/stuff/heimdall
bun test
```

Expected: all passing.

- [ ] **Step 2: Build binary**

```bash
bun run build.ts
./dist/heimdall
./dist/heimdall run
```

Expected: binary works, polls GitHub.

- [ ] **Step 3: Test install/start/status/stop cycle**

```bash
./dist/heimdall install
./dist/heimdall status
# Wait 10 minutes or check logs
./dist/heimdall logs
./dist/heimdall stop
./dist/heimdall uninstall
```

- [ ] **Step 4: Commit everything**

```bash
cd /Users/oskarflores/code/stuff/heimdall
git add -A
git commit -m "chore: final verification — all tests pass, binary builds"
```
