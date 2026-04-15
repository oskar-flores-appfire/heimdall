# Jira-to-PR Autonomous Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Evolve Heimdall from a PR review watcher into an autonomous coding agent that triages Jira issues, gets user approval, implements code in isolated worktrees via Claude Code, and opens draft PRs.

**Architecture:** Two-loop model. A **Watcher** (launchd, every 10min) polls Jira, triages via Claude, and sends macOS notifications with approve/reject. On approval, a **Worker** (spawned on demand) picks up queued items, creates git worktrees, spawns `claude -p` for implementation, pushes the branch, and opens a draft PR via `gh`. Communication between loops is a file-based queue in `~/.heimdall/queue/`.

**Tech Stack:** Bun (runtime, test, build), TypeScript (strict), zero npm deps, `claude` CLI, `gh` CLI, `terminal-notifier`, launchd

---

## File Structure

### New files

| File | Responsibility |
|------|---------------|
| `src/sources/jira.ts` | Poll Jira REST API, normalize to `JiraIssue[]` |
| `src/actions/triage.ts` | Spawn `claude -p` to evaluate issue quality, save triage report |
| `src/queue.ts` | File-based queue CRUD (`~/.heimdall/queue/*.json`) |
| `src/worker.ts` | Pick queue item, create worktree, spawn Claude, push branch, create PR |
| `src/jira-cycle.ts` | Orchestrate Jira watcher: poll → triage → notify |
| `src/cli/triage.ts` | `heimdall triage <KEY>` — render report, prompt approve |
| `src/cli/approve.ts` | `heimdall approve <KEY>` — queue issue for implementation |
| `src/cli/worker-cmd.ts` | `heimdall worker` — start worker process |
| `src/cli/queue-cmd.ts` | `heimdall queue` — list queue items |
| `src/cli/clean.ts` | `heimdall clean` — remove old worktrees |
| `test/sources/jira.test.ts` | Jira source tests |
| `test/actions/triage.test.ts` | Triage action tests |
| `test/queue.test.ts` | Queue manager tests |
| `test/worker.test.ts` | Worker tests |
| `test/jira-cycle.test.ts` | Jira cycle orchestration tests |

### Modified files

| File | Changes |
|------|---------|
| `src/types.ts` | Add `JiraIssue`, `TriageResult`, `QueueItem`, config types; make `SourceConfig` a union |
| `src/config.ts` | Add defaults for triage/worker/costs; add `resolveSecret()` helper; ensure new dirs |
| `src/state.ts` | Add generic `hasBeenSeen()` / `markKey()` for non-PR entities |
| `src/actions/notify.ts` | Add `notifyTriage()`, `notifyNeedsDetail()`, `notifyWorkerComplete()`, `notifyWorkerFailed()` |
| `src/cli/run.ts` | Wire Jira sources into the run cycle |
| `src/index.ts` | Add `triage`, `approve`, `worker`, `queue`, `clean` commands |

---

### Task 1: Types & Config Foundation

**Files:**
- Modify: `src/types.ts`
- Modify: `src/config.ts`
- Modify: `src/state.ts`
- Test: `test/config.test.ts` (extend existing)
- Test: `test/state.test.ts` (extend existing)

- [ ] **Step 1: Write failing test for `resolveSecret` config helper**

```ts
// Append to test/config.test.ts
import { resolveSecret } from "../src/config";

describe("resolveSecret", () => {
  it("returns plain strings as-is", () => {
    expect(resolveSecret("my-token-123")).toBe("my-token-123");
  });

  it("resolves env: prefix to environment variable", () => {
    process.env.TEST_HEIMDALL_TOKEN = "secret-from-env";
    expect(resolveSecret("env:TEST_HEIMDALL_TOKEN")).toBe("secret-from-env");
    delete process.env.TEST_HEIMDALL_TOKEN;
  });

  it("throws when env var is not set", () => {
    expect(() => resolveSecret("env:NONEXISTENT_VAR_XYZ")).toThrow("not set");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/config.test.ts`
Expected: FAIL — `resolveSecret` is not exported

- [ ] **Step 3: Add all new types to `src/types.ts`**

Append after the existing types:

```ts
// --- Jira types ---

export interface JiraIssue {
  key: string;
  title: string;
  description: string;
  url: string;
  project: string;
  assignee: string;
  status: string;
  issueType: string;
}

export interface TriageResult {
  criteria: {
    acceptance_clarity: number;
    scope_boundedness: number;
    technical_detail: number;
  };
  total: number;
  max: number;
  size: "S" | "M" | "L" | "XL";
  verdict: string;
  concerns: string;
  suggested_files: string[];
}

export type TriageVerdict = "ready" | "needs_detail" | "too_big";

export interface TriageReport {
  issue: JiraIssue;
  result: TriageResult;
  verdict: TriageVerdict;
  timestamp: string;
}

export interface QueueItem {
  issueKey: string;
  title: string;
  description: string;
  approvedAt: string;
  status: "pending" | "in_progress" | "completed" | "failed";
  triageReport: string;
  repo: string;
  cwd: string;
  branch?: string;
  prUrl?: string;
  error?: string;
}

export interface ImplementationSummary {
  issueKey: string;
  title: string;
  triageScore: number;
  size: string;
  timings: { triageSeconds: number; implementationSeconds: number };
  cost: { inputTokens: number; outputTokens: number; cacheTokens: number; totalUsd: number };
  model: string;
  tests: { passing: number; failing: number };
  filesChanged: number;
  prUrl: string;
  status: "complete" | "incomplete";
  error?: string;
}

// --- Config types (extended) ---

export interface GitHubSourceConfig {
  type: "github";
  repos: string[];
  trigger: "review-requested";
}

export interface JiraSourceConfig {
  type: "jira";
  baseUrl: string;
  email: string;
  apiToken: string;
  jql: string;
  projects: Record<string, { repo: string; cwd: string }>;
}

export type SourceConfig = GitHubSourceConfig | JiraSourceConfig;

export interface TriageConfig {
  threshold: number;
  maxSize: "S" | "M" | "L" | "XL";
  model: string;
  timeoutMinutes: number;
}

export interface WorkerConfig {
  maxParallel: number;
  model: string;
  worktreeDir: string;
  maxTurns: number;
  claudeArgs: string[];
}

export interface CostConfig {
  [model: string]: { inputPer1k: number; outputPer1k: number };
}
```

Then update `HeimdallConfig` to include the new sections:

```ts
export interface HeimdallConfig {
  interval: number;
  sources: SourceConfig[];
  actions: ActionsConfig;
  reports: { dir: string };
  log: { file: string; level: LogLevel };
  triage: TriageConfig;
  worker: WorkerConfig;
  costs: CostConfig;
}
```

- [ ] **Step 4: Implement `resolveSecret` and add config defaults**

In `src/config.ts`, add the `resolveSecret` function and extend `DEFAULT_CONFIG`:

```ts
export function resolveSecret(value: string): string {
  if (value.startsWith("env:")) {
    const envVar = value.slice(4);
    const val = process.env[envVar];
    if (!val) throw new Error(`Environment variable ${envVar} is not set`);
    return val;
  }
  return value;
}
```

Update `DEFAULT_CONFIG` to include triage, worker, and costs:

```ts
export const DEFAULT_CONFIG: HeimdallConfig = {
  interval: 600,
  sources: [
    { type: "github", repos: [], trigger: "review-requested" },
  ],
  actions: {
    notify: { enabled: true, sound: "Glass", maxPerCycle: 5, batchThreshold: 3 },
    review: {
      enabled: true,
      command: "claude",
      defaultArgs: ["-p", "--permission-mode", "auto", "--output-format", "text"],
      repos: {},
    },
  },
  reports: { dir: `${HEIMDALL_DIR}/reviews` },
  log: { file: `${HEIMDALL_DIR}/heimdall.log`, level: "info" },
  triage: {
    threshold: 6,
    maxSize: "L",
    model: "sonnet",
    timeoutMinutes: 120,
  },
  worker: {
    maxParallel: 1,
    model: "opus",
    worktreeDir: `${HEIMDALL_DIR}/worktrees`,
    maxTurns: 100,
    claudeArgs: ["--permission-mode", "auto", "--output-format", "stream-json"],
  },
  costs: {
    "claude-opus-4-6": { inputPer1k: 0.015, outputPer1k: 0.075 },
    "claude-sonnet-4-6": { inputPer1k: 0.003, outputPer1k: 0.015 },
  },
};
```

Update `ensureHeimdallDir` to create new directories:

```ts
export async function ensureHeimdallDir(): Promise<void> {
  for (const dir of [
    HEIMDALL_DIR,
    resolveHomePath(DEFAULT_CONFIG.reports.dir),
    `${HEIMDALL_DIR}/queue`,
    `${HEIMDALL_DIR}/triage`,
    `${HEIMDALL_DIR}/worktrees`,
    `${HEIMDALL_DIR}/runs`,
  ]) {
    mkdirSync(dir, { recursive: true });
  }
}
```

- [ ] **Step 5: Run config tests to verify they pass**

Run: `bun test test/config.test.ts`
Expected: PASS — all existing + new tests pass

- [ ] **Step 6: Write failing test for generic state methods**

Append to `test/state.test.ts`:

