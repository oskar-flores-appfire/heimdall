import { resolveHomePath } from "../config";
import { existsSync } from "fs";

export async function logs(): Promise<void> {
  const logFile = resolveHomePath("~/.heimdall/heimdall.log");
  if (!existsSync(logFile)) {
    console.log("No log file yet. Run: heimdall run");
    return;
  }

  const proc = Bun.spawn(["tail", "-f", "-n", "50", logFile], {
    stdout: "inherit",
    stderr: "inherit",
  });
  await proc.exited;
}
