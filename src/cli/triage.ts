import { existsSync } from "fs";
import { join } from "path";
import { HEIMDALL_DIR, resolveHomePath } from "../config";

export async function triage(): Promise<void> {
  const issueKey = process.argv[3];
  if (!issueKey) {
    console.error("Usage: heimdall triage <ISSUE-KEY>");
    process.exit(1);
  }

  const reportPath = join(resolveHomePath(HEIMDALL_DIR), "triage", `${issueKey}.md`);
  if (!existsSync(reportPath)) {
    console.error(`No triage report found for ${issueKey}`);
    console.error(`Expected: ${reportPath}`);
    process.exit(1);
  }

  const bat = Bun.spawnSync(["which", "bat"]);
  const viewer = bat.exitCode === 0 ? "bat" : "cat";
  const proc = Bun.spawn([viewer, reportPath], {
    stdout: "inherit",
    stderr: "inherit",
  });
  await proc.exited;

  process.stdout.write(`\nApprove ${issueKey} for Heimdall? [y/n]: `);
  const reader = Bun.stdin.stream().getReader();
  const { value } = await reader.read();
  reader.releaseLock();
  const answer = new TextDecoder().decode(value).trim().toLowerCase();

  if (answer === "y" || answer === "yes") {
    const { approve } = await import("./approve");
    process.argv[3] = issueKey;
    await approve();
  } else {
    console.log("Skipped.");
  }
}
