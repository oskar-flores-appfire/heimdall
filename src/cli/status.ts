import { PLIST_NAME } from "./install";
import { resolveHomePath } from "../config";
import { existsSync } from "fs";

export async function status(): Promise<void> {
  const proc = Bun.spawnSync(["launchctl", "list", PLIST_NAME]);
  const isRunning = proc.exitCode === 0;

  console.log(`Heimdall: ${isRunning ? "RUNNING" : "STOPPED"}`);

  const reviewsDir = resolveHomePath("~/.heimdall/reviews");
  if (existsSync(reviewsDir)) {
    const glob = new Bun.Glob("**/*.md");
    const files: string[] = [];
    for await (const file of glob.scan(reviewsDir)) {
      files.push(file);
    }
    files.sort().reverse();
    const recent = files.slice(0, 5);
    if (recent.length > 0) {
      console.log(`\nRecent reviews (${files.length} total):`);
      for (const f of recent) {
        console.log(`  ${f}`);
      }
    }
  }

  const logFile = resolveHomePath("~/.heimdall/heimdall.log");
  if (existsSync(logFile)) {
    console.log("\nRecent logs:");
    const proc = Bun.spawnSync(["tail", "-n", "5", logFile]);
    const output = new TextDecoder().decode(proc.stdout);
    for (const line of output.trim().split("\n")) {
      console.log(`  ${line}`);
    }
  }
}
