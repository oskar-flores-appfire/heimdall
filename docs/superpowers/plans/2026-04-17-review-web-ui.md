# Review Web UI, Verdict Notifications & CLI Open — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add verdict parsing, an embedded web server for viewing review reports, verdict-aware notifications with two buttons (open review / open PR), and a `heimdall open <number>` CLI command.

**Architecture:** New `parseVerdict()` utility extracts PASS/FAIL from existing review markdown. New `Bun.serve()` web server embedded in the daemon renders reports as HTML. Notifications updated to show verdict and link to local web UI. Daemon model changes from ephemeral (launchd StartInterval) to persistent (KeepAlive + internal setInterval).

**Tech Stack:** Bun, TypeScript, `Bun.serve()`, `terminal-notifier`, regex-based markdown-to-HTML converter. Zero npm deps.

**Spec:** `docs/superpowers/specs/2026-04-17-review-web-ui-design.md`

---

## File Map

| File | Responsibility | Status |
|------|---------------|--------|
| `src/types.ts` | Add `ReviewVerdict` type, `server` config to `HeimdallConfig` | Modify |
| `src/config.ts` | Add `server: { port: 7878 }` default | Modify |
| `src/verdict.ts` | `parseVerdict()` — extract verdict from review markdown | Create |
| `src/server.ts` | `startServer()` — Bun.serve with routes, markdown renderer, HTML templates | Create |
| `src/actions/notify.ts` | Update `notifyComplete()` — verdict, review URL, two-button notification | Modify |
| `src/scheduler.ts` | Read report after review, parse verdict, pass to notification | Modify |
| `src/cli/run.ts` | Convert to persistent process, start server, setInterval poll loop, `--once` flag | Modify |
| `src/cli/install.ts` | Change plist from StartInterval to KeepAlive | Modify |
| `src/cli/open.ts` | `heimdall open <number>` — detect repo from cwd, open review in browser | Create |
| `src/index.ts` | Add `case "open"` | Modify |
| `docs/specs/2026-04-13-heimdall-design.md` | Update docs: project structure, CLI, config, daemon model, notifications | Modify |

---

### Task 1: Types & Config

**Files:**
- Modify: `src/types.ts`
- Modify: `src/config.ts`

- [ ] **Step 1: Add `ReviewVerdict` type and `server` config to types**

In `src/types.ts`, add at the top after the existing domain types:

```typescript
export type ReviewVerdict = "PASS" | "PASS (conditional)" | "FAIL" | "unknown";
```

In the `HeimdallConfig` interface, add after the `costs` field:

```typescript
server: { port: number };
```

- [ ] **Step 2: Add server default to config**

In `src/config.ts`, add to `DEFAULT_CONFIG` after the `costs` entry:

```typescript
server: { port: 7878 },
```

- [ ] **Step 3: Verify it compiles**

Run: `bun build --no-bundle src/index.ts --outdir /dev/null 2>&1 || echo "Checking types..." && bun run src/index.ts --help`

Expected: Heimdall help output, no type errors.

- [ ] **Step 4: Commit**

```bash
git add src/types.ts src/config.ts
git commit -m "feat: add ReviewVerdict type and server config"
```

---

### Task 2: Verdict Parsing

**Files:**
- Create: `src/verdict.ts`
- Create: `src/verdict.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/verdict.test.ts`:

```typescript
import { test, expect } from "bun:test";
import { parseVerdict } from "./verdict";

test("parses PASS verdict", () => {
  const content = `## VERDICT: **PASS**\n\nSome text`;
  expect(parseVerdict(content)).toBe("PASS");
});

test("parses PASS (conditional) verdict", () => {
  const content = `VERDICT: **PASS (conditional — fix violations before merge)**`;
  expect(parseVerdict(content)).toBe("PASS (conditional)");
});

test("parses FAIL verdict", () => {
  const content = `## VERDICT: **FAIL**`;
  expect(parseVerdict(content)).toBe("FAIL");
});