```ts
describe("StateManager generic methods", () => {
  beforeEach(() => {
    mkdirSync("/tmp/heimdall-state-test", { recursive: true });
    if (existsSync(TEST_STATE)) rmSync(TEST_STATE);
  });

  afterEach(() => {
    rmSync("/tmp/heimdall-state-test", { recursive: true, force: true });
  });

  it("hasBeenSeen returns false for unseen keys", async () => {
    const state = new StateManager(TEST_STATE);
    expect(await state.hasBeenSeen("jira:test", "PROJ-123")).toBe(false);
  });

  it("hasBeenSeen returns true after markKey", async () => {
    const state = new StateManager(TEST_STATE);
    await state.markKey("jira:test", "PROJ-123");
    expect(await state.hasBeenSeen("jira:test", "PROJ-123")).toBe(true);
  });

  it("markKey stores custom entry data", async () => {
    const state = new StateManager(TEST_STATE);
    await state.markKey("jira:test", "PROJ-456", { reviewed: true });
    const data = await Bun.file(TEST_STATE).json();
    expect(data["jira:test"]["PROJ-456"].reviewed).toBe(true);
  });
});
```

- [ ] **Step 7: Run test to verify it fails**

Run: `bun test test/state.test.ts`
Expected: FAIL — `hasBeenSeen` and `markKey` don't exist

- [ ] **Step 8: Implement generic state methods in `src/state.ts`**

Add to `StateManager` class:

```ts
async hasBeenSeen(namespace: string, key: string): Promise<boolean> {
  const state = await this.load();
  return !!state[namespace]?.[key];
}

async markKey(namespace: string, key: string, entry?: Partial<SeenEntry>): Promise<void> {
  const state = await this.load();
  if (!state[namespace]) state[namespace] = {};
  state[namespace][key] = {
    seenAt: new Date().toISOString(),
    reviewed: false,
    ...entry,
  };
  await this.save(state);
}
```

- [ ] **Step 9: Run all tests to verify everything passes**

Run: `bun test`
Expected: PASS — all existing + new tests pass

- [ ] **Step 10: Commit**

```bash
git add src/types.ts src/config.ts src/state.ts test/config.test.ts test/state.test.ts
git commit -m "feat: add Jira types, config defaults, and generic state methods"
```

---

### Task 2: Jira Source

**Files:**
- Create: `src/sources/jira.ts`
- Test: `test/sources/jira.test.ts`

**Implementation note:** When implementing, use the `context7` MCP tool to fetch current Jira Cloud REST API v3 documentation. Verify the `/rest/api/3/search` endpoint shape, field names, and ADF description format against the latest docs.

- [ ] **Step 1: Write failing tests for JiraSource**

```ts
// test/sources/jira.test.ts
import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { JiraSource, adfToText } from "../src/sources/jira";
import type { JiraSourceConfig } from "../src/types";
import type { Logger } from "../src/logger";

const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

const testConfig: JiraSourceConfig = {
  type: "jira",
  baseUrl: "https://test.atlassian.net",
  email: "test@example.com",
  apiToken: "test-token",
  jql: "assignee = currentUser() AND status = 'To Do'",
  projects: {
    PROJ: { repo: "org/repo", cwd: "/path/to/repo" },
  },
};

const jiraApiResponse = {
  issues: [
    {
      key: "PROJ-123",
      fields: {
        summary: "Auth middleware refactor",
        description: {
          type: "doc",
          version: 1,
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: "Refactor the auth middleware to use JWT." }],
            },
          ],
        },
        status: { name: "To Do" },
        assignee: { emailAddress: "test@example.com" },
        issuetype: { name: "Story" },
        project: { key: "PROJ" },
      },
    },
  ],
};

describe("adfToText", () => {
  it("extracts text from ADF document", () => {
    const adf = jiraApiResponse.issues[0].fields.description;
    expect(adfToText(adf)).toBe("Refactor the auth middleware to use JWT.");
  });

  it("returns empty string for null/undefined", () => {
    expect(adfToText(null)).toBe("");
    expect(adfToText(undefined)).toBe("");
  });

  it("handles nested content with multiple paragraphs", () => {
    const adf = {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "Line 1." }] },
        { type: "paragraph", content: [{ type: "text", text: "Line 2." }] },
      ],
    };
    expect(adfToText(adf)).toBe("Line 1.\nLine 2.");
  });
});

describe("JiraSource", () => {
  it("polls and normalizes issues", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(JSON.stringify(jiraApiResponse), { status: 200 }))
    ) as any;

    const source = new JiraSource(testConfig, noopLogger);
    const issues = await source.poll();

    expect(issues).toHaveLength(1);
    expect(issues[0].key).toBe("PROJ-123");
    expect(issues[0].title).toBe("Auth middleware refactor");
    expect(issues[0].description).toBe("Refactor the auth middleware to use JWT.");
    expect(issues[0].url).toBe("https://test.atlassian.net/browse/PROJ-123");
    expect(issues[0].project).toBe("PROJ");

    globalThis.fetch = originalFetch;
  });

  it("sends correct auth header", async () => {
    let capturedHeaders: Headers | undefined;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock((url: string, init: RequestInit) => {
      capturedHeaders = new Headers(init.headers);
      return Promise.resolve(new Response(JSON.stringify({ issues: [] }), { status: 200 }));
    }) as any;

    const source = new JiraSource(testConfig, noopLogger);
    await source.poll();

    const authHeader = capturedHeaders!.get("Authorization")!;
    const decoded = atob(authHeader.replace("Basic ", ""));
    expect(decoded).toBe("test@example.com:test-token");

    globalThis.fetch = originalFetch;
  });

  it("returns empty array on API error", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response("Unauthorized", { status: 401 }))
    ) as any;

    const source = new JiraSource(testConfig, noopLogger);
    const issues = await source.poll();
    expect(issues).toHaveLength(0);

    globalThis.fetch = originalFetch;
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/sources/jira.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `JiraSource`**

```ts
// src/sources/jira.ts
import type { JiraIssue, JiraSourceConfig } from "../types";
import type { Logger } from "../logger";
import { resolveSecret } from "../config";

export function adfToText(node: any): string {
  if (!node) return "";
  if (node.type === "text") return node.text || "";
  if (node.content && Array.isArray(node.content)) {
    const parts = node.content.map(adfToText);
    // Add newlines between block-level nodes (paragraphs, headings, etc.)
    if (node.type === "doc") return parts.join("\n");
    return parts.join("");
  }
  return "";
}

export class JiraSource {
  readonly name = "jira";

  constructor(
    private readonly config: JiraSourceConfig,
    private readonly logger: Logger
  ) {}

