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
