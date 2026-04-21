# Local UI Action Center Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade Heimdall's read-only HTTP server into a lightweight action center with dashboard, queue page, triage approve button, worker start button, and heartbeat-based status detection.

**Architecture:** Server-rendered HTML using the existing `pageShell()` + `marked` pattern. Two new POST endpoints handle approve and worker-start as form submissions with 303 redirects. Worker writes PID + heartbeat files; the server reads them for status display. Approval logic extracted from CLI into a shared function.

**Tech Stack:** Bun, server-rendered HTML, existing GitHub dark theme, file-based state in `~/.heimdall/`

**Spec:** `docs/superpowers/specs/2026-04-21-local-ui-action-center-design.md`

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `src/approve.ts` | Create | Shared `approveIssue()` function used by CLI and server |
| `src/approve.test.ts` | Create | Tests for `approveIssue()` |
| `src/cli/approve.ts` | Modify | Refactor to call `approveIssue()` |
| `src/heartbeat.ts` | Create | Worker heartbeat write + status detection logic |
| `src/heartbeat.test.ts` | Create | Tests for heartbeat status detection |
| `src/worker.ts` | Modify | Add heartbeat start/stop to Worker class |
| `src/server.ts` | Modify | Add nav bar, dashboard, queue page, POST endpoints, sticky bottom bar |
| `src/server.test.ts` | Modify | Add tests for new routes |
| `src/actions/notify.ts` | Modify | Remove dead `-actions`/`-execute` flags |

---

### Task 1: Extract shared approve logic

**Files:**
- Create: `src/approve.ts`
- Create: `src/approve.test.ts`
- Modify: `src/cli/approve.ts`

- [ ] **Step 1: Write the test file for `approveIssue()`**

```ts
// src/approve.test.ts
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { approveIssue } from "./approve";

const TEST_DIR = "/tmp/heimdall-approve-test";
const TRIAGE_DIR = join(TEST_DIR, "triage");
const QUEUE_DIR = join(TEST_DIR, "queue");
const CONFIG_PATH = join(TEST_DIR, "config.json");

const VALID_REPORT = {
  issue: { key: "TEST-1", title: "Test issue", description: "desc", url: "", project: "TEST", assignee: "", status: "", issueType: "", referenceUrls: [] },
  result: { criteria: { acceptance_clarity: 3, scope_boundedness: 2, technical_detail: 2 }, total: 7, max: 9, size: "M", verdict: "ready", concerns: "", suggested_files: ["src/foo.ts"], feasibility: null, confidence: "high", confidence_reasoning: null },
  verdict: "ready",
  confidence: "high",
  timestamp: "2026-04-21T00:00:00.000Z",
};

const TEST_CONFIG = {
  sources: [{ type: "jira", baseUrl: "https://jira.example.com", email: "a@b.com", apiToken: "tok", jql: "", projects: { TEST: { repo: "org/repo", cwd: "/tmp/repo" } } }],
};

beforeEach(() => {
  mkdirSync(TRIAGE_DIR, { recursive: true });
  mkdirSync(QUEUE_DIR, { recursive: true });
  writeFileSync(join(TRIAGE_DIR, "TEST-1.json"), JSON.stringify(VALID_REPORT));
  writeFileSync(CONFIG_PATH, JSON.stringify(TEST_CONFIG));
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

test("approves a ready issue", async () => {
  const result = await approveIssue("TEST-1", { heimdallDir: TEST_DIR, configPath: CONFIG_PATH });
  expect(result).toEqual({ ok: true });
  const queued = await Bun.file(join(QUEUE_DIR, "TEST-1.json")).json();
  expect(queued.issueKey).toBe("TEST-1");
  expect(queued.status).toBe("pending");
});

test("rejects when no triage report exists", async () => {
  const result = await approveIssue("MISSING-1", { heimdallDir: TEST_DIR, configPath: CONFIG_PATH });
  expect(result).toEqual({ ok: false, error: "no-report" });
});

test("rejects when verdict is not ready", async () => {
  const notReady = { ...VALID_REPORT, verdict: "needs_detail" };
  writeFileSync(join(TRIAGE_DIR, "TEST-2.json"), JSON.stringify(notReady));
  const result = await approveIssue("TEST-2", { heimdallDir: TEST_DIR, configPath: CONFIG_PATH });
  expect(result).toEqual({ ok: false, error: "not-ready" });
});

test("returns ok when already queued (idempotent)", async () => {
  await approveIssue("TEST-1", { heimdallDir: TEST_DIR, configPath: CONFIG_PATH });
  const result = await approveIssue("TEST-1", { heimdallDir: TEST_DIR, configPath: CONFIG_PATH });
  expect(result).toEqual({ ok: true, alreadyQueued: true });
});

test("rejects when no project config found", async () => {
  const noProject = { ...VALID_REPORT, issue: { ...VALID_REPORT.issue, project: "UNKNOWN" } };
  writeFileSync(join(TRIAGE_DIR, "UNK-1.json"), JSON.stringify(noProject));
  const result = await approveIssue("UNK-1", { heimdallDir: TEST_DIR, configPath: CONFIG_PATH });
  expect(result).toEqual({ ok: false, error: "no-config" });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/approve.test.ts`
Expected: FAIL — `approveIssue` not found

- [ ] **Step 3: Implement `approveIssue()`**

