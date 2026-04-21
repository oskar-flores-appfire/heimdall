import { Glob } from "bun";
import { join } from "path";
import { existsSync } from "fs";
import { marked } from "marked";
import type { HeimdallConfig, ReviewVerdict, TriageVerdict } from "./types";
import type { Logger } from "./logger";
import { parseVerdict } from "./verdict";
import { resolveHomePath, HEIMDALL_DIR } from "./config";

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

function pageShell(title: string, body: string): string {
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
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
    line-height: 1.6;
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
</style>
</head>
<body>
<article>
${body}
</article>
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
    return pageShell("Reviews", "<h1>Heimdall Reviews</h1><p>No reviews found.</p>");
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

  return pageShell("Reviews", body);
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

  return pageShell(`PR-${number} — ${owner}/${repo}`, header + html);
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
    return pageShell("Triage", "<h1>Heimdall Triage Reports</h1><p>No triage reports found.</p>");
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

  return pageShell("Triage", body);
}

// --- Single triage detail page ---

async function renderTriageDetail(
  triageDir: string,
  issueKey: string
): Promise<string | null> {
  const mdPath = join(triageDir, `${issueKey}.md`);
  if (!existsSync(mdPath)) return null;

  const content = await Bun.file(mdPath).text();

  const jsonPath = join(triageDir, `${issueKey}.json`);
  let verdict: TriageVerdict = "not_feasible";
  let jiraUrl = "";
  if (existsSync(jsonPath)) {
    const report = await Bun.file(jsonPath).json();
    verdict = report.verdict;
    jiraUrl = report.issue?.url || "";
  }

  const html = markdownToHtml(content);

  const header = `<div class="back"><a href="/triage">&larr; All Triage Reports</a></div>
<div style="display:flex;align-items:center;gap:1em;margin-bottom:1em;">
  ${triageVerdictBadge(verdict)}
  ${jiraUrl ? `<a href="${jiraUrl}" target="_blank">Open in Jira &rarr;</a>` : ""}
</div>`;

  return pageShell(`Triage — ${issueKey}`, header + html);
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

export function startServer(config: HeimdallConfig, logger: Logger) {
  const reportsDir = resolveHomePath(config.reports.dir);
  const triageDir = resolveHomePath(`${HEIMDALL_DIR}/triage`);

  const server = Bun.serve({
    port: config.server.port,
    async fetch(req) {
      const url = new URL(req.url);
      const { pathname } = url;

      // GET / -> redirect to /reviews
      if (pathname === "/") {
        return new Response(null, {
          status: 302,
          headers: { Location: "/reviews" },
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

      // GET /triage/:issueKey -> triage detail
      const triageKey = matchTriageRoute(pathname);
      if (triageKey) {
        const html = await renderTriageDetail(triageDir, triageKey);
        if (!html) {
          return new Response("Not Found", { status: 404 });
        }
        return new Response(html, {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }

      // 404
      return new Response("Not Found", { status: 404 });
    },
  });

  logger.info(`Heimdall web server listening on http://localhost:${config.server.port}`);
  return server;
}
