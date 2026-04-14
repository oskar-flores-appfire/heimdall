import { homedir } from "os";
import { join, dirname } from "path";
import { existsSync } from "fs";
import { loadConfig, resolveHomePath } from "../config";

const PLIST_NAME = "com.heimdall.watcher";
const PLIST_DIR = join(homedir(), "Library", "LaunchAgents");
export const PLIST_PATH = join(PLIST_DIR, `${PLIST_NAME}.plist`);
export { PLIST_NAME };

function generatePlist(programArgs: string[], logPath: string, interval: number): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${PLIST_NAME}</string>
  <key>ProgramArguments</key>
  <array>
${programArgs.map(a => `    <string>${a}</string>`).join("\n")}
  </array>
  <key>StartInterval</key>
  <integer>${interval}</integer>
  <key>StandardOutPath</key>
  <string>${logPath}</string>
  <key>StandardErrorPath</key>
  <string>${logPath}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
</dict>
</plist>`;
}

export async function install(): Promise<void> {
  const config = await loadConfig();
  const logPath = resolveHomePath(config.log.file);

  const projectRoot = existsSync(join(dirname(process.execPath), "..", "build.ts"))
    ? join(dirname(process.execPath), "..")
    : join(import.meta.dir, "..", "..");
  const distBinary = join(projectRoot, "dist", "heimdall");
  let programArgs: string[];

  if (existsSync(distBinary)) {
    programArgs = [distBinary, "run"];
  } else {
    const bunPath = Bun.spawnSync(["which", "bun"]).stdout.toString().trim();
    const scriptPath = join(projectRoot, "src", "index.ts");
    programArgs = [bunPath, "run", scriptPath, "run"];
  }

  const plistContent = generatePlist(programArgs, logPath, config.interval);
  await Bun.write(PLIST_PATH, plistContent);
  console.log(`Plist written to ${PLIST_PATH}`);

  const proc = Bun.spawnSync(["launchctl", "load", PLIST_PATH]);
  if (proc.exitCode === 0) {
    console.log(`Heimdall installed and loaded. Polling every ${config.interval}s.`);
  } else {
    console.error("Failed to load plist:", new TextDecoder().decode(proc.stderr));
  }
}
