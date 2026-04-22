#!/usr/bin/env bun
/**
 * Reset a failed/completed queue item so the worker picks it up again.
 * Cleans up: queue status, local branch, worktree, remote branch (optional).
 * Usage: bun run reset:issue <issue-key> [--remote]
 * Example: bun run reset:issue ITRE-160 --remote
 */
import { existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const HEIMDALL_DIR = join(homedir(), ".heimdall");
const QUEUE_DIR = join(HEIMDALL_DIR, "queue");

const args = process.argv.slice(2);
const issueKey = args.find((a) => !a.startsWith("--"));
const deleteRemote = args.includes("--remote");

if (!issueKey) {
  console.error("Usage: bun run reset:issue <issue-key> [--remote]");
  console.error("Example: bun run reset:issue ITRE-160 --remote");
  process.exit(1);
}

// Load queue item
const queuePath = join(QUEUE_DIR, `${issueKey}.json`);
if (!existsSync(queuePath)) {
  console.error(`No queue item found: ${queuePath}`);
  process.exit(1);
}

const item = await Bun.file(queuePath).json();
const branch = item.branch;
const cwd = item.cwd;

console.log(`Resetting ${issueKey} (status: ${item.status})`);

// 1. Clean up worktree
const worktreePath = join(HEIMDALL_DIR, "worktrees", issueKey);
if (existsSync(worktreePath)) {
  const rm = Bun.spawn(["rm", "-rf", worktreePath], { stdout: "pipe", stderr: "pipe" });
  await rm.exited;
  console.log(`Removed worktree: ${worktreePath}`);
}

// 2. Prune stale worktree refs + delete local branch
if (cwd && branch) {
  const prune = Bun.spawn(["git", "worktree", "prune"], { cwd, stdout: "pipe", stderr: "pipe" });
  await prune.exited;

  const delBranch = Bun.spawn(["git", "branch", "-D", branch], { cwd, stdout: "pipe", stderr: "pipe" });
  const [exitCode, , stderr] = await Promise.all([
    delBranch.exited,
    new Response(delBranch.stdout).text(),
    new Response(delBranch.stderr).text(),
  ]);
  if (exitCode === 0) {
    console.log(`Deleted local branch: ${branch}`);
  } else if (!stderr.includes("not found")) {
    console.log(`Local branch ${branch} not found (already cleaned)`);
  }

  // 3. Delete remote branch if requested
  if (deleteRemote) {
    const delRemote = Bun.spawn(["git", "push", "origin", "--delete", branch], { cwd, stdout: "pipe", stderr: "pipe" });
    const [remoteExit, , remoteErr] = await Promise.all([
      delRemote.exited,
      new Response(delRemote.stdout).text(),
      new Response(delRemote.stderr).text(),
    ]);
    if (remoteExit === 0) {
      console.log(`Deleted remote branch: origin/${branch}`);
    } else {
      console.log(`Remote branch origin/${branch} not found or already deleted`);
    }
  }
}

// 4. Reset queue item
item.status = "pending";
delete item.branch;
delete item.prUrl;
delete item.error;
await Bun.write(queuePath, JSON.stringify(item, null, 2));
console.log(`Queue item reset to pending`);

console.log(`Done — ${issueKey} will be picked up on next worker cycle`);
