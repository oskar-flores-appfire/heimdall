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
    issueType: report.issue.issueType,
  };

  await queue.enqueue(item);
  return { ok: true };
}