  async poll(): Promise<JiraIssue[]> {
    const token = resolveSecret(this.config.apiToken);
    const auth = btoa(`${this.config.email}:${token}`);
    const jql = encodeURIComponent(this.config.jql);
    const fields = "summary,description,status,assignee,issuetype,project";
    const url = `${this.config.baseUrl}/rest/api/3/search?jql=${jql}&fields=${fields}`;

    this.logger.info(`Polling Jira: ${this.config.baseUrl}`);

    try {
      const res = await fetch(url, {
        headers: {
          Authorization: `Basic ${auth}`,
          Accept: "application/json",
        },
      });

      if (!res.ok) {
        this.logger.error(`Jira API error: ${res.status} ${res.statusText}`);
        return [];
      }

      const data = await res.json();
      const issues: JiraIssue[] = (data.issues || []).map((issue: any) => ({
        key: issue.key,
        title: issue.fields.summary,
        description: adfToText(issue.fields.description),
        url: `${this.config.baseUrl}/browse/${issue.key}`,
        project: issue.fields.project.key,
        assignee: issue.fields.assignee?.emailAddress || "",
        status: issue.fields.status.name,
        issueType: issue.fields.issuetype.name,
      }));

      this.logger.info(`Found ${issues.length} Jira issue(s)`);
      return issues;
    } catch (err) {
      this.logger.error(`Jira poll failed: ${err}`);
      return [];
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/sources/jira.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/sources/jira.ts test/sources/jira.test.ts
git commit -m "feat: add JiraSource with REST API polling"
```

---

### Task 3: Queue Manager

**Files:**
- Create: `src/queue.ts`
- Test: `test/queue.test.ts`

- [ ] **Step 1: Write failing tests for QueueManager**

```ts
// test/queue.test.ts
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { QueueManager } from "../src/queue";
import { mkdirSync, rmSync, existsSync } from "fs";
import type { QueueItem } from "../src/types";

const TEST_DIR = "/tmp/heimdall-queue-test";

function makeItem(key: string, status: QueueItem["status"] = "pending"): QueueItem {
  return {
    issueKey: key,
    title: `${key} title`,
    description: "test description",
    approvedAt: new Date().toISOString(),
    status,
    triageReport: `~/.heimdall/triage/${key}.md`,
    repo: "org/repo",
    cwd: "/path/to/repo",
  };
}

describe("QueueManager", () => {
  let queue: QueueManager;

  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
    queue = new QueueManager(TEST_DIR);
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("enqueue writes a JSON file", async () => {
    await queue.enqueue(makeItem("PROJ-1"));
    expect(existsSync(`${TEST_DIR}/PROJ-1.json`)).toBe(true);
  });

  it("list returns all items sorted by approvedAt", async () => {
    const item1 = makeItem("PROJ-1");
    item1.approvedAt = "2026-04-14T10:00:00Z";
    const item2 = makeItem("PROJ-2");
    item2.approvedAt = "2026-04-14T09:00:00Z";
    await queue.enqueue(item1);
    await queue.enqueue(item2);

    const items = await queue.list();
    expect(items).toHaveLength(2);
    expect(items[0].issueKey).toBe("PROJ-2"); // older first (FIFO)
  });

  it("pickNext returns oldest pending item", async () => {
    const item1 = makeItem("PROJ-1");
    item1.approvedAt = "2026-04-14T10:00:00Z";
    const item2 = makeItem("PROJ-2");
    item2.approvedAt = "2026-04-14T09:00:00Z";
    await queue.enqueue(item1);
    await queue.enqueue(item2);

    const next = await queue.pickNext();
    expect(next!.issueKey).toBe("PROJ-2");
  });

  it("pickNext returns null when queue is empty", async () => {
    const next = await queue.pickNext();
    expect(next).toBeNull();
  });

  it("pickNext skips non-pending items", async () => {
    await queue.enqueue(makeItem("PROJ-1", "in_progress"));
    await queue.enqueue(makeItem("PROJ-2", "pending"));

    const next = await queue.pickNext();
    expect(next!.issueKey).toBe("PROJ-2");
  });

  it("update persists status changes", async () => {
    await queue.enqueue(makeItem("PROJ-1"));
    await queue.update("PROJ-1", { status: "in_progress", branch: "heimdall/PROJ-1" });

    const item = await queue.get("PROJ-1");
    expect(item!.status).toBe("in_progress");
    expect(item!.branch).toBe("heimdall/PROJ-1");
  });

  it("get returns null for nonexistent item", async () => {
    const item = await queue.get("NONEXISTENT-999");
    expect(item).toBeNull();
  });

  it("remove deletes the queue file", async () => {
    await queue.enqueue(makeItem("PROJ-1"));
    await queue.remove("PROJ-1");
    expect(existsSync(`${TEST_DIR}/PROJ-1.json`)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/queue.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `QueueManager`**

```ts
// src/queue.ts
import { existsSync, unlinkSync } from "fs";
import { join } from "path";
import type { QueueItem } from "./types";

export class QueueManager {
  constructor(private readonly dir: string) {}

  async enqueue(item: QueueItem): Promise<void> {
    const path = join(this.dir, `${item.issueKey}.json`);
    await Bun.write(path, JSON.stringify(item, null, 2));
  }

  async get(issueKey: string): Promise<QueueItem | null> {
    const path = join(this.dir, `${issueKey}.json`);
    if (!existsSync(path)) return null;
    return Bun.file(path).json();
  }

  async list(): Promise<QueueItem[]> {
    const glob = new Bun.Glob("*.json");
    const items: QueueItem[] = [];
    for await (const file of glob.scan(this.dir)) {
      const item = await Bun.file(join(this.dir, file)).json();
      items.push(item);
    }
    return items.sort((a, b) => a.approvedAt.localeCompare(b.approvedAt));
  }

  async pickNext(): Promise<QueueItem | null> {
    const items = await this.list();
    return items.find((i) => i.status === "pending") ?? null;
  }

  async update(issueKey: string, updates: Partial<QueueItem>): Promise<void> {
    const item = await this.get(issueKey);
    if (!item) return;
    Object.assign(item, updates);
    await this.enqueue(item);
  }

  async remove(issueKey: string): Promise<void> {
    const path = join(this.dir, `${issueKey}.json`);
    if (existsSync(path)) unlinkSync(path);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/queue.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/queue.ts test/queue.test.ts
git commit -m "feat: add file-based QueueManager"
```

---

### Task 4: Triage Action

**Files:**
- Create: `src/actions/triage.ts`
- Test: `test/actions/triage.test.ts`

- [ ] **Step 1: Write failing tests for triage**

```ts
// test/actions/triage.test.ts
import { describe, it, expect, mock } from "bun:test";
import {
  buildTriagePrompt,
  parseTriageResult,
  evaluateVerdict,
} from "../src/actions/triage";
import type { JiraIssue, TriageConfig } from "../src/types";

const testIssue: JiraIssue = {
  key: "PROJ-123",
  title: "Auth middleware refactor",
  description: "Refactor auth middleware to use JWT. AC: tokens expire after 1h.",
  url: "https://test.atlassian.net/browse/PROJ-123",
  project: "PROJ",
  assignee: "test@example.com",
  status: "To Do",
  issueType: "Story",
};

const triageConfig: TriageConfig = {
  threshold: 6,
  maxSize: "L",
  model: "sonnet",
  timeoutMinutes: 120,
};

const validResult = {
  criteria: { acceptance_clarity: 2, scope_boundedness: 3, technical_detail: 1 },
  total: 6,
  max: 9,
  size: "M" as const,
  verdict: "Well-defined. Touches auth middleware and its tests.",
  concerns: "No error handling scenarios specified.",
  suggested_files: ["src/auth/middleware.ts"],
};

describe("buildTriagePrompt", () => {
  it("includes issue key and title", () => {
    const prompt = buildTriagePrompt(testIssue);
    expect(prompt).toContain("PROJ-123");
    expect(prompt).toContain("Auth middleware refactor");
  });

  it("includes issue description", () => {
    const prompt = buildTriagePrompt(testIssue);
    expect(prompt).toContain("Refactor auth middleware to use JWT");
  });

  it("includes scoring rubric", () => {
    const prompt = buildTriagePrompt(testIssue);
    expect(prompt).toContain("acceptance_clarity");
    expect(prompt).toContain("scope_boundedness");
    expect(prompt).toContain("technical_detail");
  });
});

describe("parseTriageResult", () => {
  it("parses valid JSON response", () => {
    const result = parseTriageResult(JSON.stringify(validResult));
    expect(result.total).toBe(6);
    expect(result.size).toBe("M");
    expect(result.criteria.acceptance_clarity).toBe(2);
  });

  it("extracts JSON from markdown-wrapped response", () => {
    const wrapped = "```json\n" + JSON.stringify(validResult) + "\n```";
    const result = parseTriageResult(wrapped);
    expect(result.total).toBe(6);
  });

  it("throws on invalid JSON", () => {
    expect(() => parseTriageResult("not json at all")).toThrow();
  });
});

describe("evaluateVerdict", () => {
  it("returns ready when score >= threshold and size <= maxSize", () => {
    expect(evaluateVerdict(validResult, triageConfig)).toBe("ready");
  });

  it("returns needs_detail when score < threshold", () => {
    const low = { ...validResult, total: 3 };
    expect(evaluateVerdict(low, triageConfig)).toBe("needs_detail");
  });

  it("returns too_big when size is XL", () => {
    const xl = { ...validResult, size: "XL" as const };
    expect(evaluateVerdict(xl, triageConfig)).toBe("too_big");
  });

  it("returns too_big when size exceeds maxSize", () => {
    const config = { ...triageConfig, maxSize: "S" as const };
    expect(evaluateVerdict(validResult, config)).toBe("too_big");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/actions/triage.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement triage pure functions**

```ts
// src/actions/triage.ts
import { mkdirSync } from "fs";
import { join, dirname } from "path";
import type {
  JiraIssue,
  TriageResult,
  TriageVerdict,
  TriageReport,
  TriageConfig,
} from "../types";
import type { Logger } from "../logger";
import { HEIMDALL_DIR, resolveHomePath } from "../config";

const SIZE_ORDER = ["S", "M", "L", "XL"] as const;

export function buildTriagePrompt(issue: JiraIssue): string {
  return `You are evaluating a Jira issue for automated implementation by an AI coding agent.

## Issue
Key: ${issue.key}
Title: ${issue.title}
Type: ${issue.issueType}
Status: ${issue.status}

## Description
${issue.description}

## Scoring Rubric
Rate each criterion 0-3:

1. **acceptance_clarity** (0-3): Are acceptance criteria explicit and testable?
   - 0: No acceptance criteria
   - 1: Vague requirements
   - 2: Clear but incomplete criteria
   - 3: Explicit, testable acceptance criteria

2. **scope_boundedness** (0-3): Is the scope well-defined and contained?
   - 0: Unbounded, unclear scope
   - 1: Broad scope, many unknowns
   - 2: Mostly bounded, minor ambiguities
   - 3: Tightly scoped, clear boundaries

3. **technical_detail** (0-3): Is enough technical context provided?
   - 0: No technical context
   - 1: Minimal technical info
   - 2: Adequate context, some gaps
   - 3: Full technical context, files/APIs identified

## Size Estimate
- S: < 50 lines changed, 1-2 files
- M: 50-200 lines, 3-5 files
- L: 200-500 lines, 5-10 files
- XL: > 500 lines or > 10 files

## Output
Respond with ONLY valid JSON (no markdown wrapping):
{
  "criteria": {
    "acceptance_clarity": <0-3>,
    "scope_boundedness": <0-3>,
    "technical_detail": <0-3>
  },
  "total": <sum of criteria>,
  "max": 9,
  "size": "<S|M|L|XL>",
  "verdict": "<one sentence assessment>",
  "concerns": "<what is missing or concerning>",
  "suggested_files": ["<files likely to need changes>"]
}`;
}

export function parseTriageResult(raw: string): TriageResult {
  let text = raw.trim();
  // Strip markdown code fence if present
  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenceMatch) text = fenceMatch[1].trim();
  return JSON.parse(text) as TriageResult;
}

export function evaluateVerdict(
  result: TriageResult,
  config: TriageConfig
): TriageVerdict {
  const sizeIdx = SIZE_ORDER.indexOf(result.size);
  const maxIdx = SIZE_ORDER.indexOf(config.maxSize);
  if (sizeIdx > maxIdx || result.size === "XL") return "too_big";
  if (result.total < config.threshold) return "needs_detail";
  return "ready";
}

export class TriageAction {
  constructor(
    private readonly config: TriageConfig,
    private readonly logger: Logger
  ) {}

  async triage(issue: JiraIssue): Promise<TriageReport> {
    const prompt = buildTriagePrompt(issue);
    this.logger.info(`Triaging ${issue.key}: ${issue.title}`);

    const startTime = Date.now();
    const proc = Bun.spawn(
      ["claude", "-p", prompt, "--output-format", "json", "--model", this.config.model],
      { stdout: "pipe", stderr: "pipe", env: { ...process.env, TERM: "dumb" } }
    );

    const exitCode = await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    if (exitCode !== 0) {
      this.logger.error(`Triage failed for ${issue.key}: ${stderr}`);
      throw new Error(`Triage claude process exited with code ${exitCode}: ${stderr}`);
    }

    // Parse the result field from --output-format json
    let resultText = stdout;
    try {
      const jsonOutput = JSON.parse(stdout);
      if (jsonOutput.result) resultText = jsonOutput.result;
    } catch {
      // stdout may be the raw text if not wrapped in JSON envelope
    }

    const result = parseTriageResult(resultText);
    const verdict = evaluateVerdict(result, this.config);

    this.logger.info(`Triage ${issue.key}: score=${result.total}/${result.max} size=${result.size} verdict=${verdict} (${elapsed}s)`);

    const report: TriageReport = {
      issue,
      result,
      verdict,
      timestamp: new Date().toISOString(),
    };

    await this.saveReport(report);
    return report;
  }

  private async saveReport(report: TriageReport): Promise<void> {
    const path = this.reportPath(report.issue.key);
    mkdirSync(dirname(path), { recursive: true });

    const md = `# Triage: ${report.issue.key}

**Title:** ${report.issue.title}
**Type:** ${report.issue.issueType}
**Verdict:** ${report.verdict.toUpperCase()}
**Score:** ${report.result.total}/${report.result.max}
**Size:** ${report.result.size}
**Triaged:** ${report.timestamp}

## Scores
| Criterion | Score |
|-----------|-------|
| Acceptance Clarity | ${report.result.criteria.acceptance_clarity}/3 |
| Scope Boundedness | ${report.result.criteria.scope_boundedness}/3 |
| Technical Detail | ${report.result.criteria.technical_detail}/3 |

## Assessment
${report.result.verdict}

## Concerns
${report.result.concerns}

## Suggested Files
${report.result.suggested_files.map((f) => `- \`${f}\``).join("\n")}

---
*Triage report generated by Heimdall*
`;

    await Bun.write(path, md);
    // Also save the raw JSON for machine consumption
    await Bun.write(path.replace(".md", ".json"), JSON.stringify(report, null, 2));
    this.logger.info(`Triage report saved: ${path}`);
  }

  reportPath(issueKey: string): string {
    return join(resolveHomePath(`${HEIMDALL_DIR}/triage`), `${issueKey}.md`);
  }
}
```

- [ ] **Step 4: Run tests to verify pure function tests pass**

Run: `bun test test/actions/triage.test.ts`
Expected: PASS — all tests for `buildTriagePrompt`, `parseTriageResult`, `evaluateVerdict` pass

- [ ] **Step 5: Commit**

```bash
git add src/actions/triage.ts test/actions/triage.test.ts
git commit -m "feat: add TriageAction with Claude evaluation and triage reports"
```

---

### Task 5: Notification Extensions

**Files:**
- Modify: `src/actions/notify.ts`
- Test: `test/actions/notify.test.ts` (extend existing)

- [ ] **Step 1: Write failing tests for triage notifications**

Append to `test/actions/notify.test.ts`:

```ts
import type { JiraIssue, TriageReport, TriageResult } from "../src/types";

const testIssue: JiraIssue = {
  key: "PROJ-123",
  title: "Auth middleware refactor",
  description: "Test description",
  url: "https://test.atlassian.net/browse/PROJ-123",
  project: "PROJ",
  assignee: "test@example.com",
  status: "To Do",
  issueType: "Story",
};

const testTriageReport: TriageReport = {
  issue: testIssue,
  result: {
    criteria: { acceptance_clarity: 2, scope_boundedness: 3, technical_detail: 2 },
    total: 7,
    max: 9,
    size: "M",
    verdict: "Well-defined",
    concerns: "None",
    suggested_files: ["src/auth.ts"],
  },
  verdict: "ready",
  timestamp: "2026-04-15T10:00:00Z",
};

describe("NotifyAction triage notifications", () => {
  it("notifyTriage returns success", async () => {
    // Uses "none" notifier in test env (no terminal-notifier installed in CI)
    const notify = new NotifyAction("Glass", noopLogger);
    const result = await notify.notifyTriage(testIssue, testTriageReport);
    expect(result.action).toBe("notify");
    // success depends on notifier availability; just verify no throw
  });

  it("notifyNeedsDetail returns success", async () => {
    const notify = new NotifyAction("Glass", noopLogger);
    const needsDetail = { ...testTriageReport, verdict: "needs_detail" as const };
    const result = await notify.notifyNeedsDetail(testIssue, needsDetail);
    expect(result.action).toBe("notify");
  });

  it("notifyTooBig returns success", async () => {
    const notify = new NotifyAction("Glass", noopLogger);
    const tooBig = { ...testTriageReport, verdict: "too_big" as const };
    tooBig.result = { ...tooBig.result, size: "XL" as const };
    const result = await notify.notifyTooBig(testIssue, tooBig);
    expect(result.action).toBe("notify");
  });

  it("notifyWorkerComplete returns success", async () => {
    const notify = new NotifyAction("Glass", noopLogger);
    const result = await notify.notifyWorkerComplete("PROJ-123", "https://github.com/org/repo/pull/1", 7, "$0.47", "8m 34s");
    expect(result.action).toBe("notify");
  });

  it("notifyWorkerFailed returns success", async () => {
    const notify = new NotifyAction("Glass", noopLogger);
    const result = await notify.notifyWorkerFailed("PROJ-123", "Tests failed");
    expect(result.action).toBe("notify");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/actions/notify.test.ts`
Expected: FAIL — `notifyTriage` method does not exist

- [ ] **Step 3: Add triage notification methods to `NotifyAction`**

Add these methods to the `NotifyAction` class in `src/actions/notify.ts`. Add the necessary imports at the top:

```ts
import type { JiraIssue, TriageReport } from "../types";
```

Methods to add to the class:

```ts
async notifyTriage(issue: JiraIssue, report: TriageReport): Promise<ActionResult> {
  const score = `${report.result.total}/${report.result.max}`;
  const files = report.result.suggested_files.length;
  const message = `Score: ${score} (${report.result.total >= 7 ? "High" : "Medium"}) | Size: ${report.result.size} | ${files} file(s)\nReady for implementation`;
  try {
    await this.sendTriage(
      `Heimdall — ${issue.key}`,
      issue.title,
      message,
      `heimdall triage ${issue.key}`,     // click: open triage report
      `heimdall approve ${issue.key}`,     // action button: approve directly
      `heimdall-triage-${issue.key}`
    );
    this.logger.info(`Triage notification sent: ${issue.key}`);
    return { action: "notify", success: true, message };
  } catch (err) {
    this.logger.error(`Triage notification failed: ${err}`);
    return { action: "notify", success: false, message: String(err) };
  }
}

async notifyNeedsDetail(issue: JiraIssue, report: TriageReport): Promise<ActionResult> {
  const score = `${report.result.total}/${report.result.max}`;
  const message = `Score: ${score} — ${report.result.concerns}`;
  try {
    await this.send(
      `Heimdall — ${issue.key}`,
      issue.title,
      message,
      issue.url,
      `heimdall-triage-${issue.key}`
    );
    this.logger.info(`Needs-detail notification: ${issue.key}`);
    return { action: "notify", success: true, message };
  } catch (err) {
    this.logger.error(`Needs-detail notification failed: ${err}`);
    return { action: "notify", success: false, message: String(err) };
  }
}

async notifyTooBig(issue: JiraIssue, report: TriageReport): Promise<ActionResult> {
  const message = `Size: ${report.result.size} — too large for autonomous implementation. Consider decomposing.`;
  try {
    await this.send(
      `Heimdall — ${issue.key}`,
      issue.title,
      message,
      issue.url,
      `heimdall-triage-${issue.key}`
    );
    this.logger.info(`Too-big notification: ${issue.key}`);
    return { action: "notify", success: true, message };
  } catch (err) {
    this.logger.error(`Too-big notification failed: ${err}`);
    return { action: "notify", success: false, message: String(err) };
  }
}

async notifyWorkerComplete(
  issueKey: string,
  prUrl: string,
  score: number,
  cost: string,
  duration: string
): Promise<ActionResult> {
  const message = `PR opened | ${score}/9 confidence | ${cost} | ${duration}`;
  try {
    await this.send(
      `Heimdall \u2713 — ${issueKey}`,
      "Implementation complete",
      message,
      prUrl,
      `heimdall-worker-${issueKey}`
    );
    this.logger.info(`Worker complete notification: ${issueKey}`);
    return { action: "notify", success: true, message };
  } catch (err) {
    this.logger.error(`Worker complete notification failed: ${err}`);
    return { action: "notify", success: false, message: String(err) };
  }
}

async notifyWorkerFailed(issueKey: string, error: string): Promise<ActionResult> {
  const message = `${issueKey} failed — ${error}`;
  try {
    await this.send(
      `Heimdall \u2717 — ${issueKey}`,
      "Implementation failed",
      message,
      "",
      `heimdall-worker-${issueKey}`
    );
    this.logger.info(`Worker failed notification: ${issueKey}`);
    return { action: "notify", success: true, message };
  } catch (err) {
    this.logger.error(`Worker failed notification failed: ${err}`);
    return { action: "notify", success: false, message: String(err) };
  }
}

private async sendTriage(
  title: string,
  subtitle: string,
  message: string,
  clickCommand: string,
  approveCommand: string,
  group: string
): Promise<void> {
  if (this.notifier === "terminal-notifier") {
    // -execute runs on default click (shows full triage report)
    // -actions "Approve" adds an action button
    // When "Approve" is clicked, terminal-notifier outputs "Approve" to stdout
    // We wrap the execute command to handle both cases:
    // Default click → heimdall triage KEY (interactive view)
    // Approve button → heimdall approve KEY (direct queue)
    const wrapperScript = `if [ "$TERMINAL_NOTIFIER_ACTIVATION_TYPE" = "actionClicked" ]; then ${approveCommand}; else ${clickCommand}; fi`;
    const proc = Bun.spawn([
      "terminal-notifier",
      "-title", title,
      "-subtitle", subtitle,
      "-message", message,
      "-execute", wrapperScript,
      "-actions", "Approve",
      "-sound", this.sound,
      "-group", group,
    ]);
    await proc.exited;
  } else if (this.notifier === "osascript") {
    const script = `display notification "${message}" with title "${title}" subtitle "${subtitle}" sound name "${this.sound}"`;
    const proc = Bun.spawn(["osascript", "-e", script]);
    await proc.exited;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/actions/notify.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/actions/notify.ts test/actions/notify.test.ts
git commit -m "feat: add triage and worker notification methods"
```

---

### Task 6: Jira Watcher Cycle

**Files:**
- Create: `src/jira-cycle.ts`
- Test: `test/jira-cycle.test.ts`

- [ ] **Step 1: Write failing tests for `runJiraCycle`**

```ts
// test/jira-cycle.test.ts
import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { runJiraCycle } from "../src/jira-cycle";
import { StateManager } from "../src/state";
import { mkdirSync, rmSync, existsSync } from "fs";
import type { JiraIssue, TriageReport, HeimdallConfig } from "../src/types";
import type { Logger } from "../src/logger";

const TEST_DIR = "/tmp/heimdall-jira-cycle-test";
const TEST_STATE = `${TEST_DIR}/seen.json`;

const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

const testIssue: JiraIssue = {
  key: "PROJ-1",
  title: "Test issue",
  description: "Test",
  url: "https://test.atlassian.net/browse/PROJ-1",
  project: "PROJ",
  assignee: "test@example.com",
  status: "To Do",
  issueType: "Story",
};

const readyReport: TriageReport = {
  issue: testIssue,
  result: {
    criteria: { acceptance_clarity: 3, scope_boundedness: 2, technical_detail: 2 },
    total: 7,
    max: 9,
    size: "M",
    verdict: "Well-defined",
    concerns: "None",
    suggested_files: [],
  },
  verdict: "ready",
  timestamp: new Date().toISOString(),
};

describe("runJiraCycle", () => {
  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("skips already-seen issues", async () => {
    const state = new StateManager(TEST_STATE);
    await state.markKey("jira:test.atlassian.net", "PROJ-1");

    const pollFn = mock(() => Promise.resolve([testIssue]));
    const triageFn = mock(() => Promise.resolve(readyReport));
    const notifyFn = mock(() => Promise.resolve());

    await runJiraCycle({
      poll: pollFn,
      triage: triageFn,
      notify: notifyFn,
      state,
      namespace: "jira:test.atlassian.net",
      logger: noopLogger,
    });

    expect(triageFn).not.toHaveBeenCalled();
  });

  it("triages and notifies new issues", async () => {
    const state = new StateManager(TEST_STATE);

    const pollFn = mock(() => Promise.resolve([testIssue]));
    const triageFn = mock(() => Promise.resolve(readyReport));
    const notifyFn = mock(() => Promise.resolve());

    await runJiraCycle({
      poll: pollFn,
      triage: triageFn,
      notify: notifyFn,
      state,
      namespace: "jira:test.atlassian.net",
      logger: noopLogger,
    });

    expect(triageFn).toHaveBeenCalledTimes(1);
    expect(notifyFn).toHaveBeenCalledTimes(1);
  });

  it("marks triaged issues as seen", async () => {
    const state = new StateManager(TEST_STATE);

    await runJiraCycle({
      poll: () => Promise.resolve([testIssue]),
      triage: () => Promise.resolve(readyReport),
      notify: () => Promise.resolve(),
      state,
      namespace: "jira:test.atlassian.net",
      logger: noopLogger,
    });

    expect(await state.hasBeenSeen("jira:test.atlassian.net", "PROJ-1")).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/jira-cycle.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `runJiraCycle`**

```ts
// src/jira-cycle.ts
import type { JiraIssue, TriageReport } from "./types";
import type { StateManager } from "./state";
import type { Logger } from "./logger";

export interface JiraCycleDeps {
  poll: () => Promise<JiraIssue[]>;
  triage: (issue: JiraIssue) => Promise<TriageReport>;
  notify: (issue: JiraIssue, report: TriageReport) => Promise<void>;
  state: StateManager;
  namespace: string;
  logger: Logger;
}

export async function runJiraCycle(deps: JiraCycleDeps): Promise<void> {
  const { poll, triage, notify, state, namespace, logger } = deps;

  logger.info("Jira cycle started");

  let issues: JiraIssue[];
  try {
    issues = await poll();
    logger.info(`Found ${issues.length} Jira issue(s)`);
  } catch (err) {
    logger.error(`Jira poll failed: ${err}`);
    return;
  }

  // Filter to unseen issues
  const newIssues: JiraIssue[] = [];
  for (const issue of issues) {
    if (!(await state.hasBeenSeen(namespace, issue.key))) {
      newIssues.push(issue);
    }
  }

  if (newIssues.length === 0) {
    logger.info("No new Jira issues to process");
    return;
  }

  logger.info(`Processing ${newIssues.length} new issue(s)`);

  for (const issue of newIssues) {
    try {
      const report = await triage(issue);
      await notify(issue, report);
      await state.markKey(namespace, issue.key);
    } catch (err) {
      logger.error(`Failed to process ${issue.key}: ${err}`);
      // Mark as seen even on failure to avoid retrying broken issues endlessly
      await state.markKey(namespace, issue.key);
    }
  }

  logger.info("Jira cycle completed");
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/jira-cycle.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/jira-cycle.ts test/jira-cycle.test.ts
git commit -m "feat: add Jira watcher cycle orchestration"
```

---

### Task 7: CLI Commands — Triage & Approve

**Files:**
- Create: `src/cli/triage.ts`
- Create: `src/cli/approve.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Implement `heimdall triage <KEY>`**

```ts
// src/cli/triage.ts
import { existsSync } from "fs";
import { join } from "path";
import { HEIMDALL_DIR, resolveHomePath } from "../config";

export async function triage(): Promise<void> {
  const issueKey = process.argv[3];
  if (!issueKey) {
    console.error("Usage: heimdall triage <ISSUE-KEY>");
    process.exit(1);
  }

  const reportPath = join(resolveHomePath(HEIMDALL_DIR), "triage", `${issueKey}.md`);
  if (!existsSync(reportPath)) {
    console.error(`No triage report found for ${issueKey}`);
    console.error(`Expected: ${reportPath}`);
    process.exit(1);
  }

  // Render report using bat or cat
  const bat = Bun.spawnSync(["which", "bat"]);
  const viewer = bat.exitCode === 0 ? "bat" : "cat";
  const proc = Bun.spawn([viewer, reportPath], {
    stdout: "inherit",
    stderr: "inherit",
  });
  await proc.exited;

  // Prompt for approval
  process.stdout.write(`\nApprove ${issueKey} for Heimdall? [y/n]: `);
  const reader = Bun.stdin.stream().getReader();
  const { value } = await reader.read();
  reader.releaseLock();
  const answer = new TextDecoder().decode(value).trim().toLowerCase();

  if (answer === "y" || answer === "yes") {
    const { approve } = await import("./approve");
    // Override argv so approve picks up the key
    process.argv[3] = issueKey;
    await approve();
  } else {
    console.log("Skipped.");
  }
}
```

- [ ] **Step 2: Implement `heimdall approve <KEY>`**

```ts
// src/cli/approve.ts
import { existsSync } from "fs";
import { join } from "path";
import { HEIMDALL_DIR, resolveHomePath, loadConfig } from "../config";
import { QueueManager } from "../queue";
import type { QueueItem, TriageReport, JiraSourceConfig } from "../types";

export async function approve(): Promise<void> {
  const issueKey = process.argv[3];
  if (!issueKey) {
    console.error("Usage: heimdall approve <ISSUE-KEY>");
    process.exit(1);
  }

  const heimdallDir = resolveHomePath(HEIMDALL_DIR);
  const reportJsonPath = join(heimdallDir, "triage", `${issueKey}.json`);
  if (!existsSync(reportJsonPath)) {
    console.error(`No triage report found for ${issueKey}. Run the watcher first.`);
    process.exit(1);
  }

  const report: TriageReport = await Bun.file(reportJsonPath).json();
  const config = await loadConfig();

  // Find the Jira source config that has this project
  const project = report.issue.project;
  let repo = "";
  let cwd = "";
  for (const source of config.sources) {
    if (source.type === "jira") {
      const jiraConfig = source as JiraSourceConfig;
      if (jiraConfig.projects[project]) {
        repo = jiraConfig.projects[project].repo;
        cwd = jiraConfig.projects[project].cwd;
        break;
      }
    }
  }

  if (!repo || !cwd) {
    console.error(`No project mapping found for ${project}. Check config.json sources.`);
    process.exit(1);
  }

  const queueDir = join(heimdallDir, "queue");
  const queue = new QueueManager(queueDir);

  // Check if already queued
  const existing = await queue.get(issueKey);
  if (existing) {
    console.log(`${issueKey} is already in the queue (status: ${existing.status})`);
    return;
  }

  const item: QueueItem = {
    issueKey,
    title: report.issue.title,
    description: report.issue.description,
    approvedAt: new Date().toISOString(),
    status: "pending",
    triageReport: join(heimdallDir, "triage", `${issueKey}.md`),
    repo,
    cwd: resolveHomePath(cwd),
  };

  await queue.enqueue(item);
  console.log(`${issueKey} queued for implementation.`);
}
```

- [ ] **Step 3: Wire new commands into `src/index.ts`**

Add these cases to the switch statement in `src/index.ts`:

```ts
case "triage": {
  const { triage } = await import("./cli/triage");
  await triage();
  break;
}
case "approve": {
  const { approve } = await import("./cli/approve");
  await approve();
  break;
}
```

Update the help text to include the new commands:

```
  triage <KEY>   View triage report and approve
  approve <KEY>  Queue issue for implementation
```

- [ ] **Step 4: Run full test suite to verify no regressions**

Run: `bun test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/cli/triage.ts src/cli/approve.ts src/index.ts
git commit -m "feat: add triage and approve CLI commands"
```

---

### Task 8: Worker Engine

**Files:**
- Create: `src/worker.ts`
- Test: `test/worker.test.ts`

This is the largest component. It handles: picking queue items, creating worktrees, spawning Claude, parsing stream-json output, pushing branches, creating draft PRs, sending notifications, and cleanup.

- [ ] **Step 1: Write failing tests for cost calculation and stream-json parsing**

```ts
// test/worker.test.ts
import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { calculateCost, parseStreamJson, formatDuration, buildImplementationPrompt } from "../src/worker";
import { mkdirSync, rmSync } from "fs";
import type { QueueItem, CostConfig, TriageReport } from "../src/types";

const testCosts: CostConfig = {
  "claude-opus-4-6": { inputPer1k: 0.015, outputPer1k: 0.075 },
  "claude-sonnet-4-6": { inputPer1k: 0.003, outputPer1k: 0.015 },
};

describe("calculateCost", () => {
  it("calculates cost from token counts", () => {
    const cost = calculateCost(82000, 12000, testCosts, "claude-opus-4-6");
    // (82000/1000 * 0.015) + (12000/1000 * 0.075) = 1.23 + 0.9 = 2.13
    expect(cost).toBeCloseTo(2.13, 2);
  });

  it("returns 0 for unknown model", () => {
    expect(calculateCost(1000, 1000, testCosts, "unknown-model")).toBe(0);
  });
});

describe("parseStreamJson", () => {
  it("extracts token usage from stream-json lines", () => {
    const lines = [
      '{"type":"system","subtype":"init"}',
      '{"type":"assistant","message":{"content":"hello"},"usage":{"input_tokens":100,"output_tokens":50}}',
      '{"type":"result","result":"done","total_cost_usd":0.05,"usage":{"input_tokens":200,"output_tokens":80}}',
    ].join("\n");

    const parsed = parseStreamJson(lines);
    expect(parsed.inputTokens).toBe(200);
    expect(parsed.outputTokens).toBe(80);
  });

  it("handles empty input", () => {
    const parsed = parseStreamJson("");
    expect(parsed.inputTokens).toBe(0);
    expect(parsed.outputTokens).toBe(0);
  });
});

describe("formatDuration", () => {
  it("formats seconds to m:ss", () => {
    expect(formatDuration(514)).toBe("8m 34s");
  });

  it("formats < 60s", () => {
    expect(formatDuration(45)).toBe("0m 45s");
  });
});

describe("buildImplementationPrompt", () => {
  it("includes issue key and title", () => {
    const item: QueueItem = {
      issueKey: "PROJ-123",
      title: "Auth refactor",
      description: "Refactor auth to use JWT",
      approvedAt: "",
      status: "pending",
      triageReport: "/path/to/report.md",
      repo: "org/repo",
      cwd: "/path/to/repo",
    };
    const triageContent = "# Triage: PROJ-123\nScore: 7/9";
    const prompt = buildImplementationPrompt(item, triageContent, "/worktrees/PROJ-123");
    expect(prompt).toContain("PROJ-123");
    expect(prompt).toContain("Auth refactor");
    expect(prompt).toContain("Refactor auth to use JWT");
    expect(prompt).toContain("/worktrees/PROJ-123");
    expect(prompt).toContain("Score: 7/9");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/worker.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement worker utility functions**

```ts
// src/worker.ts
import { existsSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import type {
  QueueItem,
  CostConfig,
  WorkerConfig,
  ImplementationSummary,
  TriageReport,
  HeimdallConfig,
} from "./types";
import type { Logger } from "./logger";
import { QueueManager } from "./queue";
import { NotifyAction } from "./actions/notify";
import { HEIMDALL_DIR, resolveHomePath } from "./config";

export function calculateCost(
  inputTokens: number,
  outputTokens: number,
  costs: CostConfig,
  model: string
): number {
  const pricing = costs[model];
  if (!pricing) return 0;
  return (inputTokens / 1000) * pricing.inputPer1k + (outputTokens / 1000) * pricing.outputPer1k;
}

export interface StreamJsonResult {
  inputTokens: number;
  outputTokens: number;
  cacheTokens: number;
  result: string;
  costUsd: number;
}

export function parseStreamJson(output: string): StreamJsonResult {
  const result: StreamJsonResult = {
    inputTokens: 0,
    outputTokens: 0,
    cacheTokens: 0,
    result: "",
    costUsd: 0,
  };

  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      if (obj.usage) {
        result.inputTokens = obj.usage.input_tokens || result.inputTokens;
        result.outputTokens = obj.usage.output_tokens || result.outputTokens;
        result.cacheTokens = obj.usage.cache_read_input_tokens || result.cacheTokens;
      }
      if (obj.total_cost_usd) {
        result.costUsd = obj.total_cost_usd;
      }
      if (obj.result) {
        result.result = obj.result;
      }
    } catch {
      // skip non-JSON lines
    }
  }

  return result;
}

export function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}m ${s}s`;
}

export function buildImplementationPrompt(
  item: QueueItem,
  triageContent: string,
  worktreePath: string
): string {
  return `You are implementing Jira issue ${item.issueKey}: ${item.title}

## Issue Description
${item.description}

## Triage Analysis
${triageContent}

## Instructions
- Working directory: ${worktreePath}
- Use the brainstorming skill if the approach isn't obvious
- Use the writing-plans skill to create a plan before coding
- Run tests after implementation
- Commit your changes with a descriptive message referencing ${item.issueKey}
- If you get stuck or tests won't pass after 3 attempts, commit what you have and stop`;
}

export function buildPrBody(
  item: QueueItem,
  summary: ImplementationSummary,
  triageContent: string,
  jiraBaseUrl?: string
): string {
  const jiraLink = jiraBaseUrl
    ? `[${item.issueKey}](${jiraBaseUrl}/browse/${item.issueKey})`
    : item.issueKey;
  const statusIcon = summary.status === "complete" ? "\u2705" : "\u26a0\ufe0f";
  const statusText =
    summary.status === "complete"
      ? "Complete"
      : `Incomplete \u2014 ${summary.error || "unknown error"}`;

  return `## Summary
${summary.title}

## Heimdall Report
| Metric | Value |
|--------|-------|
| Jira Issue | ${jiraLink} |
| Confidence | ${summary.triageScore}/9 |
| Size | ${summary.size} |
| Time | Triage: ${formatDuration(summary.timings.triageSeconds)} \u2014 Implementation: ${formatDuration(summary.timings.implementationSeconds)} |
| Cost | ~$${summary.cost.totalUsd.toFixed(2)} (input: ${(summary.cost.inputTokens / 1000).toFixed(0)}k, output: ${(summary.cost.outputTokens / 1000).toFixed(0)}k, cache: ${(summary.cost.cacheTokens / 1000).toFixed(0)}k) |
| Model | ${summary.model} |
| Tests | ${summary.tests.passing} passing, ${summary.tests.failing} failing |
| Files changed | ${summary.filesChanged} |

## Status
${statusIcon} ${statusText}

## Triage Analysis
${triageContent}

---
Generated by Heimdall \u2014 The All-Seeing PR Guardian`;
}

export class Worker {
  private readonly worktreeDir: string;

  constructor(
    private readonly queue: QueueManager,
    private readonly config: HeimdallConfig,
    private readonly notifier: NotifyAction,
    private readonly logger: Logger
  ) {
    this.worktreeDir = resolveHomePath(config.worker.worktreeDir);
    mkdirSync(this.worktreeDir, { recursive: true });
  }

  async processNext(): Promise<boolean> {
    const item = await this.queue.pickNext();
    if (!item) {
      this.logger.info("No pending items in queue");
      return false;
    }

    this.logger.info(`Processing ${item.issueKey}: ${item.title}`);
    await this.queue.update(item.issueKey, { status: "in_progress" });

    const worktreePath = join(this.worktreeDir, item.issueKey);
    const branch = `heimdall/${item.issueKey}`;

    try {
      // 1. Create worktree
      await this.createWorktree(item.cwd, worktreePath, branch);
      await this.queue.update(item.issueKey, { branch });

      // 2. Read triage report
      let triageContent = "";
      if (existsSync(item.triageReport)) {
        triageContent = await Bun.file(item.triageReport).text();
      }

      // 3. Spawn Claude
      const implStart = Date.now();
      const prompt = buildImplementationPrompt(item, triageContent, worktreePath);
      const claudeResult = await this.spawnClaude(prompt, worktreePath);
      const implSeconds = (Date.now() - implStart) / 1000;

      // 4. Parse results
      const streamResult = parseStreamJson(claudeResult.stdout);
      const model = `claude-${this.config.worker.model}-4-6`;
      const cost = calculateCost(
        streamResult.inputTokens,
        streamResult.outputTokens,
        this.config.costs,
        model
      );

      // 5. Count changed files
      const filesChanged = await this.countChangedFiles(worktreePath);

      // 6. Push branch and create PR
      await this.pushBranch(worktreePath, branch);
      const isComplete = claudeResult.exitCode === 0;

      const summary: ImplementationSummary = {
        issueKey: item.issueKey,
        title: item.title,
        triageScore: 0, // populated from triage report below
        size: "M",
        timings: { triageSeconds: 0, implementationSeconds: implSeconds },
        cost: {
          inputTokens: streamResult.inputTokens,
          outputTokens: streamResult.outputTokens,
          cacheTokens: streamResult.cacheTokens,
          totalUsd: streamResult.costUsd || cost,
        },
        model,
        tests: { passing: 0, failing: 0 },
        filesChanged,
        prUrl: "",
        status: isComplete ? "complete" : "incomplete",
        error: isComplete ? undefined : `Exit code ${claudeResult.exitCode}`,
      };

      // Populate from triage report JSON if available
      const triageJsonPath = item.triageReport.replace(".md", ".json");
      if (existsSync(triageJsonPath)) {
        const triageReport: TriageReport = await Bun.file(triageJsonPath).json();
        summary.triageScore = triageReport.result.total;
        summary.size = triageReport.result.size;
      }

      // Find Jira baseUrl from config for PR body link
      const jiraSource = this.config.sources.find((s) => s.type === "jira") as
        | import("./types").JiraSourceConfig
        | undefined;
      const prBody = buildPrBody(item, summary, triageContent, jiraSource?.baseUrl);
      const prTitle = `[Heimdall] ${item.issueKey}: ${item.title}`;
      const prUrl = await this.createDraftPr(item.cwd, branch, prTitle, prBody);
      summary.prUrl = prUrl;

      // 7. Save run artifacts
      await this.saveRunArtifacts(item.issueKey, summary, triageContent, claudeResult.stdout);

      // 8. Update queue and notify
      await this.queue.update(item.issueKey, {
        status: isComplete ? "completed" : "failed",
        prUrl,
      });

      if (isComplete) {
        await this.notifier.notifyWorkerComplete(
          item.issueKey,
          prUrl,
          summary.triageScore,
          `$${summary.cost.totalUsd.toFixed(2)}`,
          formatDuration(implSeconds)
        );
      } else {
        await this.notifier.notifyWorkerFailed(
          item.issueKey,
          `Partial PR opened — ${summary.error}`
        );
      }

      // 9. Cleanup worktree (on success only)
      if (isComplete) {
        await this.removeWorktree(item.cwd, worktreePath);
      } else {
        this.logger.warn(`Preserving worktree for failed item: ${worktreePath}`);
      }

      this.logger.info(`${item.issueKey} ${isComplete ? "completed" : "failed"}: ${prUrl}`);
      return true;
    } catch (err) {
      this.logger.error(`Worker error for ${item.issueKey}: ${err}`);
      await this.queue.update(item.issueKey, {
        status: "failed",
        error: String(err),
      });
      await this.notifier.notifyWorkerFailed(item.issueKey, String(err));
      return true; // true = processed (even if failed), so worker continues
    }
  }

  private async createWorktree(
    repoCwd: string,
    worktreePath: string,
    branch: string
  ): Promise<void> {
    this.logger.info(`Creating worktree: ${worktreePath} (branch: ${branch})`);
    const proc = Bun.spawn(
      ["git", "worktree", "add", worktreePath, "-b", branch],
      { cwd: repoCwd, stdout: "pipe", stderr: "pipe" }
    );
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      throw new Error(`git worktree add failed: ${stderr}`);
    }
  }

  private async spawnClaude(
    prompt: string,
    cwd: string
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const args = [
      "claude",
      "-p",
      prompt,
      ...this.config.worker.claudeArgs,
      "--model",
      this.config.worker.model,
      "--max-turns",
      String(this.config.worker.maxTurns),
    ];

    this.logger.info(`Spawning Claude in ${cwd}`);
    const proc = Bun.spawn(args, {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, TERM: "dumb" },
    });

    const exitCode = await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();

    return { stdout, stderr, exitCode };
  }

  private async countChangedFiles(worktreePath: string): Promise<number> {
    // Use diff against the branch point (main) rather than HEAD~1
    // This handles both single-commit and multi-commit branches
    const proc = Bun.spawn(
      ["git", "diff", "--name-only", "main...HEAD"],
      { cwd: worktreePath, stdout: "pipe", stderr: "pipe" }
    );
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      // Fallback: count all tracked files changed from parent
      const fallback = Bun.spawn(
        ["git", "diff", "--name-only", "--cached"],
        { cwd: worktreePath, stdout: "pipe", stderr: "pipe" }
      );
      await fallback.exited;
      const out = await new Response(fallback.stdout).text();
      return out.trim().split("\n").filter(Boolean).length;
    }
    const stdout = await new Response(proc.stdout).text();
    return stdout.trim().split("\n").filter(Boolean).length;
  }

  private async pushBranch(worktreePath: string, branch: string): Promise<void> {
    this.logger.info(`Pushing branch: ${branch}`);
    const proc = Bun.spawn(
      ["git", "push", "-u", "origin", branch],
      { cwd: worktreePath, stdout: "pipe", stderr: "pipe" }
    );
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      throw new Error(`git push failed: ${stderr}`);
    }
  }

  private async createDraftPr(
    repoCwd: string,
    branch: string,
    title: string,
    body: string
  ): Promise<string> {
    this.logger.info(`Creating draft PR for ${branch}`);
    const proc = Bun.spawn(
      ["gh", "pr", "create", "--draft", "--title", title, "--body", body, "--head", branch],
      { cwd: repoCwd, stdout: "pipe", stderr: "pipe" }
    );
    const exitCode = await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      throw new Error(`gh pr create failed: ${stderr}`);
    }
    return stdout.trim(); // returns PR URL
  }

