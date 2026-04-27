import { Glob } from "bun";
import { join } from "path";
import { existsSync } from "fs";
import { marked } from "marked";
import type { HeimdallConfig, ReviewVerdict, TriageVerdict } from "./types";
import type { Logger } from "./logger";
import { parseVerdict } from "./verdict";
import { resolveHomePath, HEIMDALL_DIR } from "./config";
import { getWorkerStatus } from "./heartbeat";

// --- Types ---

interface ReviewEntry {
  owner: string;
  repo: string;
  number: number;
  title: string;
  author: string;
  date: string;
  verdict: ReviewVerdict;
}

// --- Verdict badge ---

function verdictBadge(verdict: ReviewVerdict): string {
  const colors: Record<ReviewVerdict, string> = {
    PASS: "#22c55e",
    "PASS (conditional)": "#eab308",
    FAIL: "#ef4444",
    unknown: "#6b7280",
  };
  const bg = colors[verdict];
  return `<span style="display:inline-block;padding:2px 10px;border-radius:12px;background:${bg};color:#fff;font-size:0.85em;font-weight:600;">${verdict}</span>`;
}

// --- Page shell ---

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
<script type="module">import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs";mermaid.initialize({startOnLoad:false,theme:"dark"});document.querySelectorAll("code.language-mermaid").forEach(el=>{const pre=el.parentElement;const div=document.createElement("div");div.className="mermaid";div.textContent=el.textContent;pre.replaceWith(div);});mermaid.run();</script>
</body>
</html>`;
}

// --- Markdown to HTML ---

export function markdownToHtml(md: string): string {
  return marked.parse(md, { async: false }) as string;
}

// --- Review discovery ---

async function discoverReviews(reportsDir: string): Promise<ReviewEntry[]> {
  if (!existsSync(reportsDir)) return [];

  const glob = new Glob("**/PR-*.md");
  const entries: ReviewEntry[] = [];

  for await (const path of glob.scan({ cwd: reportsDir })) {
    // path looks like: owner/repo/PR-123.md
    const parts = path.split("/");
    if (parts.length < 3) continue;

    const filename = parts[parts.length - 1];
    const numMatch = filename.match(/^PR-(\d+)\.md$/);
    if (!numMatch) continue;

    const owner = parts[parts.length - 3];
    const repo = parts[parts.length - 2];
    const number = parseInt(numMatch[1], 10);

    const fullPath = join(reportsDir, path);
    const content = await Bun.file(fullPath).text();

    const titleMatch = content.match(/\*\*Title:\*\*\s*(.+)/);
    const authorMatch = content.match(/\*\*Author:\*\*\s*(.+)/);
    const dateMatch = content.match(/\*\*Reviewed:\*\*\s*(.+)/);
    const verdict = parseVerdict(content);

    entries.push({
      owner,
      repo,
      number,
      title: titleMatch ? titleMatch[1].trim() : `PR #${number}`,
      author: authorMatch ? authorMatch[1].trim() : "unknown",
      date: dateMatch ? dateMatch[1].trim() : "",
      verdict,
    });
  }

  // Sort by date descending
  entries.sort((a, b) => (b.date > a.date ? 1 : b.date < a.date ? -1 : 0));
  return entries;
}

// --- Listing page ---