```ts
// src/approve.ts
import { existsSync } from "fs";
import { join } from "path";
import { HEIMDALL_DIR, loadConfig, resolveHomePath } from "./config";
import { QueueManager } from "./queue";
import type { QueueItem, TriageReport, JiraSourceConfig, JiraProjectConfig } from "./types";

interface ApproveOptions {
  heimdallDir?: string;
  configPath?: string;
}

type ApproveResult =
  | { ok: true; alreadyQueued?: boolean }
  | { ok: false; error: "no-report" | "not-ready" | "no-config" };

export async function approveIssue(
  issueKey: string,
  opts?: ApproveOptions
): Promise<ApproveResult> {
  const heimdallDir = opts?.heimdallDir ?? resolveHomePath(HEIMDALL_DIR);
  const reportJsonPath = join(heimdallDir, "triage", `${issueKey}.json`);

  if (!existsSync(reportJsonPath)) {
    return { ok: false, error: "no-report" };
  }

  const report: TriageReport = await Bun.file(reportJsonPath).json();

  if (report.verdict !== "ready") {
    return { ok: false, error: "not-ready" };
  }

  const config = await loadConfig(opts?.configPath);
  const project = report.issue.project;
  let projectConfig: JiraProjectConfig | undefined;

  for (const source of config.sources) {
    if (source.type === "jira") {
      const jiraConfig = source as JiraSourceConfig;
      if (jiraConfig.projects[project]) {
        projectConfig = jiraConfig.projects[project];
        break;
      }
    }
  }

  if (!projectConfig) {
    return { ok: false, error: "no-config" };
  }

  const queueDir = join(heimdallDir, "queue");
  const queue = new QueueManager(queueDir);

  const existing = await queue.get(issueKey);
  if (existing) {
    return { ok: true, alreadyQueued: true };
  }

  const item: QueueItem = {
    issueKey,
    title: report.issue.title,
    description: report.issue.description,
    approvedAt: new Date().toISOString(),
    status: "pending",
    triageReport: join(heimdallDir, "triage", `${issueKey}.md`),
    repo: projectConfig.repo,
    cwd: resolveHomePath(projectConfig.cwd),
    systemPromptFile: projectConfig.systemPromptFile,
    allowedTools: projectConfig.allowedTools,
  };

  await queue.enqueue(item);
  return { ok: true };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/approve.test.ts`
Expected: All 5 tests PASS

- [ ] **Step 5: Refactor CLI approve to use shared function**

Replace `src/cli/approve.ts` with:

```ts
// src/cli/approve.ts
import { approveIssue } from "../approve";

export async function approve(): Promise<void> {
  const issueKey = process.argv[3];
  if (!issueKey) {
    console.error("Usage: heimdall approve <ISSUE-KEY>");
    process.exit(1);
  }

  const result = await approveIssue(issueKey);

  if (!result.ok) {
    const messages: Record<string, string> = {
      "no-report": `No triage report found for ${issueKey}. Run the watcher first.`,
      "not-ready": `${issueKey} verdict is not "ready". Cannot approve.`,
      "no-config": `No project mapping found for ${issueKey}. Check config.json sources.`,
    };
    console.error(messages[result.error]);
    process.exit(1);
  }

  if (result.alreadyQueued) {
    console.log(`${issueKey} is already in the queue.`);
    return;
  }

  console.log(`${issueKey} queued for implementation.`);
}
```

- [ ] **Step 6: Run all tests to verify nothing broke**

Run: `bun test`
Expected: All tests PASS

- [ ] **Step 7: Commit**

```bash
git add src/approve.ts src/approve.test.ts src/cli/approve.ts
git commit -m "refactor: extract approveIssue() into shared module"
```

---

### Task 2: Worker heartbeat

**Files:**
- Create: `src/heartbeat.ts`
- Create: `src/heartbeat.test.ts`
- Modify: `src/worker.ts`

- [ ] **Step 1: Write the test file for heartbeat status detection**

```ts
// src/heartbeat.test.ts
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { getWorkerStatus } from "./heartbeat";

const TEST_DIR = "/tmp/heimdall-heartbeat-test";

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

test("returns idle when no PID file", () => {
  const status = getWorkerStatus(TEST_DIR);
  expect(status.state).toBe("idle");
});

test("returns dead when PID file exists but no heartbeat", () => {
  writeFileSync(join(TEST_DIR, "worker.pid"), "12345");
  const status = getWorkerStatus(TEST_DIR);
  expect(status.state).toBe("dead");
});

test("returns dead when heartbeat is stale (>60s)", () => {
  writeFileSync(join(TEST_DIR, "worker.pid"), "12345");
  const staleTime = new Date(Date.now() - 120_000).toISOString();
  writeFileSync(join(TEST_DIR, "worker.heartbeat"), staleTime);
  const status = getWorkerStatus(TEST_DIR);
  expect(status.state).toBe("dead");
});

test("returns active when heartbeat is fresh", () => {
  writeFileSync(join(TEST_DIR, "worker.pid"), "12345");
  writeFileSync(join(TEST_DIR, "worker.heartbeat"), new Date().toISOString());
  const status = getWorkerStatus(TEST_DIR);
  expect(status.state).toBe("active");
  expect(status.pid).toBe(12345);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/heartbeat.test.ts`
Expected: FAIL — `getWorkerStatus` not found