  private async saveRunArtifacts(
    issueKey: string,
    summary: ImplementationSummary,
    triageContent: string,
    implementationLog: string
  ): Promise<void> {
    const runsDir = join(resolveHomePath(HEIMDALL_DIR), "runs", issueKey);
    mkdirSync(runsDir, { recursive: true });
    await Bun.write(join(runsDir, "summary.json"), JSON.stringify(summary, null, 2));
    await Bun.write(join(runsDir, "triage.md"), triageContent);
    await Bun.write(join(runsDir, "implementation.log"), implementationLog);
  }

  private async removeWorktree(repoCwd: string, worktreePath: string): Promise<void> {
    this.logger.info(`Removing worktree: ${worktreePath}`);
    const proc = Bun.spawn(
      ["git", "worktree", "remove", worktreePath, "--force"],
      { cwd: repoCwd, stdout: "pipe", stderr: "pipe" }
    );
    await proc.exited;
  }
}
```

- [ ] **Step 4: Run tests to verify utility function tests pass**

Run: `bun test test/worker.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/worker.ts test/worker.test.ts
git commit -m "feat: add Worker engine with worktree lifecycle and PR creation"
```

---

### Task 9: CLI Commands — Worker, Queue, Clean & Watcher Integration

**Files:**
- Create: `src/cli/worker-cmd.ts`
- Create: `src/cli/queue-cmd.ts`
- Create: `src/cli/clean.ts`
- Modify: `src/cli/run.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Implement `heimdall worker` command**

