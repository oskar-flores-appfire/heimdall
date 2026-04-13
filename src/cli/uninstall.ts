import { existsSync, unlinkSync } from "fs";
import { PLIST_PATH, PLIST_NAME } from "./install";

export async function uninstall(): Promise<void> {
  Bun.spawnSync(["launchctl", "unload", PLIST_PATH]);

  if (existsSync(PLIST_PATH)) {
    unlinkSync(PLIST_PATH);
    console.log(`Removed ${PLIST_PATH}`);
  }

  console.log("Heimdall uninstalled.");
}
