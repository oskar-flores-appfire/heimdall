import { existsSync, readdirSync, rmSync } from "fs";
import { join } from "path";
import { resolveHomePath, HEIMDALL_DIR } from "../config";
import { QueueManager } from "../queue";

export async function clean(): Promise<void> {
  const heimdallDir = resolveHomePath(HEIMDALL_DIR);
  const worktreeDir = join(heimdallDir, "worktrees");

  if (!existsSync(worktreeDir)) {
    console.log("No worktrees directory found.");
    return;
  }

  const entries = readdirSync(worktreeDir);
  if (entries.length === 0) {
    console.log("No worktrees to clean.");
    return;
  }

  const queue = new QueueManager(join(heimdallDir, "queue"));
  let cleaned = 0;

  for (const entry of entries) {
    const worktreePath = join(worktreeDir, entry);
    const queueItem = await queue.get(entry);

    if (!queueItem || queueItem.status === "completed") {
      const proc = Bun.spawn(
        ["git", "worktree", "remove", worktreePath, "--force"],
        { stdout: "pipe", stderr: "pipe" }
      );
      await proc.exited;

      if (existsSync(worktreePath)) {
        rmSync(worktreePath, { recursive: true, force: true });
      }

      if (queueItem?.status === "completed") {
        await queue.remove(entry);
      }

      console.log(`Cleaned: ${entry}`);
      cleaned++;
    } else {
      console.log(`Skipped: ${entry} (status: ${queueItem.status})`);
    }
  }

  console.log(`\nCleaned ${cleaned} worktree(s).`);
}