```ts
// src/cli/worker-cmd.ts
import { loadConfig, resolveHomePath, HEIMDALL_DIR } from "../config";
import { createLogger } from "../logger";
import { QueueManager } from "../queue";
import { NotifyAction } from "../actions/notify";
import { Worker } from "../worker";

export async function workerCmd(): Promise<void> {
  const config = await loadConfig();
  const logger = createLogger({
    file: resolveHomePath(config.log.file),
    level: config.log.level,
  });

  logger.info("Heimdall worker started");

  const queue = new QueueManager(resolveHomePath(`${HEIMDALL_DIR}/queue`));
  const notifier = new NotifyAction(config.actions.notify.sound, logger);
  const worker = new Worker(queue, config, notifier, logger);

  // Count currently in-progress items
  const items = await queue.list();
  const inProgress = items.filter((i) => i.status === "in_progress").length;
  if (inProgress >= config.worker.maxParallel) {
    console.log(`Max parallel workers reached (${inProgress}/${config.worker.maxParallel}). Exiting.`);
    return;
  }

  const processed = await worker.processNext();
  if (!processed) {
    console.log("No pending items in queue.");
  }
}
```

- [ ] **Step 2: Implement `heimdall queue` command**

```ts
// src/cli/queue-cmd.ts
import { resolveHomePath, HEIMDALL_DIR } from "../config";
import { QueueManager } from "../queue";

const STATUS_ICONS: Record<string, string> = {
  pending: "\u23f3",
  in_progress: "\u26a1",
  completed: "\u2705",
  failed: "\u274c",
};

export async function queueCmd(): Promise<void> {
  const queue = new QueueManager(resolveHomePath(`${HEIMDALL_DIR}/queue`));
  const items = await queue.list();

  if (items.length === 0) {
    console.log("Queue is empty.");
    return;
  }

  console.log(`\nHeimdall Queue (${items.length} item(s)):\n`);
  console.log("  Status  | Issue         | Title                          | Approved");
  console.log("  --------+---------------+--------------------------------+---------");
  for (const item of items) {
    const icon = STATUS_ICONS[item.status] || "?";
    const key = item.issueKey.padEnd(13);
    const title = item.title.length > 30 ? item.title.slice(0, 27) + "..." : item.title.padEnd(30);
    const date = item.approvedAt.slice(0, 16).replace("T", " ");
    console.log(`  ${icon} ${item.status.padEnd(6)} | ${key} | ${title} | ${date}`);
    if (item.prUrl) console.log(`           PR: ${item.prUrl}`);
    if (item.error) console.log(`           Error: ${item.error}`);
  }
  console.log();
}
```

