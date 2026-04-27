import { existsSync, mkdirSync } from "fs";
import { join } from "path";
import type {
  QueueItem,
  CostConfig,
  ImplementationSummary,
  TriageReport,
  HeimdallConfig,
} from "./types";
import type { Logger } from "./logger";
import { QueueManager } from "./queue";
import { NotifyAction } from "./actions/notify";
import { HEIMDALL_DIR, resolveHomePath } from "./config";
import { writePid, writeHeartbeat, clearHeartbeatFiles } from "./heartbeat";
import { spawnClaude } from "./claude";

// --- Pure utility functions (tested) ---

export function calculateCost(
  inputTokens: number,
  outputTokens: number,
  costs: CostConfig,
  model: string
): number {
  const pricing = costs[model];
  if (!pricing) return 0;
  return (inputTokens / 1000) * pricing.inputPer1k + (outputTokens / 1000) * pricing.outputPer1k;
}

export interface StreamJsonResult {
  inputTokens: number;
  outputTokens: number;
  cacheTokens: number;
  result: string;
  costUsd: number;
}

export function parseStreamJson(output: string): StreamJsonResult {
  const result: StreamJsonResult = {
    inputTokens: 0,
    outputTokens: 0,
    cacheTokens: 0,
    result: "",
    costUsd: 0,
  };

  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      if (obj.usage) {
        result.inputTokens = obj.usage.input_tokens || result.inputTokens;
        result.outputTokens = obj.usage.output_tokens || result.outputTokens;
        result.cacheTokens = obj.usage.cache_read_input_tokens || result.cacheTokens;
      }
      if (obj.total_cost_usd) {
        result.costUsd = obj.total_cost_usd;
      }
      if (obj.result) {
        result.result = obj.result;
      }
    } catch {
      // skip non-JSON lines
    }
  }

  return result;
}

export function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}m ${s}s`;
}

export function buildImplementationPrompt(
  item: QueueItem,
  triageContent: string,
  worktreePath: string
): string {
  return `You are implementing Jira issue ${item.issueKey}: ${item.title}

## Requirements
${item.description}

## Triage Analysis
${triageContent}

## Working Directory
${worktreePath}

Follow the workflow defined in your system prompt. Start at Gate 1.`;
}

export interface BranchResolutionInput {
  issueKey: string;
  title: string;
  issueType?: string;
  claudeMd: string | null;
  agentsMd: string | null;
  branches: string[];
}

export function buildBranchResolutionPrompt(input: BranchResolutionInput): string {
  const docsSection = [
    input.claudeMd ?? "No CLAUDE.md found.",
    input.agentsMd ?? "No AGENTS.md found.",
  ].join("\n\n");

  const branchSection =
    input.branches.length > 0
      ? input.branches.join("\n")
      : "No remote branches found.";

  return `You are deciding the git branch name for a new issue.

## Issue
Key: ${input.issueKey}
Title: ${input.title}
Type: ${input.issueType || "unknown"}

## Repository conventions
${docsSection}

## Existing branches
${branchSection}

Based on the repository's documented conventions and existing branch naming patterns, reply with ONLY the branch name. Nothing else.`;
}