- [ ] **Step 3: Implement heartbeat module**

```ts
// src/heartbeat.ts
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "fs";
import { join } from "path";

export interface WorkerStatus {
  state: "active" | "idle" | "dead";
  pid?: number;
}

const STALE_THRESHOLD_MS = 60_000;

export function getWorkerStatus(heimdallDir: string): WorkerStatus {
  const pidPath = join(heimdallDir, "worker.pid");
  const heartbeatPath = join(heimdallDir, "worker.heartbeat");

  if (!existsSync(pidPath)) return { state: "idle" };

  const pid = parseInt(readFileSync(pidPath, "utf-8").trim(), 10);

  if (!existsSync(heartbeatPath)) return { state: "dead", pid };

  const heartbeat = readFileSync(heartbeatPath, "utf-8").trim();
  const age = Date.now() - new Date(heartbeat).getTime();

  if (age > STALE_THRESHOLD_MS) return { state: "dead", pid };
  return { state: "active", pid };
}

export function writeHeartbeat(heimdallDir: string): void {
  writeFileSync(join(heimdallDir, "worker.heartbeat"), new Date().toISOString());
}

export function writePid(heimdallDir: string): void {
  writeFileSync(join(heimdallDir, "worker.pid"), String(process.pid));
}

export function clearHeartbeatFiles(heimdallDir: string): void {
  const pidPath = join(heimdallDir, "worker.pid");
  const heartbeatPath = join(heimdallDir, "worker.heartbeat");
  if (existsSync(pidPath)) unlinkSync(pidPath);
  if (existsSync(heartbeatPath)) unlinkSync(heartbeatPath);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/heartbeat.test.ts`
Expected: All 4 tests PASS

- [ ] **Step 5: Add heartbeat to Worker class**

In `src/worker.ts`, add heartbeat lifecycle. Modify the `Worker` class:

Add import at top:
```ts
import { writePid, writeHeartbeat, clearHeartbeatFiles } from "./heartbeat";
```

Add a `private heartbeatInterval: Timer | null = null;` field and two methods:

```ts
startHeartbeat(): void {
  const heimdallDir = resolveHomePath(HEIMDALL_DIR);
  writePid(heimdallDir);
  writeHeartbeat(heimdallDir);
  this.heartbeatInterval = setInterval(() => writeHeartbeat(heimdallDir), 10_000);

  const cleanup = () => {
    if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
    clearHeartbeatFiles(heimdallDir);
  };
  process.on("exit", cleanup);
  process.on("SIGTERM", () => { cleanup(); process.exit(0); });
  process.on("SIGINT", () => { cleanup(); process.exit(0); });
}

stopHeartbeat(): void {
  if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
  clearHeartbeatFiles(resolveHomePath(HEIMDALL_DIR));
}
```

- [ ] **Step 6: Call heartbeat from worker-cmd**