- [ ] **Step 3: Implement `heimdall clean` command**

```ts
// src/cli/clean.ts
import { existsSync, readdirSync, rmSync } from "fs";
import { join } from "path";
import { resolveHomePath, HEIMDALL_DIR } from "../config";
import { QueueManager } from "../queue";

export async function clean(): Promise<void> {
  const heimdallDir = resolveHomePath(HEIMDALL_DIR);
  const worktreeDir = join(heimdallDir, "worktrees");

  if (!existsSync(worktreeDir)) {
    console.log("No worktrees directory found.");
    return;
  }

  const entries = readdirSync(worktreeDir);
  if (entries.length === 0) {
    console.log("No worktrees to clean.");
    return;
  }

  const queue = new QueueManager(join(heimdallDir, "queue"));
  let cleaned = 0;

  for (const entry of entries) {
    const worktreePath = join(worktreeDir, entry);
    const queueItem = await queue.get(entry);

    // Only clean completed worktrees, or worktrees with no queue entry
    if (!queueItem || queueItem.status === "completed") {
      // Try to remove the git worktree reference first
      const proc = Bun.spawn(
        ["git", "worktree", "remove", worktreePath, "--force"],
        { stdout: "pipe", stderr: "pipe" }
      );
      await proc.exited;

      // If git worktree remove didn't clean it, force remove directory
      if (existsSync(worktreePath)) {
        rmSync(worktreePath, { recursive: true, force: true });
      }

      // Remove completed queue items
      if (queueItem?.status === "completed") {
        await queue.remove(entry);
      }

      console.log(`Cleaned: ${entry}`);
      cleaned++;
    } else {
      console.log(`Skipped: ${entry} (status: ${queueItem.status})`);
    }
  }

  console.log(`\nCleaned ${cleaned} worktree(s).`);
}
```

