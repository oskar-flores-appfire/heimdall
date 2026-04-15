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
      await state.markKey(namespace, issue.key);
    }
  }

  logger.info("Jira cycle completed");
}
