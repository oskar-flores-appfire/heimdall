import type { Logger } from "./logger";
import { resolveSecret } from "./config";
import type { JiraSourceConfig } from "./types";

export interface ReferencedDoc {
  url: string;
  title: string;
  content: string;
}

const MAX_DOC_CHARS = 10_000;
const FETCH_TIMEOUT_MS = 15_000;

const CONFLUENCE_PAGE_RE =
  /^https:\/\/([^/]+)\.atlassian\.net\/wiki\/.*\/pages\/(\d+)/;

const GITHUB_RAW_RE =
  /^https:\/\/(?:raw\.githubusercontent\.com|github\.com)\/([^/]+\/[^/]+)\//;

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function isAllowedUrl(
  url: string,
  confluenceBaseUrl: string,
  allowedRepos: string[]
): boolean {
  // Confluence: must match the configured Jira/Confluence base URL
  const confMatch = url.match(CONFLUENCE_PAGE_RE);
  if (confMatch) {
    const domain = confMatch[1];
    return confluenceBaseUrl.includes(domain);
  }

  // GitHub: must be under a configured repo
  const ghMatch = url.match(GITHUB_RAW_RE);
  if (ghMatch) {
    const repo = ghMatch[1];
    return allowedRepos.some((r) => r === repo);
  }

  return false;
}

async function fetchConfluencePage(
  url: string,
  baseUrl: string,
  email: string,
  apiToken: string,
  logger: Logger
): Promise<ReferencedDoc | null> {
  const match = url.match(CONFLUENCE_PAGE_RE);
  if (!match) return null;
  const pageId = match[2];

  const apiUrl = `${baseUrl}/wiki/rest/api/content/${pageId}?expand=body.view,title`;
  const auth = btoa(`${email}:${apiToken}`);

  try {
    const res = await fetch(apiUrl, {
      headers: { Authorization: `Basic ${auth}`, Accept: "application/json" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (!res.ok) {
      logger.warn(`Confluence fetch failed for ${pageId}: ${res.status}`);
      return null;
    }

    const data = await res.json();
    const title = data.title || `Page ${pageId}`;
    const html = data.body?.view?.value || "";
    let content = stripHtml(html);
    if (content.length > MAX_DOC_CHARS) {
      content = content.slice(0, MAX_DOC_CHARS) + "\n\n[...truncated]";
    }

    return { url, title, content };
  } catch (err) {
    logger.warn(`Confluence fetch error for ${pageId}: ${err}`);
    return null;
  }
}

async function fetchGitHubDoc(
  url: string,
  logger: Logger
): Promise<ReferencedDoc | null> {
  // Convert github.com blob URLs to raw
  let rawUrl = url;
  if (url.includes("github.com")) {
    rawUrl = url
      .replace("github.com", "raw.githubusercontent.com")
      .replace("/blob/", "/");
  }

  try {
    const res = await fetch(rawUrl, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (!res.ok) {
      logger.warn(`GitHub doc fetch failed for ${url}: ${res.status}`);
      return null;
    }

    let content = await res.text();
    const title = url.split("/").pop() || "GitHub document";
    if (content.length > MAX_DOC_CHARS) {
      content = content.slice(0, MAX_DOC_CHARS) + "\n\n[...truncated]";
    }

    return { url, title, content };
  } catch (err) {
    logger.warn(`GitHub doc fetch error for ${url}: ${err}`);
    return null;
  }
}

export async function fetchReferencedDocs(
  urls: string[],
  jiraConfig: JiraSourceConfig,
  logger: Logger
): Promise<ReferencedDoc[]> {
  const allowedRepos = Object.values(jiraConfig.projects).map((p) => p.repo);
  const token = resolveSecret(jiraConfig.apiToken);

  const docs: ReferencedDoc[] = [];

  for (const url of urls) {
    if (!isAllowedUrl(url, jiraConfig.baseUrl, allowedRepos)) {
      logger.info(`Skipping disallowed reference URL: ${url}`);
      continue;
    }

    let doc: ReferencedDoc | null = null;

    if (CONFLUENCE_PAGE_RE.test(url)) {
      doc = await fetchConfluencePage(
        url,
        jiraConfig.baseUrl,
        jiraConfig.email,
        token,
        logger
      );
    } else if (GITHUB_RAW_RE.test(url)) {
      doc = await fetchGitHubDoc(url, logger);
    }

    if (doc) {
      docs.push(doc);
      logger.info(`Fetched reference doc: ${doc.title} (${doc.content.length} chars)`);
    }
  }

  return docs;
}
