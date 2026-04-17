import { join } from "path";
import { PLIST_PATH } from "./install";
import { existsSync } from "fs";

export async function reinstall(): Promise<void> {
  const isCompiled = !process.execPath.endsWith("bun");
  if (isCompiled) {
    console.error("reinstall requires source access. Run: bun run src/index.ts reinstall");
    process.exit(1);
  }

  // 1. Stop if running
  if (existsSync(PLIST_PATH)) {
    Bun.spawnSync(["launchctl", "unload", PLIST_PATH]);
    console.log("Stopped existing daemon.");
  }

  // 2. Rebuild
  const projectRoot = join(import.meta.dir, "..", "..");
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
