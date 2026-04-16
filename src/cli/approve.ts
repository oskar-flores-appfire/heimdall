import { existsSync } from "fs";
import { join } from "path";
import { HEIMDALL_DIR, resolveHomePath, loadConfig } from "../config";
import { QueueManager } from "../queue";
import type { QueueItem, TriageReport, JiraSourceConfig, JiraProjectConfig } from "../types";

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
    console.error(`No project mapping found for ${project}. Check config.json sources.`);
    process.exit(1);
  }

  const queueDir = join(heimdallDir, "queue");
  const queue = new QueueManager(queueDir);

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
    repo: projectConfig.repo,
    cwd: resolveHomePath(projectConfig.cwd),
    systemPromptFile: projectConfig.systemPromptFile,
    allowedTools: projectConfig.allowedTools,
  };

  await queue.enqueue(item);
  console.log(`${issueKey} queued for implementation.`);
}