test("returns unknown when no verdict found", () => {
  const content = `# Code Review\n\nNo verdict here.`;
  expect(parseVerdict(content)).toBe("unknown");
});

test("handles verdict inside code block (real report format)", () => {
  const content = `\`\`\`\nVERDICT: **PASS (conditional — fix violations before merge)**\n\`\`\``;
  expect(parseVerdict(content)).toBe("PASS (conditional)");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/verdict.test.ts`

Expected: FAIL — `Cannot find module "./verdict"`

- [ ] **Step 3: Implement parseVerdict**

Create `src/verdict.ts`:

```typescript
import type { ReviewVerdict } from "./types";

export function parseVerdict(reportContent: string): ReviewVerdict {
  const match = reportContent.match(/VERDICT:\s*\*\*(.+?)\*\*/);
  if (!match) return "unknown";

  const raw = match[1].toLowerCase();
  if (raw.includes("pass") && raw.includes("conditional")) return "PASS (conditional)";
  if (raw.includes("pass")) return "PASS";
  if (raw.includes("fail")) return "FAIL";
  return "unknown";
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/verdict.test.ts`

Expected: 5 tests passing.

- [ ] **Step 5: Commit**

```bash
git add src/verdict.ts src/verdict.test.ts
git commit -m "feat: add parseVerdict to extract review verdict from markdown"
```

---

### Task 3: Update notifyComplete with Verdict & Two Buttons

**Files:**
- Modify: `src/actions/notify.ts`

- [ ] **Step 1: Update notifyComplete signature and implementation**

In `src/actions/notify.ts`, add the import at the top:

```typescript
import type { Action, PullRequest, RepoConfig, ActionResult, JiraIssue, TriageReport, ReviewVerdict } from "../types";
```

Replace the `notifyComplete` method with:

```typescript
async notifyComplete(
  pr: PullRequest,
  _reportPath: string,
  verdict: ReviewVerdict,
  reviewUrl: string
): Promise<ActionResult> {
  const icon = verdict === "PASS" ? "✓" : verdict === "PASS (conditional)" ? "⚠" : "✗";
  const title = `Heimdall ${icon}`;
  const message = `PR #${pr.number}: ${verdict} — ${pr.title}`;
  try {
    await this.sendReviewComplete(title, pr.repo, message, reviewUrl, pr.url, `heimdall-${pr.repo}-${pr.number}`);
    this.logger.info(`Review complete notification: ${message}`);
    return { action: "notify", success: true, message };
  } catch (err) {
    this.logger.error(`Completion notification failed: ${err}`);
    return { action: "notify", success: false, message: String(err) };
  }
}
```

Add the new `sendReviewComplete` private method after the existing `sendTriage` method:

```typescript
private async sendReviewComplete(
  title: string,
  subtitle: string,
  message: string,
  reviewUrl: string,
  prUrl: string,
  group: string
): Promise<void> {
  if (this.notifier === "terminal-notifier") {
    const proc = Bun.spawn([
      "terminal-notifier",
      "-title", title,
      "-subtitle", subtitle,
      "-message", message,
      "-open", reviewUrl,
      "-actions", "Open PR",
      "-execute", `open ${prUrl}`,
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

- [ ] **Step 2: Verify it compiles**

Run: `bun run src/index.ts`

Expected: Heimdall help output, no errors. (The call site in scheduler.ts will be updated in Task 6.)

Note: The call in `scheduler.ts` still uses the old 2-arg signature — it will break until Task 6. That's expected for now.

- [ ] **Step 3: Commit**

```bash
git add src/actions/notify.ts
git commit -m "feat: update notifyComplete with verdict display and two-button notification"
```

---

### Task 4: Web Server

**Files:**
- Create: `src/server.ts`
- Create: `src/server.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/server.test.ts`:

```typescript
import { test, expect, beforeAll, afterAll } from "bun:test";
import { startServer } from "./server";
import type { HeimdallConfig } from "./types";
import { createLogger } from "./logger";

const TEST_PORT = 18787;
let server: ReturnType<typeof Bun.serve>;

beforeAll(async () => {
  const logger = createLogger({ file: "/dev/null", level: "error" });
  const config = { server: { port: TEST_PORT }, reports: { dir: "/tmp/heimdall-test-reviews" } } as HeimdallConfig;
  server = startServer(config, logger);
});

afterAll(() => {
  server.stop();
});

test("GET / redirects to /reviews", async () => {
  const res = await fetch(`http://localhost:${TEST_PORT}/`, { redirect: "manual" });
  expect(res.status).toBe(302);
  expect(res.headers.get("Location")).toBe("/reviews");
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

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/server.test.ts`

Expected: FAIL — `Cannot find module "./server"`

- [ ] **Step 3: Implement the server**

Create `src/server.ts`:

```typescript
import { Glob } from "bun";
import { join } from "path";
import { existsSync } from "fs";
import type { HeimdallConfig } from "./types";
import type { Logger } from "./logger";
import { parseVerdict } from "./verdict";
import { resolveHomePath } from "./config";

export function startServer(config: HeimdallConfig, logger: Logger) {
  const reportsDir = resolveHomePath(config.reports.dir);

  const server = Bun.serve({
    port: config.server.port,
    fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname;

      if (path === "/") {
        return Response.redirect("/reviews", 302);
      }

      const reviewMatch = path.match(/^\/reviews\/([^/]+)\/([^/]+)\/PR-(\d+)$/);
      if (reviewMatch) {
        const [, owner, repo, number] = reviewMatch;
        return handleReviewDetail(reportsDir, owner, repo, number);
      }

      if (path === "/reviews") {
        return handleReviewListing(reportsDir);
      }

      return new Response("Not found", { status: 404 });
    },
  });

  logger.info(`Review server listening on http://localhost:${config.server.port}`);
  return server;
}

interface ReviewEntry {
  owner: string;
  repo: string;
  number: number;
  title: string;
  author: string;
  date: string;
  verdict: string;
}

async function discoverReviews(reportsDir: string): Promise<ReviewEntry[]> {
  const entries: ReviewEntry[] = [];
  const glob = new Glob("**/PR-*.md");

  for await (const file of glob.scan({ cwd: reportsDir, absolute: false })) {
    const parts = file.split("/");
    if (parts.length < 3) continue;

    const owner = parts[0];
    const repo = parts[1];
    const filename = parts[parts.length - 1];
    const numberMatch = filename.match(/PR-(\d+)\.md$/);
    if (!numberMatch) continue;

    const content = await Bun.file(join(reportsDir, file)).text();
    const titleMatch = content.match(/\*\*Title:\*\*\s*(.+)/);
    const authorMatch = content.match(/\*\*Author:\*\*\s*(.+)/);
    const dateMatch = content.match(/\*\*Reviewed:\*\*\s*(.+)/);
    const verdict = parseVerdict(content);

    entries.push({
      owner,
      repo,
      number: parseInt(numberMatch[1]),
      title: titleMatch?.[1]?.trim() ?? `PR #${numberMatch[1]}`,
      author: authorMatch?.[1]?.trim() ?? "unknown",
      date: dateMatch?.[1]?.trim() ?? "unknown",
      verdict,
    });
  }

  entries.sort((a, b) => b.date.localeCompare(a.date));
  return entries;
}

function verdictBadge(verdict: string): string {
  const colors: Record<string, string> = {
    "PASS": "#22c55e",
    "PASS (conditional)": "#eab308",
    "FAIL": "#ef4444",
    "unknown": "#6b7280",
  };
  const color = colors[verdict] ?? colors["unknown"];
  return `<span style="display:inline-block;padding:2px 8px;border-radius:4px;background:${color};color:#fff;font-size:0.85em;font-weight:600;">${verdict}</span>`;
}

async function handleReviewListing(reportsDir: string): Promise<Response> {
  const reviews = await discoverReviews(reportsDir);

  const grouped = new Map<string, ReviewEntry[]>();
  for (const r of reviews) {
    const key = `${r.owner}/${r.repo}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(r);
  }

  let rows = "";
  for (const [repoKey, entries] of grouped) {
    rows += `<tr><td colspan="5" style="padding:12px 8px 4px;font-weight:700;font-size:1.1em;border-bottom:2px solid #333;">${repoKey}</td></tr>`;
    for (const e of entries) {
      const link = `/reviews/${e.owner}/${e.repo}/PR-${e.number}`;
      rows += `<tr>
        <td style="padding:6px 8px;"><a href="${link}" style="color:#60a5fa;text-decoration:none;">#${e.number}</a></td>
        <td style="padding:6px 8px;">${e.title}</td>
        <td style="padding:6px 8px;">${e.author}</td>
        <td style="padding:6px 8px;">${e.date.split("T")[0] ?? e.date}</td>
        <td style="padding:6px 8px;">${verdictBadge(e.verdict)}</td>
      </tr>`;
    }
  }

  if (reviews.length === 0) {
    rows = `<tr><td colspan="5" style="padding:20px;text-align:center;color:#888;">No reviews found.</td></tr>`;
  }

  const html = pageShell("Heimdall — Reviews", `
    <h1>Heimdall Reviews</h1>
    <table style="width:100%;border-collapse:collapse;">
      <thead>
        <tr style="border-bottom:1px solid #444;">
          <th style="padding:8px;text-align:left;">PR</th>
          <th style="padding:8px;text-align:left;">Title</th>
          <th style="padding:8px;text-align:left;">Author</th>
          <th style="padding:8px;text-align:left;">Date</th>
          <th style="padding:8px;text-align:left;">Verdict</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `);

  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

async function handleReviewDetail(reportsDir: string, owner: string, repo: string, number: string): Promise<Response> {
  const filePath = join(reportsDir, owner, repo, `PR-${number}.md`);
  if (!existsSync(filePath)) {
    return new Response("Review not found", { status: 404 });
  }

  const content = await Bun.file(filePath).text();
  const verdict = parseVerdict(content);
  const urlMatch = content.match(/\*\*URL:\*\*\s*(.+)/);
  const prUrl = urlMatch?.[1]?.trim() ?? "#";

  const bodyHtml = markdownToHtml(content);

  const html = pageShell(`PR #${number} — ${owner}/${repo}`, `
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px;">
      <a href="/reviews" style="color:#60a5fa;text-decoration:none;">&larr; All Reviews</a>
      <span style="color:#555;">|</span>
      <a href="${prUrl}" style="color:#60a5fa;text-decoration:none;" target="_blank">Open PR on GitHub &rarr;</a>
      <span style="flex:1;"></span>
      ${verdictBadge(verdict)}
    </div>
    <article>${bodyHtml}</article>
  `);

  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

function pageShell(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  <style>
    body { margin:0; padding:24px 40px; background:#0d1117; color:#e6edf3; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif; line-height:1.6; }
    a { color:#60a5fa; }
    h1 { font-size:1.5em; margin:0 0 16px; }
    h2 { font-size:1.3em; margin:24px 0 8px; border-bottom:1px solid #333; padding-bottom:4px; }
    h3 { font-size:1.1em; margin:20px 0 6px; }
    table { border-collapse:collapse; width:100%; }
    th, td { text-align:left; }
    pre { background:#161b22; padding:12px; border-radius:6px; overflow-x:auto; font-size:0.9em; }
    code { font-family:"SF Mono",Monaco,Consolas,monospace; font-size:0.9em; }
    p code { background:#161b22; padding:2px 6px; border-radius:3px; }
    article { max-width:900px; }
    article table { margin:8px 0; }
    article th, article td { padding:4px 10px; border:1px solid #333; }
    article th { background:#161b22; }
  </style>
</head>
<body>${body}</body>
</html>`;
}

export function markdownToHtml(md: string): string {
  let html = md;
  const codeBlocks: string[] = [];

  // Extract fenced code blocks to protect them from other transformations
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
    const idx = codeBlocks.length;
    codeBlocks.push(`<pre><code class="language-${lang}">${escapeHtml(code.trimEnd())}</code></pre>`);
    return `\x00CODEBLOCK${idx}\x00`;
  });

  // Headers
  html = html.replace(/^######\s+(.+)$/gm, "<h6>$1</h6>");
  html = html.replace(/^#####\s+(.+)$/gm, "<h5>$1</h5>");
  html = html.replace(/^####\s+(.+)$/gm, "<h4>$1</h4>");
  html = html.replace(/^###\s+(.+)$/gm, "<h3>$1</h3>");
  html = html.replace(/^##\s+(.+)$/gm, "<h2>$1</h2>");
  html = html.replace(/^#\s+(.+)$/gm, "<h1>$1</h1>");

  // Bold and italic
  html = html.replace(/\*\*\*(.+?)\*\*\*/g, "<strong><em>$1</em></strong>");
  html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/\*(.+?)\*/g, "<em>$1</em>");

  // Inline code
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");

  // Horizontal rules
  html = html.replace(/^---$/gm, "<hr>");

  // Tables
  html = html.replace(/^(\|.+\|)\n(\|[-| :]+\|)\n((?:\|.+\|\n?)*)/gm, (_, header, _separator, body) => {
    const ths = header.split("|").filter((c: string) => c.trim()).map((c: string) => `<th>${c.trim()}</th>`).join("");
    const rows = body.trim().split("\n").map((row: string) => {
      const tds = row.split("|").filter((c: string) => c.trim()).map((c: string) => `<td>${c.trim()}</td>`).join("");
      return `<tr>${tds}</tr>`;
    }).join("");
    return `<table><thead><tr>${ths}</tr></thead><tbody>${rows}</tbody></table>`;
  });

  // Unordered lists
  html = html.replace(/^- (.+)$/gm, "<li>$1</li>");
  html = html.replace(/(<li>.*<\/li>\n?)+/g, (match) => `<ul>${match}</ul>`);

  // Checkboxes in lists
  html = html.replace(/\[x\]/gi, "&#9745;");
  html = html.replace(/\[ \]/g, "&#9744;");

  // Paragraphs — wrap remaining lines that aren't already tags
  html = html.replace(/^(?!<[a-z/]|$|\x00)(.+)$/gm, "<p>$1</p>");

  // Restore code blocks
  html = html.replace(/\x00CODEBLOCK(\d+)\x00/g, (_, idx) => codeBlocks[parseInt(idx)]);

  return html;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/server.test.ts`

Expected: 3 tests passing.

- [ ] **Step 5: Smoke test — start server manually and check in browser**

Run: `bun -e "const { startServer } = require('./src/server'); const { createLogger } = require('./src/logger'); const s = startServer({ server: { port: 7878 }, reports: { dir: '${process.env.HOME}/.heimdall/reviews' } } as any, createLogger({ file: '/dev/null', level: 'info' })); console.log('Server running on http://localhost:7878');"` and open `http://localhost:7878/reviews` in a browser. Verify the listing shows existing reviews with verdict badges. Click one to verify the detail page renders.

- [ ] **Step 6: Commit**

```bash
git add src/server.ts src/server.test.ts
git commit -m "feat: add embedded web server for viewing review reports"
```

---

### Task 5: Update Scheduler — Verdict Parsing & Notification Integration

**Files:**
- Modify: `src/scheduler.ts`

- [ ] **Step 1: Add imports**

Add at the top of `src/scheduler.ts`:

```typescript
import { parseVerdict } from "./verdict";
```

- [ ] **Step 2: Update the notification call after review completes**

In `src/scheduler.ts`, replace the block inside `Promise.all` that handles `result.reportPath`:

```typescript
// OLD:
if (result.reportPath) {
  await state.markReviewed(pr, result.reportPath);
  // Send completion notification
  if (notifyAction) {
    await notifyAction.notifyComplete(pr, result.reportPath);
  }
}

// NEW:
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

- [ ] **Step 3: Verify it compiles**

Run: `bun run src/index.ts`

Expected: Heimdall help output, no errors.

- [ ] **Step 4: Commit**

```bash
git add src/scheduler.ts
git commit -m "feat: parse verdict from review report and pass to notification"
```

---

### Task 6: Persistent Daemon & Server Startup

**Files:**
- Modify: `src/cli/run.ts`
- Modify: `src/cli/install.ts`

- [ ] **Step 1: Update run.ts to persistent mode with --once flag**

Replace the entire `src/cli/run.ts` with:

```typescript
import { existsSync } from "fs";
import { loadConfig, ensureHeimdallDir, resolveHomePath, DEFAULT_CONFIG_PATH, DEFAULT_CONFIG } from "../config";
import { createLogger } from "../logger";
import { StateManager } from "../state";
import { GitHubSource } from "../sources/github";
import { NotifyAction } from "../actions/notify";
import { ReviewAction } from "../actions/review";
import { runCycle } from "../scheduler";
import { JiraSource } from "../sources/jira";
import { TriageAction } from "../actions/triage";
import { runJiraCycle } from "../jira-cycle";
import { startServer } from "../server";
import type { Action, JiraSourceConfig } from "../types";

async function executeCycle(config: Awaited<ReturnType<typeof loadConfig>>, logger: ReturnType<typeof import("../logger").createLogger>, state: StateManager, actions: Action[]): Promise<void> {
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
}

export async function run(): Promise<void> {
  await ensureHeimdallDir();

  // Generate default config on first run
  if (!existsSync(DEFAULT_CONFIG_PATH)) {
    const defaultWithRepo = {
      ...DEFAULT_CONFIG,
      sources: [
        {
          type: "github" as const,
          repos: ["appfire-team/signal-iq"],
          trigger: "review-requested" as const,
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

  const config = await loadConfig();
  const logger = createLogger({
    file: resolveHomePath(config.log.file),
    level: config.log.level,
  });

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
        resolveHomePath("~/.heimdall/review-worktrees"),
        logger
      )
    );
  }

  const once = process.argv.includes("--once");

  if (once) {
    logger.info("Heimdall run — single poll cycle (--once)");
    await executeCycle(config, logger, state, actions);
    return;
  }

  // Persistent mode: start server + poll loop
  logger.info("Heimdall starting — persistent mode");
  startServer(config, logger);

  // Run first cycle immediately
  await executeCycle(config, logger, state, actions);

  // Schedule subsequent cycles
  setInterval(async () => {
    try {
      await executeCycle(config, logger, state, actions);
    } catch (err) {
      logger.error(`Poll cycle error: ${err}`);
    }
  }, config.interval * 1000);

  logger.info(`Polling every ${config.interval}s. Server on http://localhost:${config.server.port}`);
}
```

- [ ] **Step 2: Update install.ts — change plist from StartInterval to KeepAlive**

In `src/cli/install.ts`, replace the `generatePlist` function:

```typescript
function generatePlist(programArgs: string[], logPath: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${PLIST_NAME}</string>
  <key>ProgramArguments</key>
  <array>
${programArgs.map(a => `    <string>${a}</string>`).join("\n")}
  </array>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${logPath}</string>
  <key>StandardErrorPath</key>
  <string>${logPath}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>EnvironmentVariables</key>
  <dict>
${buildEnvDict()}
  </dict>
</dict>
</plist>`;
}
```

Update the call site in the `install()` function — remove the `interval` parameter:

```typescript
// OLD:
const plistContent = generatePlist(programArgs, logPath, config.interval);

// NEW:
const plistContent = generatePlist(programArgs, logPath);
```

Update the success message:

```typescript
// OLD:
console.log(`Heimdall installed and loaded. Polling every ${config.interval}s.`);

// NEW:
console.log(`Heimdall installed and loaded. Persistent mode with web server.`);
```

- [ ] **Step 3: Verify it compiles**

Run: `bun run src/index.ts`

Expected: Heimdall help output, no errors.

- [ ] **Step 4: Test --once mode still works**

Run: `bun run src/index.ts run --once`

Expected: Single poll cycle executes and exits (same as before).

- [ ] **Step 5: Commit**

```bash
git add src/cli/run.ts src/cli/install.ts
git commit -m "feat: convert daemon to persistent mode with embedded web server"
```

---

### Task 7: CLI `open` Command

**Files:**
- Create: `src/cli/open.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Create the open command**

Create `src/cli/open.ts`:

```typescript
import { existsSync, readdirSync } from "fs";
import { join } from "path";
import { loadConfig, resolveHomePath } from "../config";

function detectRepo(): string | null {
  const proc = Bun.spawnSync(["git", "remote", "get-url", "origin"], { stderr: "pipe" });
  if (proc.exitCode !== 0) return null;

  const url = new TextDecoder().decode(proc.stdout).trim();
  // Handle SSH: git@github.com:owner/repo.git
  const sshMatch = url.match(/git@[^:]+:(.+?)(?:\.git)?$/);
  if (sshMatch) return sshMatch[1];
  // Handle HTTPS: https://github.com/owner/repo.git
  const httpsMatch = url.match(/https?:\/\/[^/]+\/(.+?)(?:\.git)?$/);
  if (httpsMatch) return httpsMatch[1];

  return null;
}

function listAvailableRepos(reportsDir: string): string[] {
  const repos: string[] = [];
  if (!existsSync(reportsDir)) return repos;

  for (const owner of readdirSync(reportsDir, { withFileTypes: true })) {
    if (!owner.isDirectory()) continue;
    for (const repo of readdirSync(join(reportsDir, owner.name), { withFileTypes: true })) {
      if (!repo.isDirectory()) continue;
      repos.push(`${owner.name}/${repo.name}`);
    }
  }
  return repos;
}

export async function open(): Promise<void> {
  const prNumber = process.argv[3];
  if (!prNumber || isNaN(parseInt(prNumber))) {
    console.error("Usage: heimdall open <pr-number>");
    process.exit(1);
  }

  const config = await loadConfig();
  const reportsDir = resolveHomePath(config.reports.dir);
  const repo = detectRepo();

  if (!repo) {
    const available = listAvailableRepos(reportsDir);
    console.error("Not in a git repository.");
    if (available.length > 0) {
      console.error(`\nAvailable repos with reviews:\n${available.map(r => `  ${r}`).join("\n")}`);
    }
    process.exit(1);
  }

  const reportPath = join(reportsDir, repo, `PR-${prNumber}.md`);
  if (!existsSync(reportPath)) {
    console.error(`No review found for PR #${prNumber} in ${repo}`);
    process.exit(1);
  }

  const url = `http://localhost:${config.server.port}/reviews/${repo}/PR-${prNumber}`;
  Bun.spawn(["open", url]);
  console.log(`Opening ${url}`);
}
```

- [ ] **Step 2: Add `case "open"` to index.ts**

In `src/index.ts`, add before the `default:` case:

```typescript
case "open": {
  const { open } = await import("./cli/open");
  await open();
  break;
}
```

Update the help text — add `open` to the commands section:

```typescript
// Add to the Commands section in the help text:
  open <number>    Open a review in browser (detects repo from cwd)
```

- [ ] **Step 3: Verify it compiles**

Run: `bun run src/index.ts`

Expected: Help output now includes `open <number>`.

- [ ] **Step 4: Test the open command**

Run from inside a git repo that has reviews:

```bash
cd /Users/oskarflores/code/innovation/signal-iq && bun /Users/oskarflores/code/stuff/heimdall/src/index.ts open 64
```

Expected: Opens `http://localhost:7878/reviews/appfire-team/signal-iq/PR-64` in browser. (Server must be running for the page to load.)

- [ ] **Step 5: Test error case — no review**

Run: `bun run src/index.ts open 9999`

Expected: `No review found for PR #9999 in <repo>`

- [ ] **Step 6: Commit**

```bash
git add src/cli/open.ts src/index.ts
git commit -m "feat: add heimdall open command to view reviews in browser"
```

---

### Task 8: Update Documentation

**Files:**
- Modify: `docs/specs/2026-04-13-heimdall-design.md`

- [ ] **Step 1: Update Project Structure section**

Add new files to the project structure tree:

```
│   ├── verdict.ts             # Parse PASS/FAIL verdict from review markdown
│   ├── server.ts              # Embedded web server for viewing review reports
```

- [ ] **Step 2: Update CLI Commands table**

Add to the commands table:

```markdown
| `heimdall open <number>` | Open a review report in the browser (detects repo from cwd) |
```

- [ ] **Step 3: Update Configuration section**

Add `server` field to the config example:

```jsonc
"server": {
  "port": 7878
}
```

- [ ] **Step 4: Update Data Flow section**

Update step 4 to reflect the new notification flow:

```
   └─ ReviewAction.execute(pr, repoConfig)
       └─ ...
       └─ Capture stdout → write to ~/.heimdall/reviews/{repo}/PR-{number}.md
       └─ Parse verdict from report
       └─ Notify with verdict + review URL (click opens web UI)
```

- [ ] **Step 5: Update Notifications section**

Replace:
```
1. `terminal-notifier` (if installed) — clickable, opens PR URL in browser
```

With:
```
1. `terminal-notifier` (if installed) — clickable, opens review in web UI; "Open PR" button for GitHub
```

Add note about embedded web server:
```
Review reports are served via an embedded web server (default port 7878).
Completion notifications open the rendered review page.
```

- [ ] **Step 6: Update launchd section**

Replace `StartInterval` with `KeepAlive` in the plist example and update the description:
```
Heimdall runs as a persistent process with an embedded web server. launchd keeps it alive via KeepAlive.
Polling is managed internally via setInterval.
```

- [ ] **Step 7: Commit**

```bash
git add docs/specs/2026-04-13-heimdall-design.md
git commit -m "docs: update design doc with web server, verdict, open command, persistent daemon"
```

---

### Task 9: Integration Test — Full Flow

**Files:** None (manual verification)

- [ ] **Step 1: Start Heimdall in persistent mode**

Run: `bun run src/index.ts run`

Expected: Server starts on port 7878, first poll cycle runs.

- [ ] **Step 2: Verify web UI listing**

Open: `http://localhost:7878/reviews`

Expected: Table showing existing reviews (PR-64, PR-65) with verdict badges.

- [ ] **Step 3: Verify single review page**

Open: `http://localhost:7878/reviews/appfire-team/signal-iq/PR-64`

Expected: Rendered HTML of the review, verdict badge at top, link back to listing, link to GitHub PR.

- [ ] **Step 4: Verify `heimdall open` command**

In a new terminal:
```bash
cd /Users/oskarflores/code/innovation/signal-iq
bun /Users/oskarflores/code/stuff/heimdall/src/index.ts open 65
```

Expected: Browser opens the PR-65 review page.

- [ ] **Step 5: Verify --once mode still works**

Run: `bun run src/index.ts run --once`

Expected: Single poll cycle, no server, process exits.

- [ ] **Step 6: Run all tests**

Run: `bun test`

Expected: All tests pass (verdict tests + server tests + any existing tests).
