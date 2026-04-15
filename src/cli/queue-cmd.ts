import { resolveHomePath, HEIMDALL_DIR } from "../config";
import { QueueManager } from "../queue";

const STATUS_ICONS: Record<string, string> = {
  pending: "⏳",
  in_progress: "⚡",
  completed: "✅",
  failed: "❌",
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
