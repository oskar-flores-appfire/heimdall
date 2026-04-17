import { existsSync, readdirSync } from "fs";
import { join } from "path";
import { loadConfig, resolveHomePath } from "../config";

function detectRepo(): string | null {
  const proc = Bun.spawnSync(["git", "remote", "get-url", "origin"], { stderr: "pipe" });
  if (proc.exitCode !== 0) return null;

  const url = new TextDecoder().decode(proc.stdout).trim();
  // Handle SSH: git@github.com:owner/repo.git
  const sshMatch = url.match(/git@[^:]+:(.+?)(?:\.git)?$/);
  if (sshMatch) return sshMatch[1];
  // Handle HTTPS: https://github.com/owner/repo.git
  const httpsMatch = url.match(/https?:\/\/[^/]+\/(.+?)(?:\.git)?$/);
  if (httpsMatch) return httpsMatch[1];

  return null;
}

function listAvailableRepos(reportsDir: string): string[] {
  const repos: string[] = [];
  if (!existsSync(reportsDir)) return repos;

  for (const owner of readdirSync(reportsDir, { withFileTypes: true })) {
    if (!owner.isDirectory()) continue;
    for (const repo of readdirSync(join(reportsDir, owner.name), { withFileTypes: true })) {
      if (!repo.isDirectory()) continue;
      repos.push(`${owner.name}/${repo.name}`);
    }
  }
  return repos;
}

export async function open(): Promise<void> {
  const prNumber = process.argv[3];
  if (!prNumber || isNaN(parseInt(prNumber))) {
    console.error("Usage: heimdall open <pr-number>");
    process.exit(1);
  }

  const config = await loadConfig();
  const reportsDir = resolveHomePath(config.reports.dir);
  const repo = detectRepo();

  if (!repo) {
    const available = listAvailableRepos(reportsDir);
    console.error("Not in a git repository.");
    if (available.length > 0) {
      console.error(`\nAvailable repos with reviews:\n${available.map(r => `  ${r}`).join("\n")}`);
    }
    process.exit(1);
  }

  const reportPath = join(reportsDir, repo, `PR-${prNumber}.md`);
  if (!existsSync(reportPath)) {
    console.error(`No review found for PR #${prNumber} in ${repo}`);
    process.exit(1);
  }

  const url = `http://localhost:${config.server.port}/reviews/${repo}/PR-${prNumber}`;
  Bun.spawn(["open", url]);
  console.log(`Opening ${url}`);
}
