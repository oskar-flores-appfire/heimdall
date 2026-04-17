import { mkdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import type { Action, PullRequest, RepoConfig, ActionResult } from "../types";
import type { Logger } from "../logger";
import { createReviewWorktree, removeReviewWorktree } from "../git";

export function buildPrompt(template: string, pr: PullRequest): string {
  return template
    .replace(/\{\{pr_number\}\}/g, String(pr.number))
    .replace(/\{\{pr_title\}\}/g, pr.title)
    .replace(/\{\{pr_author\}\}/g, pr.author)
    .replace(/\{\{pr_repo\}\}/g, pr.repo)
    .replace(/\{\{pr_branch\}\}/g, pr.headRefName)
    .replace(/\{\{pr_url\}\}/g, pr.url)
    .replace(/\{\{BRANCH_OR_PR\}\}/g, pr.headRefName)
    .replace(/\{\{BASE_BRANCH\}\}/g, pr.baseRefName);
}

const AUTOMATION_DIRECTIVE = [
  "You are running as an automated code review tool (Heimdall).",
  "Do NOT invoke any skills, slash commands, or worktrees.",
  "Do NOT use the Skill tool or the Agent tool with isolation.",
  "Review the code directly in the current working directory and output your findings.",
].join(" ");

export class ReviewAction implements Action {
  readonly name = "review";

  constructor(
    private readonly command: string,
    private readonly defaultArgs: string[],
    private readonly reportsDir: string,
    private readonly reviewWorktreeDir: string,
    private readonly logger: Logger
  ) {}

  reportPath(pr: PullRequest): string {
    return join(this.reportsDir, pr.repo, `PR-${pr.number}.md`);
  }

  async execute(pr: PullRequest, repoConfig: RepoConfig): Promise<ActionResult> {
    const prompt = buildPrompt(repoConfig.prompt, pr);
    const report = this.reportPath(pr);
    mkdirSync(dirname(report), { recursive: true });
    mkdirSync(this.reviewWorktreeDir, { recursive: true });

    const worktreeName = `${pr.repo.replace("/", "-")}-PR-${pr.number}`;
    const worktreePath = join(this.reviewWorktreeDir, worktreeName);

    const args = [...this.defaultArgs, prompt];

    // Load review prompt template (reviewPromptFile > systemPromptFile > none)
    const promptFile = repoConfig.reviewPromptFile ?? repoConfig.systemPromptFile;
    if (promptFile && existsSync(promptFile)) {
      const rawContent = await Bun.file(promptFile).text();
      const content = buildPrompt(rawContent, pr);
      args.push("--append-system-prompt", AUTOMATION_DIRECTIVE + "\n\n" + content);
    } else {
      args.push("--append-system-prompt", AUTOMATION_DIRECTIVE);
    }

    this.logger.info(`Reviewing PR #${pr.number} in ${pr.repo} (${pr.author})`);

    // Create worktree for isolated review
    let useWorktree = true;
    let effectiveCwd = repoConfig.cwd;
    try {
      await createReviewWorktree(repoConfig.cwd, worktreePath, pr.headRefName, this.logger);
      effectiveCwd = worktreePath;
    } catch (err) {
      this.logger.warn(`Failed to create review worktree, falling back to repo cwd: ${err}`);
      useWorktree = false;
    }

    this.logger.debug(`Command: ${this.command} ${args.join(" ").substring(0, 200)}...`);

    try {
      const proc = Bun.spawn([this.command, ...args], {
        cwd: effectiveCwd,
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, TERM: "dumb" },
      });

      const [exitCode, stdout, stderr] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);

      if (exitCode !== 0) {
        const errorDetail = stderr || stdout || "(no output)";
        this.logger.error(`Review failed for PR #${pr.number} (exit ${exitCode}): ${errorDetail}`);
        const errorReport = `# Review Failed\n\n**PR:** #${pr.number} - ${pr.title}\n**Exit code:** ${exitCode}\n**Error:**\n\`\`\`\n${errorDetail}\n\`\`\`\n`;
        await Bun.write(report, errorReport);
        return { action: "review", success: false, message: errorDetail, reportPath: report };
      }

      const header = `# Code Review: PR #${pr.number}\n\n**Title:** ${pr.title}\n**Author:** ${pr.author}\n**Branch:** ${pr.headRefName}\n**Repo:** ${pr.repo}\n**URL:** ${pr.url}\n**Reviewed:** ${new Date().toISOString()}\n\n---\n\n`;
      await Bun.write(report, header + stdout);

      this.logger.info(`Review saved: ${report}`);
      return { action: "review", success: true, reportPath: report };
    } catch (err) {
      this.logger.error(`Review process error for PR #${pr.number}: ${err}`);
      return { action: "review", success: false, message: String(err) };
    } finally {
      if (useWorktree) {
        await removeReviewWorktree(repoConfig.cwd, worktreePath, this.logger);
      }
    }
  }
}