- [ ] **Step 4: Wire Jira sources into `src/cli/run.ts`**

Add Jira cycle handling after the existing GitHub cycle. Add these imports at the top of `run.ts`:

```ts
import { JiraSource } from "../sources/jira";
import { TriageAction } from "../actions/triage";
import { runJiraCycle } from "../jira-cycle";
import type { JiraSourceConfig } from "../types";
```

Add after the existing `await runCycle(source, actions, state, config, logger)` call:

```ts
// Handle Jira sources
for (const srcConfig of config.sources) {
  if (srcConfig.type === "jira") {
    const jiraConfig = srcConfig as JiraSourceConfig;
    const jiraSource = new JiraSource(jiraConfig, logger);
    const triageAction = new TriageAction(config.triage, logger);
    const notifyAction = actions.find((a) => a.name === "notify") as NotifyAction | undefined;

    await runJiraCycle({
      poll: () => jiraSource.poll(),
      triage: (issue) => triageAction.triage(issue),
      notify: async (issue, report) => {
        if (!notifyAction) return;
        if (report.verdict === "ready") {
          await notifyAction.notifyTriage(issue, report);
        } else if (report.verdict === "needs_detail") {
          await notifyAction.notifyNeedsDetail(issue, report);
        } else {
          await notifyAction.notifyTooBig(issue, report);
        }
      },
      state,
      namespace: `jira:${jiraConfig.baseUrl}`,
      logger,
    });
  }
}
```