In `src/cli/worker-cmd.ts`, add heartbeat start/stop around the worker processing:

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

  const items = await queue.list();
  const inProgress = items.filter((i) => i.status === "in_progress").length;
  if (inProgress >= config.worker.maxParallel) {
    console.log(`Max parallel workers reached (${inProgress}/${config.worker.maxParallel}). Exiting.`);
    return;
  }

  worker.startHeartbeat();
  try {
    const processed = await worker.processNext();
    if (!processed) {
      console.log("No pending items in queue.");
    }
  } finally {
    worker.stopHeartbeat();
  }
}
```

- [ ] **Step 7: Run all tests**

Run: `bun test`
Expected: All tests PASS

- [ ] **Step 8: Commit**

```bash
git add src/heartbeat.ts src/heartbeat.test.ts src/worker.ts src/cli/worker-cmd.ts
git commit -m "feat: add worker heartbeat for status detection"
```

---

### Task 3: Navigation bar and pageShell update

**Files:**
- Modify: `src/server.ts`

- [ ] **Step 1: Update `startServer` signature to accept `heimdallDir` override**

The server currently hardcodes `HEIMDALL_DIR` for `triageDir` and `queueDir`. To make tests work with temp directories, update the signature:

```ts
export function startServer(config: HeimdallConfig, logger: Logger, opts?: { configPath?: string; heimdallDir?: string }) {
  const reportsDir = resolveHomePath(config.reports.dir);
  const heimdallDir = opts?.heimdallDir ?? resolveHomePath(HEIMDALL_DIR);
  const triageDir = join(heimdallDir, "triage");
  const queueDir = join(heimdallDir, "queue");
```

Replace the existing `triageDir` declaration (`resolveHomePath(\`${HEIMDALL_DIR}/triage\`)`) with the one above.

- [ ] **Step 2: Update `pageShell()` to accept `activePage` and render nav bar**

In `src/server.ts`, replace the `pageShell` function:

```ts
function pageShell(title: string, body: string, activePage?: string): string {
  const navItems = [
    { label: "Dashboard", href: "/" },
    { label: "Reviews", href: "/reviews" },
    { label: "Triage", href: "/triage" },
    { label: "Queue", href: "/queue" },
  ];
  const nav = navItems
    .map((item) => {
      const isActive = item.label.toLowerCase() === activePage?.toLowerCase();
      return isActive
        ? `<a href="${item.href}" style="color:#58a6ff;font-weight:700;">${item.label}</a>`
        : `<a href="${item.href}" style="color:#8b949e;">${item.label}</a>`;
    })
    .join('<span style="color:#30363d;margin:0 8px;">|</span>');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} — Heimdall</title>
<style>
  *, *::before, *::after { box-sizing: border-box; }
  body {
    margin: 0; padding: 2rem;
    background: #0d1117; color: #e6edf3;
    font-family: "SF Mono", "Fira Code", "Cascadia Code", monospace;
    line-height: 1.6; font-size: 14px;
  }
  a { color: #58a6ff; text-decoration: none; }
  a:hover { text-decoration: underline; }
  article { max-width: 960px; margin: 0 auto; }
  h1, h2, h3, h4, h5, h6 { color: #f0f6fc; margin-top: 1.5em; margin-bottom: 0.5em; }
  h1 { border-bottom: 1px solid #30363d; padding-bottom: 0.3em; }
  table { width: 100%; border-collapse: collapse; margin: 1em 0; }
  th, td { padding: 8px 12px; border: 1px solid #30363d; text-align: left; }
  th { background: #161b22; }
  tr:hover { background: #161b22; }
  pre { background: #161b22; padding: 1em; border-radius: 6px; overflow-x: auto; }
  code { font-family: "SF Mono", "Fira Code", monospace; font-size: 0.9em; }
  :not(pre) > code { background: #161b22; padding: 2px 6px; border-radius: 4px; }
  hr { border: none; border-top: 1px solid #30363d; margin: 1.5em 0; }
  .back { margin-bottom: 1em; }
  ul { padding-left: 1.5em; }
  li { margin: 0.25em 0; }
  input[type="checkbox"] { margin-right: 0.5em; }
  nav { border-bottom: 1px solid #30363d; padding-bottom: 12px; margin-bottom: 1.5em; font-size: 14px; }
  .error-banner { background: #3d1418; border: 1px solid #f85149; color: #f85149; padding: 8px 12px; border-radius: 6px; margin-bottom: 1em; }
  .btn { display: inline-block; padding: 4px 14px; border-radius: 4px; border: none; font-family: inherit; font-size: 13px; cursor: pointer; font-weight: 600; text-decoration: none; }
  .btn-primary { background: #22c55e; color: #fff; }
  .btn-primary:hover { background: #16a34a; text-decoration: none; }
  .sticky-bar { position: fixed; bottom: 0; left: 0; right: 0; background: #161b22; border-top: 1px solid #30363d; padding: 10px 2rem; display: flex; justify-content: space-between; align-items: center; z-index: 100; }
  .sticky-bar-spacer { height: 60px; }
  .status-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; }
  .status-active { background: #22c55e; }
  .status-idle { background: #6b7280; }
  .status-dead { background: #ef4444; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 0.8em; font-weight: 600; color: #fff; }
</style>
</head>
<body>
<article>
<nav>${nav}</nav>
${body}
</article>
</body>
</html>`;
}
```

- [ ] **Step 3: Update all existing `pageShell()` callers to pass `activePage`**

In `renderListing()`:
```ts
return pageShell("Reviews", body, "reviews");
```

In the empty reviews case:
```ts
return pageShell("Reviews", "<h1>Heimdall Reviews</h1><p>No reviews found.</p>", "reviews");
```

In `renderReview()` (the return):
```ts
return pageShell(`PR-${number} — ${owner}/${repo}`, header + html, "reviews");
```

In `renderTriageListing()`:
```ts
return pageShell("Triage", body, "triage");
```

In the empty triage case:
```ts
return pageShell("Triage", "<h1>Heimdall Triage Reports</h1><p>No triage reports found.</p>", "triage");
```

In `renderTriageDetail()`:
```ts
return pageShell(`Triage — ${issueKey}`, header + html, "triage");
```

- [ ] **Step 4: Run existing server tests**

Run: `bun test src/server.test.ts`
Expected: All existing tests PASS — `pageShell()` change is backward-compatible (new param is optional), `startServer` opts are optional too.

Run: `bun test`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/server.ts
git commit -m "feat: add shared navigation bar to all pages"
```

---

### Task 4: Triage detail — sticky bottom bar with approve button

**Files:**
- Modify: `src/server.ts`
- Modify: `src/server.test.ts`

- [ ] **Step 1: Write tests for triage approve endpoint**

Rewrite `src/server.test.ts` to use the `heimdallDir` override so the server reads test data:

