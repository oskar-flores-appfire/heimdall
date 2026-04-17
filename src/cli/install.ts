import { homedir } from "os";
import { join } from "path";
import { loadConfig, resolveHomePath } from "../config";

const PLIST_NAME = "com.heimdall.watcher";
const PLIST_DIR = join(homedir(), "Library", "LaunchAgents");
export const PLIST_PATH = join(PLIST_DIR, `${PLIST_NAME}.plist`);
export { PLIST_NAME };

// Env vars to forward from the installing shell into the launchd plist.
// Captures PATH, SSL certs (corporate proxies), and common API keys.
const FORWARDED_ENV_KEYS = [
  "PATH",
  "HOME",
  "NODE_EXTRA_CA_CERTS",
  "REQUESTS_CA_BUNDLE",
  "SSL_CERT_FILE",
  "ANTHROPIC_API_KEY",
  "GITHUB_TOKEN",
];

function buildEnvDict(): string {
  const entries: string[] = [];
  for (const key of FORWARDED_ENV_KEYS) {
    const value = process.env[key];
    if (value) {
      entries.push(`    <key>${key}</key>\n    <string>${value}</string>`);
    }
  }
  // Always ensure a usable PATH even if not in current env
  if (!process.env.PATH) {
    entries.push(`    <key>PATH</key>\n    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>`);
  }
  return entries.join("\n");
}

function generatePlist(programArgs: string[], logPath: string): string {
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
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${logPath}</string>
  <key>StandardErrorPath</key>
  <string>${logPath}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>EnvironmentVariables</key>
  <dict>
${buildEnvDict()}
  </dict>
</dict>
</plist>`;
}

export async function install(): Promise<void> {
  const config = await loadConfig();
  const logPath = resolveHomePath(config.log.file);

  const isCompiled = !process.execPath.endsWith("bun");
  let programArgs: string[];

  if (isCompiled) {
    programArgs = [process.execPath, "run"];
  } else {
    const entryPoint = join(import.meta.dir, "..", "index.ts");
    programArgs = [process.execPath, entryPoint, "run"];
  }

  const plistContent = generatePlist(programArgs, logPath);
  await Bun.write(PLIST_PATH, plistContent);
  console.log(`Plist written to ${PLIST_PATH}`);

  const proc = Bun.spawnSync(["launchctl", "load", PLIST_PATH]);
  if (proc.exitCode === 0) {
    console.log(`Heimdall installed and loaded. Persistent mode with web server.`);
  } else {
    console.error("Failed to load plist:", new TextDecoder().decode(proc.stderr));
  }
}
