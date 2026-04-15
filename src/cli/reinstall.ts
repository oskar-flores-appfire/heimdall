import { join, dirname } from "path";
import { PLIST_PATH } from "./install";
import { existsSync } from "fs";

export async function reinstall(): Promise<void> {
  // 1. Stop if running
  if (existsSync(PLIST_PATH)) {
    Bun.spawnSync(["launchctl", "unload", PLIST_PATH]);
    console.log("Stopped existing daemon.");
  }

  // 2. Rebuild
  // When running as compiled binary, import.meta.dir is "/", so derive
  // project root from the executable path (dist/heimdall -> project root)
  const projectRoot = existsSync(join(import.meta.dir, "build.ts"))
    ? import.meta.dir
    : join(dirname(process.execPath), "..");
  const buildScript = join(projectRoot, "build.ts");
  console.log("Building...");
  const build = Bun.spawnSync(["bun", "run", buildScript], { cwd: projectRoot });
  if (build.exitCode !== 0) {
    console.error("Build failed:", new TextDecoder().decode(build.stderr));
    process.exit(1);
  }
  console.log("Built: ./dist/heimdall");

  // 3. Reinstall
  const { install } = await import("./install");
  await install();
}