Also update the GitHub source instantiation to handle the discriminated union properly. Replace the existing source instantiation block:

```ts
// Handle GitHub sources
const githubSources = config.sources.filter((s) => s.type === "github");
for (const srcConfig of githubSources) {
  if (srcConfig.type !== "github") continue;
  if (srcConfig.repos.length === 0) {
    logger.warn("No repos configured for GitHub source. Skipping.");
    continue;
  }
  const source = new GitHubSource(srcConfig.repos, srcConfig.trigger, logger);
  await runCycle(source, actions, state, config, logger);
}
```

- [ ] **Step 5: Wire all new commands into `src/index.ts`**

Add these cases to the switch:

```ts
case "worker": {
  const { workerCmd } = await import("./cli/worker-cmd");
  await workerCmd();
  break;
}
case "queue": {
  const { queueCmd } = await import("./cli/queue-cmd");
  await queueCmd();
  break;
}
case "clean": {
  const { clean } = await import("./cli/clean");
  await clean();
  break;
}
```

Update the help text:

```
Heimdall — The All-Seeing PR Guardian

Usage: heimdall <command>

Commands:
  run              Execute a single poll cycle (GitHub + Jira)
  start            Start the daemon (launchd)
  stop             Stop the daemon
  status           Show running state and recent reviews
  logs             Tail the log file
  install          Generate and load launchd plist
  reinstall        Stop, rebuild, and reload daemon
  uninstall        Remove launchd plist

Jira Autonomous Implementation:
  triage <KEY>     View triage report and approve
  approve <KEY>    Queue issue for implementation
  worker           Start worker (picks up queue items)
  queue            List queue items with status
  clean            Remove completed/old worktrees
```

- [ ] **Step 6: Run full test suite**

Run: `bun test`
Expected: PASS — all tests pass

- [ ] **Step 7: Commit**

```bash
git add src/cli/worker-cmd.ts src/cli/queue-cmd.ts src/cli/clean.ts src/cli/run.ts src/index.ts
git commit -m "feat: add worker/queue/clean CLI commands and wire Jira into run cycle"
```

---

## Verification Checklist

After all tasks are complete, verify:

- [ ] `bun test` — all tests pass
- [ ] `bun run src/index.ts` — shows updated help with all commands
- [ ] `bun run src/index.ts triage` — shows usage error (no key)
- [ ] `bun run src/index.ts queue` — shows "Queue is empty"
- [ ] `bun run src/index.ts clean` — shows "No worktrees to clean"
- [ ] Config loads with Jira source section without errors
- [ ] No TypeScript errors: `bunx tsc --noEmit`