export function parseBranchName(raw: string): string | null {
  // Strip markdown code fences
  const cleaned = raw.replace(/```\w*/g, "").trim();

  // Take first non-empty line
  const line = cleaned
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);

  if (!line) return null;

  // Basic git ref validation: no spaces, no ~^:?*[\, no double dots, no trailing dot/slash
  if (/[\s~^:?*\[\]\\]/.test(line)) return null;
  if (line.includes("..")) return null;
  if (line.endsWith(".") || line.endsWith("/")) return null;
  if (line.endsWith(".lock")) return null;
  if (line.includes("@{")) return null;
  if (line.includes("//")) return null;
  if (/[\x00-\x1f\x7f]/.test(line)) return null;
  if (line.startsWith("-")) return null;

  return line;
}

// --- PR body builder ---

export function buildPrBody(
  item: QueueItem,
  summary: ImplementationSummary,
  triageContent: string,
  jiraBaseUrl?: string
): string {
  const jiraLink = jiraBaseUrl
    ? `[${item.issueKey}](${jiraBaseUrl}/browse/${item.issueKey})`
    : item.issueKey;
  const statusIcon = summary.status === "complete" ? "✅" : "⚠️";
  const statusText =
    summary.status === "complete"
      ? "Complete"
      : `Incomplete — ${summary.error || "unknown error"}`;

  const summaryText = summary.implementationResult || item.title;

  const changedFilesSection = summary.changedFiles?.length
    ? `\n## Changed Files\n${summary.changedFiles.map((f) => `- \`${f}\``).join("\n")}\n`
    : "";

  return `## Summary
${summaryText}

## Status
${statusIcon} ${statusText}
${changedFilesSection}
## Heimdall
${jiraLink} · ${summary.size} · ${formatDuration(summary.timings.implementationSeconds)} · ~$${summary.cost.totalUsd.toFixed(2)} · ${summary.model} · ${summary.filesChanged} files

<details><summary>Triage Analysis (score: ${summary.triageScore}/9)</summary>

${triageContent}
</details>

---
Generated by Heimdall — The All-Seeing PR Guardian`;
}

// --- Worker class (not unit tested — spawns external processes) ---

export class Worker {
  private readonly worktreeDir: string;
  private heartbeatInterval: Timer | null = null;

  constructor(
    private readonly queue: QueueManager,
    private readonly config: HeimdallConfig,
    private readonly notifier: NotifyAction,
    private readonly logger: Logger
  ) {
    this.worktreeDir = resolveHomePath(config.worker.worktreeDir);
    mkdirSync(this.worktreeDir, { recursive: true });
  }

  startHeartbeat(): void {
    const heimdallDir = resolveHomePath(HEIMDALL_DIR);
    writePid(heimdallDir);
    writeHeartbeat(heimdallDir);
    this.heartbeatInterval = setInterval(() => writeHeartbeat(heimdallDir), 10_000);

    const cleanup = () => {
      if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
      clearHeartbeatFiles(heimdallDir);
    };
    process.on("exit", cleanup);
    process.on("SIGTERM", () => { cleanup(); process.exit(0); });
    process.on("SIGINT", () => { cleanup(); process.exit(0); });
  }

  stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    clearHeartbeatFiles(resolveHomePath(HEIMDALL_DIR));
  }

  async processNext(): Promise<boolean> {
    const item = await this.queue.pickNext();
    if (!item) {
      this.logger.info("No pending items in queue");
      return false;
    }

    this.logger.info(`Processing ${item.issueKey}: ${item.title}`);
    await this.queue.update(item.issueKey, { status: "in_progress" });

    const worktreePath = join(this.worktreeDir, item.issueKey);

    try {
      // Gate 1: Pre-flight validation
      await this.validatePreFlight(item);

      // Gate 2: Resolve branch name from repo conventions
      const branch = await this.resolveBranchName(item);

      // Gate 2: Create worktree and push branch for collaboration
      await this.createWorktree(item.cwd, worktreePath, branch);
      await this.queue.update(item.issueKey, { branch });
      await this.pushBranch(worktreePath, branch);

      let triageContent = "";
      if (existsSync(item.triageReport)) {
        triageContent = await Bun.file(item.triageReport).text();
      }

      const implStart = Date.now();
      const prompt = buildImplementationPrompt(item, triageContent, worktreePath);
      const claudeResult = await this.spawnImplementation(prompt, worktreePath, item);
      const implSeconds = (Date.now() - implStart) / 1000;

      if (claudeResult.exitCode !== 0 && claudeResult.stderr) {
        this.logger.error(`Claude stderr for ${item.issueKey}: ${claudeResult.stderr.trim()}`);
      }

      const streamResult = parseStreamJson(claudeResult.stdout);
      const model = `claude-${this.config.worker.model}-4-6`;
      const cost = calculateCost(
        streamResult.inputTokens,
        streamResult.outputTokens,
        this.config.costs,
        model
      );

      const changedFiles = await this.getChangedFiles(worktreePath);

      await this.pushBranch(worktreePath, branch);
      const isComplete = claudeResult.exitCode === 0;

      const summary: ImplementationSummary = {
        issueKey: item.issueKey,
        title: item.title,
        triageScore: 0,
        size: "M",
        timings: { triageSeconds: 0, implementationSeconds: implSeconds },
        cost: {
          inputTokens: streamResult.inputTokens,
          outputTokens: streamResult.outputTokens,
          cacheTokens: streamResult.cacheTokens,
          totalUsd: streamResult.costUsd || cost,
        },
        model,
        tests: { passing: 0, failing: 0 },
        filesChanged: changedFiles.length,
        changedFiles,
        prUrl: "",
        status: isComplete ? "complete" : "incomplete",
        error: isComplete ? undefined : `Exit code ${claudeResult.exitCode}`,
        implementationResult: streamResult.result || undefined,
      };

      const triageJsonPath = item.triageReport.replace(".md", ".json");
      if (existsSync(triageJsonPath)) {
        const triageReport: TriageReport = await Bun.file(triageJsonPath).json();
        summary.triageScore = triageReport.result.total;
        summary.size = triageReport.result.size;
      }

      // Save artifacts early so they're preserved even if PR creation fails
      await this.saveRunArtifacts(item.issueKey, summary, triageContent, claudeResult.stdout, claudeResult.stderr);

      // Gate 3: Verify Claude produced commits before attempting PR
      const defaultBranch = await this.detectDefaultBranch(worktreePath);
      const hasCommits = await this.hasCommitsOnBranch(worktreePath, defaultBranch);

      if (!hasCommits) {
        this.logger.warn(`No commits found for ${item.issueKey} — skipping PR creation`);
        summary.status = "incomplete";
        summary.error = `Claude produced no commits for ${item.issueKey}`;
        await this.saveRunArtifacts(item.issueKey, summary, triageContent, claudeResult.stdout, claudeResult.stderr);
        await this.queue.update(item.issueKey, {
          status: "failed",
          error: summary.error,
        });
        await this.notifier.notifyWorkerFailed(item.issueKey, summary.error);
        this.logger.warn(`Preserving worktree for failed item: ${worktreePath}`);
        return true;
      }

      const jiraSource = this.config.sources.find((s) => s.type === "jira") as
        | import("./types").JiraSourceConfig
        | undefined;
      const prBody = buildPrBody(item, summary, triageContent, jiraSource?.baseUrl);
      const prTitle = `[Heimdall] ${item.issueKey}: ${item.title}`;
      const prUrl = await this.createDraftPr(item.cwd, branch, prTitle, prBody);
      summary.prUrl = prUrl;

      // Re-save summary with prUrl populated
      await this.saveRunArtifacts(item.issueKey, summary, triageContent, claudeResult.stdout, claudeResult.stderr);

      await this.queue.update(item.issueKey, {
        status: isComplete ? "completed" : "failed",
        prUrl,
      });

      if (isComplete) {
        await this.notifier.notifyWorkerComplete(
          item.issueKey,
          prUrl,
          summary.triageScore,
          `$${summary.cost.totalUsd.toFixed(2)}`,
          formatDuration(implSeconds)
        );
      } else {
        await this.notifier.notifyWorkerFailed(
          item.issueKey,
          `Partial PR opened — ${summary.error}`
        );
      }

      if (isComplete) {
        await this.removeWorktree(item.cwd, worktreePath);
      } else {
        this.logger.warn(`Preserving worktree for failed item: ${worktreePath}`);
      }

      this.logger.info(`${item.issueKey} ${isComplete ? "completed" : "failed"}: ${prUrl}`);
      return true;
    } catch (err) {
      this.logger.error(`Worker error for ${item.issueKey}: ${err}`);
      await this.queue.update(item.issueKey, {
        status: "failed",
        error: String(err),
      });
      await this.notifier.notifyWorkerFailed(item.issueKey, String(err));
      return true;
    }
  }

  private async detectDefaultBranch(repoCwd: string): Promise<string> {
    const proc = Bun.spawn(
      ["git", "rev-parse", "--verify", "--quiet", "refs/remotes/origin/main"],
      { cwd: repoCwd, stdout: "pipe", stderr: "pipe" }
    );
    const exitCode = await proc.exited;
    return exitCode === 0 ? "main" : "master";
  }

  private async validatePreFlight(item: QueueItem): Promise<void> {
    if (!existsSync(item.cwd)) {
      throw new Error(`Pre-flight failed: cwd does not exist: ${item.cwd}`);
    }

    const remoteProc = Bun.spawn(
      ["git", "remote", "get-url", "origin"],
      { cwd: item.cwd, stdout: "pipe", stderr: "pipe" }
    );
    const [remoteExit, , remoteStderr] = await Promise.all([
      remoteProc.exited,
      new Response(remoteProc.stdout).text(),
      new Response(remoteProc.stderr).text(),
    ]);
    if (remoteExit !== 0) {
      throw new Error(
        `Pre-flight failed: ${item.cwd} is not a git repo with origin remote: ${remoteStderr.trim()}`
      );
    }

    const ghProc = Bun.spawn(
      ["gh", "repo", "view", item.repo, "--json", "name"],
      { cwd: item.cwd, stdout: "pipe", stderr: "pipe" }
    );
    const [ghExit, , ghStderr] = await Promise.all([
      ghProc.exited,
      new Response(ghProc.stdout).text(),
      new Response(ghProc.stderr).text(),
    ]);
    if (ghExit !== 0) {
      throw new Error(
        `Pre-flight failed: gh cannot access repo ${item.repo}: ${ghStderr.trim()}`
      );
    }

    this.logger.info(`Pre-flight checks passed for ${item.issueKey}`);
  }

  private async createWorktree(repoCwd: string, worktreePath: string, branch: string): Promise<void> {
    const defaultBranch = await this.detectDefaultBranch(repoCwd);
    this.logger.info(`Creating worktree: ${worktreePath} (branch: ${branch}) from origin/${defaultBranch}`);
    const fetch = Bun.spawn(["git", "fetch", "origin", defaultBranch], { cwd: repoCwd, stdout: "pipe", stderr: "pipe" });
    await fetch.exited;

    // Clean up stale branch/worktree from a previous failed run
    await this.cleanupStaleBranch(repoCwd, worktreePath, branch);

    const proc = Bun.spawn(
      ["git", "worktree", "add", worktreePath, "-b", branch, `origin/${defaultBranch}`],
      { cwd: repoCwd, stdout: "pipe", stderr: "pipe" }
    );
    const [exitCode, , stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    if (exitCode !== 0) {
      throw new Error(`git worktree add failed: ${stderr}`);
    }
  }

  private async cleanupStaleBranch(repoCwd: string, worktreePath: string, branch: string): Promise<void> {
    // Check if branch already exists locally
    const check = Bun.spawn(
      ["git", "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`],
      { cwd: repoCwd, stdout: "pipe", stderr: "pipe" }
    );
    if (await check.exited !== 0) return; // branch doesn't exist, nothing to clean

    this.logger.warn(`Cleaning up stale branch from previous run: ${branch}`);

    // Remove stale worktree entry if it exists (e.g. directory was deleted but not pruned)
    const prune = Bun.spawn(["git", "worktree", "prune"], { cwd: repoCwd, stdout: "pipe", stderr: "pipe" });
    await prune.exited;

    // Remove the worktree directory if it still exists
    if (existsSync(worktreePath)) {
      const remove = Bun.spawn(
        ["git", "worktree", "remove", worktreePath, "--force"],
        { cwd: repoCwd, stdout: "pipe", stderr: "pipe" }
      );
      await remove.exited;
    }

    // Delete the stale local branch
    const del = Bun.spawn(
      ["git", "branch", "-D", branch],
      { cwd: repoCwd, stdout: "pipe", stderr: "pipe" }
    );
    await del.exited;
  }

  private async gatherBranchContext(
    cwd: string
  ): Promise<{ claudeMd: string | null; agentsMd: string | null; branches: string[] }> {
    // Read convention docs
    const claudeMdPath = join(cwd, "CLAUDE.md");
    const agentsMdPath = join(cwd, "AGENTS.md");
    const claudeMd = existsSync(claudeMdPath) ? await Bun.file(claudeMdPath).text() : null;
    const agentsMd = existsSync(agentsMdPath) ? await Bun.file(agentsMdPath).text() : null;

    // List remote branches (cap at 50)
    const proc = Bun.spawn(["git", "branch", "-r"], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);

    let branches: string[] = [];
    if (exitCode === 0) {
      branches = stdout
        .trim()
        .split("\n")
        .map((b) => b.trim())
        .filter((b) => b && !b.includes("->"))
        .slice(-50);
    }

    return { claudeMd, agentsMd, branches };
  }

  private async resolveBranchName(item: QueueItem): Promise<string> {
    const fallback = `heimdall/${item.issueKey}`;

    try {
      this.logger.info(`Resolving branch name for ${item.issueKey}`);
      const context = await this.gatherBranchContext(item.cwd);

      const prompt = buildBranchResolutionPrompt({
        issueKey: item.issueKey,
        title: item.title,
        issueType: item.issueType,
        claudeMd: context.claudeMd,
        agentsMd: context.agentsMd,
        branches: context.branches,
      });

      const result = await spawnClaude({
        prompt,
        model: this.config.triage.model,
        outputFormat: "text",
        cwd: item.cwd,
        timeout: 30_000,
      });

      if (result.exitCode !== 0) {
        if (result.stderr) this.logger.warn(`Branch resolution stderr: ${result.stderr.trim()}`);
        this.logger.warn(`Branch resolution failed (exit ${result.exitCode}), using fallback: ${fallback}`);
        return fallback;
      }

      const resolved = parseBranchName(result.stdout);
      if (!resolved) {
        this.logger.warn(`Branch resolution returned invalid name, using fallback: ${fallback}`);
        return fallback;
      }

      this.logger.info(`Resolved branch name: ${resolved}`);
      return resolved;
    } catch (err) {
      this.logger.warn(`Branch resolution error: ${err}, using fallback: ${fallback}`);
      return fallback;
    }
  }

  private async spawnImplementation(
    prompt: string,
    cwd: string,
    item: QueueItem
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    let systemPrompt: string | undefined;
    if (item.systemPromptFile) {
      const resolvedPath = resolveHomePath(item.systemPromptFile);
      if (!existsSync(resolvedPath)) {
        throw new Error(`systemPromptFile not found: ${resolvedPath}`);
      }
      systemPrompt = await Bun.file(resolvedPath).text();
      this.logger.info(`Injecting system prompt from ${resolvedPath}`);
    }

    this.logger.info(`Spawning Claude in ${cwd}`);
    return spawnClaude({
      prompt,
      model: this.config.worker.model,
      outputFormat: "stream-json",
      cwd,
      maxTurns: this.config.worker.maxTurns,
      systemPrompt,
      allowedTools: item.allowedTools,
    });
  }

  private async getChangedFiles(worktreePath: string): Promise<string[]> {
    const defaultBranch = await this.detectDefaultBranch(worktreePath);
    const proc = Bun.spawn(
      ["git", "diff", "--name-only", `${defaultBranch}...HEAD`],
      { cwd: worktreePath, stdout: "pipe", stderr: "pipe" }
    );
    const [exitCode, stdout] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    if (exitCode !== 0) {
      const fallback = Bun.spawn(
        ["git", "diff", "--name-only", "--cached"],
        { cwd: worktreePath, stdout: "pipe", stderr: "pipe" }
      );
      const [, fallbackOut] = await Promise.all([
        fallback.exited,
        new Response(fallback.stdout).text(),
        new Response(fallback.stderr).text(),
      ]);
      return fallbackOut.trim().split("\n").filter(Boolean);
    }
    return stdout.trim().split("\n").filter(Boolean);
  }

  private async pushBranch(worktreePath: string, branch: string): Promise<void> {
    this.logger.info(`Pushing branch: ${branch}`);
    const proc = Bun.spawn(
      ["git", "push", "-u", "origin", branch],
      { cwd: worktreePath, stdout: "pipe", stderr: "pipe" }
    );
    const [exitCode, , stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    if (exitCode !== 0) {
      throw new Error(`git push failed: ${stderr}`);
    }
  }

  private async hasCommitsOnBranch(worktreePath: string, defaultBranch: string): Promise<boolean> {
    const proc = Bun.spawn(
      ["git", "log", `origin/${defaultBranch}..HEAD`, "--oneline"],
      { cwd: worktreePath, stdout: "pipe", stderr: "pipe" }
    );
    const [exitCode, stdout] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    if (exitCode !== 0) {
      this.logger.warn(`git log commit check failed (exit ${exitCode}), assuming no commits`);
      return false;
    }
    return stdout.trim().split("\n").filter(Boolean).length > 0;
  }

  private async createDraftPr(repoCwd: string, branch: string, title: string, body: string): Promise<string> {
    this.logger.info(`Creating draft PR for ${branch}`);
    const proc = Bun.spawn(
      ["gh", "pr", "create", "--draft", "--title", title, "--body", body, "--head", branch],
      { cwd: repoCwd, stdout: "pipe", stderr: "pipe" }
    );
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    if (exitCode !== 0) {
      throw new Error(`gh pr create failed: ${stderr}`);
    }
    return stdout.trim();
  }

  private async saveRunArtifacts(
    issueKey: string,
    summary: ImplementationSummary,
    triageContent: string,
    implementationLog: string,
    stderr?: string
  ): Promise<void> {
    const runsDir = join(resolveHomePath(HEIMDALL_DIR), "runs", issueKey);
    mkdirSync(runsDir, { recursive: true });
    await Bun.write(join(runsDir, "summary.json"), JSON.stringify(summary, null, 2));
    await Bun.write(join(runsDir, "triage.md"), triageContent);
    await Bun.write(join(runsDir, "implementation.log"), implementationLog);
    if (stderr) {
      await Bun.write(join(runsDir, "stderr.log"), stderr);
    }
  }

  private async removeWorktree(repoCwd: string, worktreePath: string): Promise<void> {
    this.logger.info(`Removing worktree: ${worktreePath}`);
    const proc = Bun.spawn(
      ["git", "worktree", "remove", worktreePath, "--force"],
      { cwd: repoCwd, stdout: "pipe", stderr: "pipe" }
    );
    await proc.exited;
  }
}
