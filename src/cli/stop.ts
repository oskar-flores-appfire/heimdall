import { PLIST_PATH } from "./install";

export async function stop(): Promise<void> {
  const proc = Bun.spawnSync(["launchctl", "unload", PLIST_PATH]);
  if (proc.exitCode === 0) {
    console.log("Heimdall stopped.");
  } else {
    console.error("Failed to stop:", new TextDecoder().decode(proc.stderr));
  }
}