```ts
// src/server.test.ts
import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { startServer } from "./server";
import type { HeimdallConfig } from "./types";
import { createLogger } from "./logger";

const TEST_PORT = 18787;
const TEST_HEIMDALL_DIR = "/tmp/heimdall-server-test";
const TEST_TRIAGE_DIR = join(TEST_HEIMDALL_DIR, "triage");
const TEST_QUEUE_DIR = join(TEST_HEIMDALL_DIR, "queue");
const TEST_REVIEWS_DIR = join(TEST_HEIMDALL_DIR, "reviews");
const TEST_CONFIG_PATH = join(TEST_HEIMDALL_DIR, "config.json");

let server: ReturnType<typeof Bun.serve>;

beforeAll(async () => {
  mkdirSync(TEST_TRIAGE_DIR, { recursive: true });
  mkdirSync(TEST_QUEUE_DIR, { recursive: true });
  mkdirSync(TEST_REVIEWS_DIR, { recursive: true });

  const triageReport = {
    issue: { key: "TEST-1", title: "Test issue", description: "desc", url: "https://jira.example.com/TEST-1", project: "TEST", assignee: "", status: "", issueType: "", referenceUrls: [] },
    result: { criteria: { acceptance_clarity: 3, scope_boundedness: 2, technical_detail: 2 }, total: 7, max: 9, size: "M", verdict: "ready", concerns: "", suggested_files: ["src/foo.ts"], feasibility: null, confidence: "high", confidence_reasoning: null },
    verdict: "ready",
    confidence: "high",
    timestamp: "2026-04-21T00:00:00.000Z",
  };
  writeFileSync(join(TEST_TRIAGE_DIR, "TEST-1.json"), JSON.stringify(triageReport));
  writeFileSync(join(TEST_TRIAGE_DIR, "TEST-1.md"), "# TEST-1 Triage\nSome content");

  const testConfig = {
    sources: [{ type: "jira", baseUrl: "https://jira.example.com", email: "a@b.com", apiToken: "tok", jql: "", projects: { TEST: { repo: "org/repo", cwd: "/tmp/repo" } } }],
  };
  writeFileSync(TEST_CONFIG_PATH, JSON.stringify(testConfig));

  const logger = createLogger({ file: "/dev/null", level: "error" });
  const config = { server: { port: TEST_PORT }, reports: { dir: TEST_REVIEWS_DIR } } as HeimdallConfig;
  server = startServer(config, logger, { heimdallDir: TEST_HEIMDALL_DIR, configPath: TEST_CONFIG_PATH });
});

afterAll(() => {
  server.stop();
  rmSync(TEST_HEIMDALL_DIR, { recursive: true, force: true });
});

// Existing tests (updated: GET / now returns dashboard, not redirect)
test("GET / returns dashboard", async () => {
  const res = await fetch(`http://localhost:${TEST_PORT}/`);
  expect(res.status).toBe(200);
  const html = await res.text();
  expect(html).toContain("Heimdall");
});

test("GET /reviews returns HTML", async () => {
  const res = await fetch(`http://localhost:${TEST_PORT}/reviews`);
  expect(res.status).toBe(200);
  expect(res.headers.get("Content-Type")).toContain("text/html");
});

test("GET /reviews/nonexistent/repo/PR-999 returns 404", async () => {
  const res = await fetch(`http://localhost:${TEST_PORT}/reviews/nonexistent/repo/PR-999`);
  expect(res.status).toBe(404);
});
```

Add new tests below the existing ones:

```ts
test("GET /triage/TEST-1 shows approve button for ready verdict", async () => {
  const res = await fetch(`http://localhost:${TEST_PORT}/triage/TEST-1`);
  const html = await res.text();
  expect(html).toContain("Approve");
  expect(html).toContain("sticky-bar");
});

