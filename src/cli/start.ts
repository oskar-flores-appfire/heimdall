import { PLIST_PATH } from "./install";
import { existsSync } from "fs";

export async function start(): Promise<void> {
  if (!existsSync(PLIST_PATH)) {
    console.error("Heimdall not installed. Run: heimdall install");
    process.exit(1);
  }
  const proc = Bun.spawnSync(["launchctl", "load", PLIST_PATH]);
  if (proc.exitCode === 0) {
    console.log("Heimdall started.");
  } else {
    console.error("Failed to start:", new TextDecoder().decode(proc.stderr));
  }
}