function renderListing(entries: ReviewEntry[]): string {
  if (entries.length === 0) {
    return pageShell("Reviews", "<h1>Heimdall Reviews</h1><p>No reviews found.</p>", "reviews");
  }

  // Group by owner/repo
  const groups = new Map<string, ReviewEntry[]>();
  for (const e of entries) {
    const key = `${e.owner}/${e.repo}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(e);
  }

  let rows = "";
  for (const [repoKey, items] of groups) {
    rows += `<tr><td colspan="5" style="background:#161b22;font-weight:700;font-size:1.05em;padding:10px 12px;">${repoKey}</td></tr>\n`;
    for (const e of items) {
      rows += `<tr>
  <td><a href="/reviews/${e.owner}/${e.repo}/PR-${e.number}">PR-${e.number}</a></td>
  <td>${escapeHtml(e.title)}</td>
  <td>${escapeHtml(e.author)}</td>
  <td>${e.date ? new Date(e.date).toLocaleDateString() : ""}</td>
  <td>${verdictBadge(e.verdict)}</td>
</tr>\n`;
    }
  }

  const body = `<h1>Heimdall Reviews</h1>
<table>
<tr><th>PR</th><th>Title</th><th>Author</th><th>Date</th><th>Verdict</th></tr>
${rows}
</table>`;

  return pageShell("Reviews", body, "reviews");
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// --- Single review page ---

async function renderReview(
  reportsDir: string,
  owner: string,
  repo: string,
  number: number
): Promise<string | null> {
  const filePath = join(reportsDir, owner, repo, `PR-${number}.md`);
  if (!existsSync(filePath)) return null;

  const content = await Bun.file(filePath).text();
  const verdict = parseVerdict(content);

  const urlMatch = content.match(/\*\*URL:\*\*\s*(.+)/);
  const prUrl = urlMatch ? urlMatch[1].trim() : null;

  const html = markdownToHtml(content);

  const header = `<div class="back"><a href="/reviews">&larr; All Reviews</a></div>
<div style="display:flex;align-items:center;gap:1em;margin-bottom:1em;">
  ${verdictBadge(verdict)}
  ${prUrl ? `<a href="${prUrl}" target="_blank">Open PR on GitHub &rarr;</a>` : ""}
</div>`;

  return pageShell(`PR-${number} — ${owner}/${repo}`, header + html, "reviews");
}

// --- Triage types ---

interface TriageEntry {
  key: string;
  title: string;
  score: string;
  size: string;
  verdict: TriageVerdict;
  confidence: string;
  date: string;
}

// --- Triage verdict badge ---

function triageVerdictBadge(verdict: TriageVerdict): string {
  const colors: Record<TriageVerdict, string> = {
    ready: "#22c55e",
    needs_detail: "#eab308",
    too_big: "#ef4444",
    not_feasible: "#6b7280",
  };
  const labels: Record<TriageVerdict, string> = {
    ready: "READY",
    needs_detail: "NEEDS DETAIL",
    too_big: "TOO BIG",
    not_feasible: "NOT FEASIBLE",
  };
  const bg = colors[verdict];
  return `<span style="display:inline-block;padding:2px 10px;border-radius:12px;background:${bg};color:#fff;font-size:0.85em;font-weight:600;">${labels[verdict]}</span>`;
}

// --- Triage discovery ---

async function discoverTriageReports(triageDir: string): Promise<TriageEntry[]> {
  if (!existsSync(triageDir)) return [];

  const glob = new Glob("*.json");
  const entries: TriageEntry[] = [];

  for await (const path of glob.scan({ cwd: triageDir })) {
    const fullPath = join(triageDir, path);
    try {
      const report = await Bun.file(fullPath).json();
      entries.push({
        key: report.issue.key,
        title: report.issue.title,
        score: `${report.result.total}/${report.result.max}`,
        size: report.result.size,
        verdict: report.verdict,
        confidence: report.confidence ?? "—",
        date: report.timestamp,
      });
    } catch {
      // skip malformed files
    }
  }

  entries.sort((a, b) => (b.date > a.date ? 1 : b.date < a.date ? -1 : 0));
  return entries;
}

// --- Triage listing page ---

function renderTriageListing(entries: TriageEntry[]): string {
  if (entries.length === 0) {
    return pageShell("Triage", "<h1>Heimdall Triage Reports</h1><p>No triage reports found.</p>", "triage");
  }

  let rows = "";
  for (const e of entries) {
    rows += `<tr>
  <td><a href="/triage/${e.key}">${e.key}</a></td>
  <td>${escapeHtml(e.title)}</td>
  <td>${e.score}</td>
  <td>${e.size}</td>
  <td>${triageVerdictBadge(e.verdict)}</td>
  <td>${e.confidence}</td>
  <td>${e.date ? new Date(e.date).toLocaleDateString() : ""}</td>
</tr>\n`;
  }

  const body = `<h1>Heimdall Triage Reports</h1>
<table>
<tr><th>Issue</th><th>Title</th><th>Score</th><th>Size</th><th>Verdict</th><th>Confidence</th><th>Date</th></tr>
${rows}
</table>`;

  return pageShell("Triage", body, "triage");
}

// --- Single triage detail page ---

async function renderTriageDetail(
  triageDir: string,
  issueKey: string,
  queueDir: string,
  error?: string | null
): Promise<string | null> {
  const mdPath = join(triageDir, `${issueKey}.md`);
  if (!existsSync(mdPath)) return null;

  const content = await Bun.file(mdPath).text();

  const jsonPath = join(triageDir, `${issueKey}.json`);
  let verdict: TriageVerdict = "not_feasible";
  let jiraUrl = "";
  let confidence = "";
  if (existsSync(jsonPath)) {
    const report = await Bun.file(jsonPath).json();
    verdict = report.verdict;
    jiraUrl = report.issue?.url || "";
    confidence = report.confidence ?? "";
  }

  const html = markdownToHtml(content);

  const header = `<div class="back"><a href="/triage">&larr; All Triage Reports</a></div>
<div style="display:flex;align-items:center;gap:1em;margin-bottom:1em;">
  ${triageVerdictBadge(verdict)}
  ${jiraUrl ? `<a href="${jiraUrl}" target="_blank">Open in Jira &rarr;</a>` : ""}
</div>`;

  const errorBanner = error
    ? `<div class="error-banner">${escapeHtml(
        error === "no-report" ? "No triage report found."
          : error === "not-ready" ? "Verdict is not ready — cannot approve."
          : error === "no-config" ? "No project config found. Check config.json."
          : error
      )}</div>`
    : "";

  // Check queue status
  const queuePath = join(queueDir, `${issueKey}.json`);
  let queueStatus: string | null = null;
  let prUrl: string | null = null;
  if (existsSync(queuePath)) {
    const queueItem = await Bun.file(queuePath).json();
    queueStatus = queueItem.status;
    prUrl = queueItem.prUrl || null;
  }

  let stickyBar = "";
  if (queueStatus) {
    const statusText = queueStatus === "completed" && prUrl
      ? `Completed &mdash; <a href="${prUrl}" target="_blank">Open PR &rarr;</a>`
      : queueStatus === "in_progress"
        ? "In progress&hellip;"
        : `Queued (${queueStatus})`;
    const retryBtn = queueStatus === "failed"
      ? `<form method="POST" action="/queue/${issueKey}/reset" style="display:inline;margin-left:8px;"><button type="submit" class="btn btn-primary">Retry</button></form>`
      : "";
    stickyBar = `<div class="sticky-bar"><span>${triageVerdictBadge(verdict)} ${confidence ? `&middot; ${confidence} confidence` : ""}</span><span>${statusText}${retryBtn}</span></div><div class="sticky-bar-spacer"></div>`;
  } else if (verdict === "ready") {
    stickyBar = `<div class="sticky-bar"><span>${triageVerdictBadge(verdict)} ${confidence ? `&middot; ${confidence} confidence` : ""}</span><form method="POST" action="/triage/${issueKey}/approve"><button type="submit" class="btn btn-primary">Approve</button></form></div><div class="sticky-bar-spacer"></div>`;
  }

  return pageShell(`Triage — ${issueKey}`, header + errorBanner + html + stickyBar, "triage");
}

// --- Dashboard page ---

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
  const { QueueManager } = await import("./queue");
  const queueManager = new QueueManager(queueDir);
  const queueItems = await queueManager.list();
  const inProgress = queueItems.find((i) => i.status === "in_progress");
  const pendingCount = queueItems.filter((i) => i.status === "pending").length;

  let workerText = `<span class="status-dot ${statusDotClass}"></span>Worker: ${statusLabel}`;
  if (worker.state === "active" && inProgress) {
    const elapsed = Math.floor((Date.now() - new Date(inProgress.approvedAt).getTime()) / 60_000);
    workerText = `<span class="status-dot status-active"></span>Worker: <a href="/triage/${inProgress.issueKey}">${inProgress.issueKey}</a> (${elapsed}m)`;
  }

  // Queue summary (pending, in_progress, failed)
  const activeItems = queueItems.filter((i) => i.status === "pending" || i.status === "in_progress" || i.status === "failed");
  let queueRows = "";
  for (const item of activeItems.slice(0, 5)) {
    const statusColors: Record<string, string> = { in_progress: "#eab308", pending: "#8b949e", failed: "#ef4444" };
    const statusColor = statusColors[item.status] ?? "#8b949e";
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

<div style="color:#8b949e;font-size:0.85em;margin-bottom:4px;margin-top:1.5em;">Recent</div>
${activities.length > 0
    ? `<table><tr><th>Activity</th><th>Date</th></tr>${activityRows}</table>`
    : `<p style="color:#8b949e;">No recent activity.</p>`}`;

  return pageShell("Dashboard", body, "dashboard");
}

// --- Queue page ---

async function renderQueuePage(queueDir: string, heimdallDir: string): Promise<string> {
  const worker = getWorkerStatus(heimdallDir);
  const statusDotClass = worker.state === "active" ? "status-active" : worker.state === "idle" ? "status-idle" : "status-dead";
  const statusLabel = worker.state === "active" ? "active" : worker.state === "idle" ? "idle" : "dead (stale heartbeat)";

  const { QueueManager } = await import("./queue");
  const queueManager = new QueueManager(queueDir);
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
    const resetBtn = item.status === "failed"
      ? `<form method="POST" action="/queue/${item.issueKey}/reset" style="display:inline;"><button type="submit" class="btn" style="background:#6b7280;color:#fff;font-size:0.8em;padding:2px 8px;">Reset</button></form>`
      : "";
    rows += `<tr>
  <td><a href="/triage/${item.issueKey}">${item.issueKey}</a></td>
  <td>${escapeHtml(item.title)}</td>
  <td><span class="badge" style="background:${bg}">${item.status}</span> ${resetBtn}</td>
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

// --- Route matching ---

function matchRoute(pathname: string): { owner: string; repo: string; number: number } | null {
  const m = pathname.match(/^\/reviews\/([^/]+)\/([^/]+)\/PR-(\d+)$/);
  if (!m) return null;
  return { owner: m[1], repo: m[2], number: parseInt(m[3], 10) };
}

function matchTriageRoute(pathname: string): string | null {
  const m = pathname.match(/^\/triage\/([A-Z]+-\d+)$/);
  return m ? m[1] : null;
}

// --- Server ---

export function startServer(config: HeimdallConfig, logger: Logger, opts?: { configPath?: string; heimdallDir?: string }) {
  const reportsDir = resolveHomePath(config.reports.dir);
  const heimdallDir = opts?.heimdallDir ?? resolveHomePath(HEIMDALL_DIR);
  const triageDir = join(heimdallDir, "triage");
  const queueDir = join(heimdallDir, "queue");

  const server = Bun.serve({
    port: config.server.port,
    async fetch(req) {
      const url = new URL(req.url);
      const { pathname } = url;

      // GET / -> dashboard
      if (pathname === "/") {
        const html = await renderDashboard(triageDir, reportsDir, queueDir, heimdallDir);
        return new Response(html, {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }

      // GET /reviews -> listing
      if (pathname === "/reviews") {
        const entries = await discoverReviews(reportsDir);
        const html = renderListing(entries);
        return new Response(html, {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }

      // GET /reviews/:owner/:repo/PR-:number -> single review
      const reviewParams = matchRoute(pathname);
      if (reviewParams) {
        const html = await renderReview(reportsDir, reviewParams.owner, reviewParams.repo, reviewParams.number);
        if (!html) {
          return new Response("Not Found", { status: 404 });
        }
        return new Response(html, {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }

      // GET /triage -> triage listing
      if (pathname === "/triage") {
        const entries = await discoverTriageReports(triageDir);
        const html = renderTriageListing(entries);
        return new Response(html, {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }

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

      // GET /triage/:issueKey -> triage detail
      const triageKey = matchTriageRoute(pathname);
      if (triageKey) {
        const error = url.searchParams.get("error");
        const html = await renderTriageDetail(triageDir, triageKey, queueDir, error);
        if (!html) {
          return new Response("Not Found", { status: 404 });
        }
        return new Response(html, {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }

      // POST /queue/:key/reset
      const resetMatch = pathname.match(/^\/queue\/([A-Z]+-\d+)\/reset$/);
      if (resetMatch && req.method === "POST") {
        const key = resetMatch[1];
        const { QueueManager } = await import("./queue");
        const queueManager = new QueueManager(queueDir);
        const item = await queueManager.get(key);
        if (!item) {
          return new Response(null, { status: 303, headers: { Location: `/queue?error=not-found` } });
        }
        if (item.status !== "failed") {
          return new Response(null, { status: 303, headers: { Location: `/queue?error=not-failed` } });
        }

        // Clean up worktree + local branch
        if (item.branch && item.cwd) {
          const worktreePath = join(resolveHomePath(HEIMDALL_DIR), "worktrees", key);
          Bun.spawn(["rm", "-rf", worktreePath], { stdout: "pipe", stderr: "pipe" });
          const prune = Bun.spawn(["git", "worktree", "prune"], { cwd: item.cwd, stdout: "pipe", stderr: "pipe" });
          await prune.exited;
          const del = Bun.spawn(["git", "branch", "-D", item.branch], { cwd: item.cwd, stdout: "pipe", stderr: "pipe" });
          await del.exited;
        }

        await queueManager.update(key, { status: "pending", branch: undefined, prUrl: undefined, error: undefined } as any);
        logger.info(`Reset queue item ${key} to pending from web UI`);
        return new Response(null, { status: 303, headers: { Location: "/queue" } });
      }

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
          // Detect compiled binary vs bun script to spawn worker correctly
          const scriptArg = process.argv[1];
          const isScript = scriptArg?.endsWith(".ts") || scriptArg?.endsWith(".js");
          const workerArgs = isScript
            ? [process.execPath, scriptArg, "worker"]
            : [process.execPath, "worker"];
          Bun.spawn(workerArgs, { stdout: "ignore", stderr: "ignore" });
          logger.info("Worker started from web UI");
        }
        return new Response(null, {
          status: 303,
          headers: { Location: "/queue" },
        });
      }

      // 404
      return new Response("Not Found", { status: 404 });
    },
  });

  logger.info(`Heimdall web server listening on http://localhost:${config.server.port}`);
  return server;
}
