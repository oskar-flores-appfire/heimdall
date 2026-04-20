import { existsSync } from "fs";
import { join } from "path";
import { HEIMDALL_DIR, resolveHomePath } from "../config";
import type { TriageReport } from "../types";

export async function triage(): Promise<void> {
  const issueKey = process.argv[3];
  if (!issueKey) {
    console.error("Usage: heimdall triage <ISSUE-KEY>");
    process.exit(1);
  }

  const reportDir = join(resolveHomePath(HEIMDALL_DIR), "triage");
  const mdPath = join(reportDir, `${issueKey}.md`);
  const jsonPath = join(reportDir, `${issueKey}.json`);

  if (!existsSync(mdPath)) {
    console.error(`No triage report found for ${issueKey}`);
    console.error(`Expected: ${mdPath}`);
    process.exit(1);
  }

  // Display the report
  const bat = Bun.spawnSync(["which", "bat"]);
  const viewer = bat.exitCode === 0 ? "bat" : "cat";
  const proc = Bun.spawn([viewer, mdPath], {
    stdout: "inherit",
    stderr: "inherit",
  });
  await proc.exited;

  // Check verdict from JSON report
  if (existsSync(jsonPath)) {
    const report: TriageReport = await Bun.file(jsonPath).json();

    if (report.verdict !== "ready") {
      console.log(`\nVerdict: ${report.verdict.toUpperCase()} — not eligible for approval.`);
      process.exit(0);
    }

    if (report.confidence === "low") {
      console.log(`\nVerdict: READY but confidence is LOW — review recommended before approval.`);
    }
  }

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
