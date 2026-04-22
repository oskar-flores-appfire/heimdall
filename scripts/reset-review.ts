#!/usr/bin/env bun
/**
 * Reset a PR review so it gets re-reviewed on the next poll cycle.
 * Usage: bun run reset:review <repo> <pr-number>
 * Example: bun run reset:review appfire-team/signal-iq 79
 */
import { existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const HEIMDALL_DIR = join(homedir(), ".heimdall");
const SEEN_PATH = join(HEIMDALL_DIR, "seen.json");

const [repo, prNum] = process.argv.slice(2);
if (!repo || !prNum) {
  console.error("Usage: bun run reset:review <repo> <pr-number>");
  console.error("Example: bun run reset:review appfire-team/signal-iq 79");
  process.exit(1);
}

// Remove from seen.json
if (!existsSync(SEEN_PATH)) {
  console.log("No seen.json found — nothing to reset");
  process.exit(0);
}

const seen = await Bun.file(SEEN_PATH).json();
const entry = seen[repo]?.[prNum];
if (!entry) {
  console.log(`PR ${repo}#${prNum} not in seen.json — nothing to reset`);
  process.exit(0);
}

delete seen[repo][prNum];
if (Object.keys(seen[repo]).length === 0) delete seen[repo];
await Bun.write(SEEN_PATH, JSON.stringify(seen, null, 2));
console.log(`Removed ${repo}#${prNum} from seen.json`);

// Delete report file if it exists
if (entry.reportPath && existsSync(entry.reportPath)) {
  await Bun.write(entry.reportPath, ""); // truncate
  const { unlinkSync } = await import("fs");
  unlinkSync(entry.reportPath);
  console.log(`Deleted report: ${entry.reportPath}`);
}

console.log(`Done — PR #${prNum} will be re-reviewed on next poll cycle`);
