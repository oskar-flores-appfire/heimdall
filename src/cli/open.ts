import { existsSync, readdirSync } from "fs";
import { join } from "path";
import { loadConfig, resolveHomePath } from "../config";
import type { HeimdallConfig } from "../types";

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

function getKnownRepos(config: HeimdallConfig): string[] {
  const repos = new Set<string>();
  for (const src of config.sources) {
    if (src.type === "github") {
      for (const r of src.repos) repos.add(r);
    }
  }
  for (const r of Object.keys(config.actions.review.repos)) {
    repos.add(r);
  }
  return [...repos];
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

function findReviewAcrossRepos(reportsDir: string, prNumber: string, candidates: string[]): string[] {
  const matches: string[] = [];
  for (const repo of candidates) {
    const reportPath = join(reportsDir, repo, `PR-${prNumber}.md`);
    if (existsSync(reportPath)) matches.push(repo);
  }
  return matches;
}

export async function open(): Promise<void> {
  const rawArgs = process.argv.slice(3);
  let explicitRepo: string | null = null;
  let prNumber: string | undefined;

  for (let i = 0; i < rawArgs.length; i++) {
    if (rawArgs[i] === "--repo" && rawArgs[i + 1]) {
      explicitRepo = rawArgs[++i];
    } else if (!prNumber) {
      prNumber = rawArgs[i];
    }
  }

  if (!prNumber || isNaN(parseInt(prNumber))) {
    console.error("Usage: heimdall open <pr-number> [--repo owner/repo]");
    process.exit(1);
  }

  const config = await loadConfig();
  const reportsDir = resolveHomePath(config.reports.dir);

  // If --repo flag provided, use it directly
  if (explicitRepo) {
    const reportPath = join(reportsDir, explicitRepo, `PR-${prNumber}.md`);
    if (!existsSync(reportPath)) {
      console.error(`No review found for PR #${prNumber} in ${explicitRepo}`);
      process.exit(1);
    }
    const url = `http://localhost:${config.server.port}/reviews/${explicitRepo}/PR-${prNumber}`;
    Bun.spawn(["open", url]);
    console.log(`Opening ${url}`);
    return;
  }

  // 1. Try current git repo first
  const currentRepo = detectRepo();
  if (currentRepo) {
    const reportPath = join(reportsDir, currentRepo, `PR-${prNumber}.md`);
    if (existsSync(reportPath)) {
      const url = `http://localhost:${config.server.port}/reviews/${currentRepo}/PR-${prNumber}`;
      Bun.spawn(["open", url]);
      console.log(`Opening ${url}`);
      return;
    }
  }

  // 2. Search config-known repos + reports dir
  const knownRepos = getKnownRepos(config);
  const diskRepos = listAvailableRepos(reportsDir);
  const allCandidates = [...new Set([...knownRepos, ...diskRepos])];
  const matches = findReviewAcrossRepos(reportsDir, prNumber, allCandidates);

  if (matches.length === 1) {
    const url = `http://localhost:${config.server.port}/reviews/${matches[0]}/PR-${prNumber}`;
    Bun.spawn(["open", url]);
    console.log(`Opening ${url}`);
    return;
  }

  if (matches.length > 1) {
    console.error(`PR #${prNumber} found in multiple repos:`);
    for (const repo of matches) {
      console.error(`  ${repo}`);
    }
    console.error(`\nRe-run with: heimdall open ${prNumber} --repo <owner/repo>`);
    process.exit(1);
  }

  // No matches
  const where = currentRepo ? `in ${currentRepo} or any configured repo` : "in any configured repo";
  console.error(`No review found for PR #${prNumber} ${where}`);
  const available = listAvailableRepos(reportsDir);
  if (available.length > 0) {
    console.error(`\nRepos with reviews:\n${available.map(r => `  ${r}`).join("\n")}`);
  }
  process.exit(1);
}