test("POST /triage/MISSING-1/approve returns redirect with error", async () => {
  const res = await fetch(`http://localhost:${TEST_PORT}/triage/MISSING-1/approve`, {
    method: "POST",
    redirect: "manual",
  });
  expect(res.status).toBe(303);
  expect(res.headers.get("Location")).toContain("error=no-report");
});
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `bun test src/server.test.ts`
Expected: New tests FAIL (POST route doesn't exist, sticky bar not rendered)

- [ ] **Step 3: Modify `renderTriageDetail()` to add sticky bottom bar**

Update `renderTriageDetail()` in `src/server.ts`. The function needs access to the queue to check if the item is already queued. Update its signature and add the sticky bar:

```ts
async function renderTriageDetail(
  triageDir: string,
  issueKey: string,
  queueDir: string
): Promise<string | null> {
  const mdPath = join(triageDir, `${issueKey}.md`);
  if (!existsSync(mdPath)) return null;

  const content = await Bun.file(mdPath).text();

  const jsonPath = join(triageDir, `${issueKey}.json`);
  let verdict: TriageVerdict = "not_feasible";
  let confidence = "";
  let jiraUrl = "";
  if (existsSync(jsonPath)) {
    const report = await Bun.file(jsonPath).json();
    verdict = report.verdict;
    confidence = report.confidence ?? "";
    jiraUrl = report.issue?.url || "";
  }

  // Check queue status
  const queuePath = join(queueDir, `${issueKey}.json`);
  let queueStatus: string | null = null;
  let prUrl: string | null = null;
  if (existsSync(queuePath)) {
    const queueItem = await Bun.file(queuePath).json();
    queueStatus = queueItem.status;
    prUrl = queueItem.prUrl || null;
  }

  const html = markdownToHtml(content);

  const header = `<div class="back"><a href="/triage">&larr; All Triage Reports</a></div>
<div style="display:flex;align-items:center;gap:1em;margin-bottom:1em;">
  ${triageVerdictBadge(verdict)}
  ${jiraUrl ? `<a href="${jiraUrl}" target="_blank">Open in Jira &rarr;</a>` : ""}
</div>`;

  let stickyBar = "";
  if (queueStatus) {
    const statusText = queueStatus === "completed" && prUrl
      ? `Completed &mdash; <a href="${prUrl}" target="_blank">Open PR &rarr;</a>`
      : queueStatus === "in_progress"
        ? "In progress&hellip;"
        : `Queued (${queueStatus})`;
    stickyBar = `<div class="sticky-bar"><span>${triageVerdictBadge(verdict)} ${confidence ? `&middot; ${confidence} confidence` : ""}</span><span>${statusText}</span></div><div class="sticky-bar-spacer"></div>`;
  } else if (verdict === "ready") {
    stickyBar = `<div class="sticky-bar"><span>${triageVerdictBadge(verdict)} ${confidence ? `&middot; ${confidence} confidence` : ""}</span><form method="POST" action="/triage/${issueKey}/approve"><button type="submit" class="btn btn-primary">Approve</button></form></div><div class="sticky-bar-spacer"></div>`;
  }

  return pageShell(`Triage — ${issueKey}`, header + html + stickyBar, "triage");
}
```

- [ ] **Step 4: Add POST route and update the triage detail route call**

In the `fetch` handler in `startServer()`, add the POST route and update the existing triage detail call. The function now needs `configPath` as a parameter — add it to `startServer`:

Add POST route handler before the 404 fallback in the `fetch` handler. `heimdallDir`, `queueDir`, and `opts` are already available from Task 3's `startServer` refactor:

```ts
// POST /triage/:key/approve
const approveMatch = pathname.match(/^\/triage\/([A-Z]+-\d+)\/approve$/);
if (approveMatch && req.method === "POST") {
  const key = approveMatch[1];
  const { approveIssue } = await import("./approve");
  const result = await approveIssue(key, { heimdallDir, configPath: opts?.configPath });
  if (!result.ok) {
    return new Response(null, {
      status: 303,
      headers: { Location: `/triage/${key}?error=${result.error}` },
    });
  }
  return new Response(null, {
    status: 303,
    headers: { Location: "/queue" },
  });
}
```

Update the existing triage detail handler to pass `queueDir`:
```ts
const html = await renderTriageDetail(triageDir, triageKey, queueDir);
```

- [ ] **Step 5: Add error banner rendering to triage detail**

In `renderTriageDetail`, add error banner support. Update the function to accept an optional `error` parameter:

```ts
async function renderTriageDetail(
  triageDir: string,
  issueKey: string,
  queueDir: string,
  error?: string | null
): Promise<string | null> {
```

After the `header` variable, add:

```ts
const errorBanner = error
  ? `<div class="error-banner">${escapeHtml(
      error === "no-report" ? "No triage report found."
        : error === "not-ready" ? "Verdict is not ready — cannot approve."
        : error === "no-config" ? "No project config found. Check config.json."
        : error
    )}</div>`
  : "";
```

Update the return to include it:
```ts
return pageShell(`Triage — ${issueKey}`, header + errorBanner + html + stickyBar, "triage");
```

Update the route handler to pass the error query param:
```ts
if (triageKey) {
  const error = url.searchParams.get("error");
  const html = await renderTriageDetail(triageDir, triageKey, queueDir, error);
```

- [ ] **Step 6: Run tests**

Run: `bun test src/server.test.ts`
Expected: All tests PASS

- [ ] **Step 7: Commit**

```bash
git add src/server.ts src/server.test.ts
git commit -m "feat: add approve button and POST endpoint to triage detail page"
```

---

### Task 5: Dashboard page

**Files:**
- Modify: `src/server.ts`
- Modify: `src/server.test.ts`

- [ ] **Step 1: Write dashboard test**

Add to `src/server.test.ts`:

```ts
test("GET / returns dashboard HTML", async () => {
  const res = await fetch(`http://localhost:${TEST_PORT}/`);
  expect(res.status).toBe(200);
  const html = await res.text();
  expect(html).toContain("Dashboard");
  expect(html).toContain("Worker");
  expect(html).toContain("Queue");
  expect(html).toContain("Recent");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/server.test.ts`
Expected: FAIL — `GET /` still redirects to `/reviews`

Also update the existing redirect test to expect 200 instead of 302, or remove it:
```ts
test("GET / returns dashboard", async () => {
  const res = await fetch(`http://localhost:${TEST_PORT}/`);
  expect(res.status).toBe(200);
  const html = await res.text();
  expect(html).toContain("Dashboard");
});
```

- [ ] **Step 3: Implement `renderDashboard()` function**

Add to `src/server.ts`:

```ts
import { getWorkerStatus } from "./heartbeat";

async function renderDashboard(
  triageDir: string,
  reportsDir: string,
  queueDir: string,
  heimdallDir: string
): Promise<string> {
  // Worker status
  const worker = getWorkerStatus(heimdallDir);
  const statusDotClass = worker.state === "active" ? "status-active" : worker.state === "idle" ? "status-idle" : "status-dead";
  const statusLabel = worker.state === "active" ? "active" : worker.state === "idle" ? "idle" : "dead (stale heartbeat)";

  // Find in-progress item for label
  const queueManager = new (await import("./queue")).QueueManager(queueDir);
  const queueItems = await queueManager.list();
  const inProgress = queueItems.find((i) => i.status === "in_progress");
  const pendingCount = queueItems.filter((i) => i.status === "pending").length;

  let workerText = `<span class="status-dot ${statusDotClass}"></span>Worker: ${statusLabel}`;
  if (worker.state === "active" && inProgress) {
    const elapsed = Math.floor((Date.now() - new Date(inProgress.approvedAt).getTime()) / 60_000);
    workerText = `<span class="status-dot status-active"></span>Worker: <a href="/triage/${inProgress.issueKey}">${inProgress.issueKey}</a> (${elapsed}m)`;
  }

  // Queue summary
  const activeItems = queueItems.filter((i) => i.status === "pending" || i.status === "in_progress");
  let queueRows = "";
  for (const item of activeItems.slice(0, 5)) {
    const statusColor = item.status === "in_progress" ? "#eab308" : "#8b949e";
    queueRows += `<tr><td><a href="/triage/${item.issueKey}">${item.issueKey}</a></td><td>${escapeHtml(item.title.length > 50 ? item.title.slice(0, 50) + "…" : item.title)}</td><td><span class="badge" style="background:${statusColor}">${item.status}</span></td><td>${new Date(item.approvedAt).toLocaleString()}</td></tr>\n`;
  }

  const startButton = worker.state !== "active" && pendingCount > 0
    ? `<form method="POST" action="/worker/start" style="display:inline;margin-left:8px;"><button type="submit" class="btn btn-primary">Start Worker</button></form>`
    : "";

  // Recent activity (last 5 triage + reviews interleaved by date)
  const triageEntries = await discoverTriageReports(triageDir);
  const reviewEntries = await discoverReviews(reportsDir);

  type ActivityItem = { date: string; html: string };
  const activities: ActivityItem[] = [];

  for (const t of triageEntries.slice(0, 5)) {
    activities.push({
      date: t.date,
      html: `<a href="/triage/${t.key}">${t.key}</a> triaged &rarr; ${triageVerdictBadge(t.verdict)}`,
    });
  }
  for (const r of reviewEntries.slice(0, 5)) {
    activities.push({
      date: r.date,
      html: `<a href="/reviews/${r.owner}/${r.repo}/PR-${r.number}">PR #${r.number}</a> reviewed &rarr; ${verdictBadge(r.verdict)}`,
    });
  }
  activities.sort((a, b) => (b.date > a.date ? 1 : b.date < a.date ? -1 : 0));

  let activityRows = "";
  for (const a of activities.slice(0, 5)) {
    activityRows += `<tr><td>${a.html}</td><td style="color:#8b949e;">${a.date ? new Date(a.date).toLocaleDateString() : ""}</td></tr>\n`;
  }

  const body = `<h1>Heimdall</h1>
<div style="margin-bottom:1.5em;">${workerText}</div>

<div style="color:#8b949e;font-size:0.85em;margin-bottom:4px;">QUEUE ${startButton}</div>
${activeItems.length > 0
    ? `<table><tr><th>Issue</th><th>Title</th><th>Status</th><th>Approved</th></tr>${queueRows}</table>`
    : `<p style="color:#8b949e;">No pending items.</p>`}

<div style="color:#8b949e;font-size:0.85em;margin-bottom:4px;margin-top:1.5em;">RECENT</div>
${activities.length > 0
    ? `<table><tr><th>Activity</th><th>Date</th></tr>${activityRows}</table>`
    : `<p style="color:#8b949e;">No recent activity.</p>`}`;

  return pageShell("Dashboard", body, "dashboard");
}
```

- [ ] **Step 4: Replace the `/` redirect with dashboard render**

In the `fetch` handler, replace the `GET /` block:

```ts
// GET / -> dashboard
if (pathname === "/") {
  const html = await renderDashboard(triageDir, reportsDir, queueDir, heimdallDir);
  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}
```

`heimdallDir` is already available from the Task 3 `startServer` refactor.

- [ ] **Step 5: Run tests**

Run: `bun test src/server.test.ts`
Expected: All tests PASS

- [ ] **Step 6: Commit**

```bash
git add src/server.ts src/server.test.ts
git commit -m "feat: add dashboard home page with worker/queue/activity"
```

---

### Task 6: Queue page and worker start endpoint

**Files:**
- Modify: `src/server.ts`
- Modify: `src/server.test.ts`

- [ ] **Step 1: Write queue page tests**

Add to `src/server.test.ts`:

```ts
test("GET /queue returns HTML with queue table", async () => {
  const res = await fetch(`http://localhost:${TEST_PORT}/queue`);
  expect(res.status).toBe(200);
  const html = await res.text();
  expect(html).toContain("Queue");
  expect(res.headers.get("Content-Type")).toContain("text/html");
});

test("POST /worker/start redirects to /queue", async () => {
  const res = await fetch(`http://localhost:${TEST_PORT}/worker/start`, {
    method: "POST",
    redirect: "manual",
  });
  expect(res.status).toBe(303);
  expect(res.headers.get("Location")).toBe("/queue");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/server.test.ts`
Expected: New tests FAIL (404)

- [ ] **Step 3: Implement `renderQueuePage()`**

Add to `src/server.ts`:

```ts
async function renderQueuePage(queueDir: string, heimdallDir: string): Promise<string> {
  const worker = getWorkerStatus(heimdallDir);
  const statusDotClass = worker.state === "active" ? "status-active" : worker.state === "idle" ? "status-idle" : "status-dead";
  const statusLabel = worker.state === "active" ? "active" : worker.state === "idle" ? "idle" : "dead (stale heartbeat)";

  const queueManager = new (await import("./queue")).QueueManager(queueDir);
  const items = await queueManager.list();
  const pendingCount = items.filter((i) => i.status === "pending").length;

  const startButton = worker.state !== "active" && pendingCount > 0
    ? `<form method="POST" action="/worker/start" style="display:inline;margin-left:8px;"><button type="submit" class="btn btn-primary">Start Worker</button></form>`
    : "";

  // Sort: in_progress first, then pending, then completed/failed by date
  const sorted = [...items].sort((a, b) => {
    const order: Record<string, number> = { in_progress: 0, pending: 1, completed: 2, failed: 3 };
    const diff = (order[a.status] ?? 4) - (order[b.status] ?? 4);
    if (diff !== 0) return diff;
    return b.approvedAt.localeCompare(a.approvedAt);
  });

  let rows = "";
  for (const item of sorted) {
    const colors: Record<string, string> = { pending: "#6b7280", in_progress: "#eab308", completed: "#22c55e", failed: "#ef4444" };
    const bg = colors[item.status] ?? "#6b7280";
    const prLink = item.prUrl ? `<a href="${item.prUrl}" target="_blank">PR &rarr;</a>` : "";
    rows += `<tr>
  <td><a href="/triage/${item.issueKey}">${item.issueKey}</a></td>
  <td>${escapeHtml(item.title)}</td>
  <td><span class="badge" style="background:${bg}">${item.status}</span></td>
  <td>${new Date(item.approvedAt).toLocaleDateString()}</td>
  <td>${item.branch ?? ""}</td>
  <td>${prLink}</td>
</tr>\n`;
  }

  const body = `<h1>Queue</h1>
<div style="margin-bottom:1.5em;"><span class="status-dot ${statusDotClass}"></span>Worker: ${statusLabel} ${startButton}</div>
${items.length > 0
    ? `<table><tr><th>Issue</th><th>Title</th><th>Status</th><th>Approved</th><th>Branch</th><th>PR</th></tr>${rows}</table>`
    : `<p style="color:#8b949e;">Queue is empty.</p>`}`;

  return pageShell("Queue", body, "queue");
}
```

- [ ] **Step 4: Add queue routes to the fetch handler**

Add before the 404 fallback:

```ts
// GET /queue
if (pathname === "/queue") {
  const html = await renderQueuePage(queueDir, heimdallDir);
  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

// POST /worker/start
if (pathname === "/worker/start" && req.method === "POST") {
  const workerStatus = getWorkerStatus(heimdallDir);
  if (workerStatus.state !== "active") {
    Bun.spawn(["bun", "run", join(import.meta.dir, "index.ts"), "worker"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    logger.info("Worker started from web UI");
  }
  return new Response(null, {
    status: 303,
    headers: { Location: "/queue" },
  });
}
```

Note: We use `bun run src/index.ts worker` rather than `heimdall worker` to avoid depending on the binary being installed. `import.meta.dir` resolves to the `src/` directory.

- [ ] **Step 5: Run tests**

Run: `bun test src/server.test.ts`
Expected: All tests PASS

- [ ] **Step 6: Run full test suite**

Run: `bun test`
Expected: All tests PASS

- [ ] **Step 7: Commit**

```bash
git add src/server.ts src/server.test.ts
git commit -m "feat: add queue page and worker start endpoint"
```

---

### Task 7: Clean up dead notification flags

**Files:**
- Modify: `src/actions/notify.ts`

- [ ] **Step 1: Remove `-actions` and `-execute` from `sendTriageNotification`**

In `src/actions/notify.ts`, update `sendTriageNotification` to remove the dead flags. The `approveCommand` parameter is no longer needed:

```ts
private async sendTriageNotification(
  title: string,
  subtitle: string,
  message: string,
  triageUrl: string,
  _approveCommand: string,
  group: string
): Promise<void> {
  if (this.notifier === "terminal-notifier") {
    const proc = Bun.spawn([
      "terminal-notifier",
      "-title", title,
      "-subtitle", subtitle,
      "-message", message,
      "-open", triageUrl,
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

- [ ] **Step 2: Remove `-actions` and `-execute` from `sendReviewComplete`**

Update `sendReviewComplete` — the `prUrl` parameter is no longer used for the execute command:

```ts
private async sendReviewComplete(
  title: string,
  subtitle: string,
  message: string,
  reviewUrl: string,
  _prUrl: string,
  group: string
): Promise<void> {
  if (this.notifier === "terminal-notifier") {
    const proc = Bun.spawn([
      "terminal-notifier",
      "-title", title,
      "-subtitle", subtitle,
      "-message", message,
      "-open", reviewUrl,
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

- [ ] **Step 3: Run full test suite**

Run: `bun test`
Expected: All tests PASS

- [ ] **Step 4: Commit**

```bash
git add src/actions/notify.ts
git commit -m "fix: remove dead terminal-notifier action button flags"
```

---

### Task 8: Final verification

- [ ] **Step 1: Run full test suite**

Run: `bun test`
Expected: All tests PASS

- [ ] **Step 2: Manual smoke test**

Start the server:
```bash
bun run src/index.ts run --once
```

Verify in browser:
1. `http://localhost:7878/` — Dashboard shows worker status, queue, recent activity
2. `http://localhost:7878/triage` — Triage listing with nav bar
3. `http://localhost:7878/triage/ITRE-159` — Triage detail with sticky approve bar
4. `http://localhost:7878/reviews` — Reviews listing with nav bar
5. `http://localhost:7878/queue` — Queue page with worker status
6. Nav bar appears on all pages, highlights current page

- [ ] **Step 3: Commit any final fixes**

If any issues found during smoke test, fix and commit.
