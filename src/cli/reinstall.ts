import { PLIST_PATH } from "./install";
import { existsSync } from "fs";

export async function reinstall(): Promise<void> {
  // 1. Stop if running
  if (existsSync(PLIST_PATH)) {
    Bun.spawnSync(["launchctl", "unload", PLIST_PATH]);
    console.log("Stopped existing daemon.");
  }

  // 2. Reinstall plist (picks up any code/config changes)
  const { install } = await import("./install");
  await install();
}
