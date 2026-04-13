import { mkdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import type { Action, PullRequest, RepoConfig, ActionResult } from "../types";
import type { Logger } from "../logger";

export function buildPrompt(template: string, pr: PullRequest): string {
  return template
    .replace(/\{\{pr_number\}\}/g, String(pr.number))
    .replace(/\{\{pr_title\}\}/g, pr.title)
    .replace(/\{\{pr_author\}\}/g, pr.author)
    .replace(/\{\{pr_repo\}\}/g, pr.repo)
    .replace(/\{\{pr_branch\}\}/g, pr.headRefName)
    .replace(/\{\{pr_url\}\}/g, pr.url);
}

export class ReviewAction implements Action {
  readonly name = "review";

  constructor(
    private readonly command: string,
    private readonly defaultArgs: string[],
    private readonly reportsDir: string,
    private readonly logger: Logger
  ) {}

  reportPath(pr: PullRequest): string {
    return join(this.reportsDir, pr.repo, `PR-${pr.number}.md`);
  }

  async execute(pr: PullRequest, repoConfig: RepoConfig): Promise<ActionResult> {
    const prompt = buildPrompt(repoConfig.prompt, pr);
    const report = this.reportPath(pr);
    mkdirSync(dirname(report), { recursive: true });

    const args = [...this.defaultArgs, prompt];

    if (repoConfig.systemPromptFile && existsSync(repoConfig.systemPromptFile)) {
      const content = await Bun.file(repoConfig.systemPromptFile).text();
      args.push("--append-system-prompt", content);
    }

    this.logger.info(`Reviewing PR #${pr.number} in ${pr.repo} (${pr.author})`);
    this.logger.debug(`Command: ${this.command} ${args.join(" ").substring(0, 200)}...`);

    try {
      const proc = Bun.spawn([this.command, ...args], {
        cwd: repoConfig.cwd,
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, TERM: "dumb" },
      });

      const exitCode = await proc.exited;
      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();

      if (exitCode !== 0) {
        this.logger.error(`Review failed for PR #${pr.number}: ${stderr}`);
        const errorReport = `# Review Failed\n\n**PR:** #${pr.number} - ${pr.title}\n**Error:**\n\`\`\`\n${stderr}\n\`\`\`\n`;
        await Bun.write(report, errorReport);
        return { action: "review", success: false, message: stderr, reportPath: report };
      }

      const header = `# Code Review: PR #${pr.number}\n\n**Title:** ${pr.title}\n**Author:** ${pr.author}\n**Branch:** ${pr.headRefName}\n**Repo:** ${pr.repo}\n**URL:** ${pr.url}\n**Reviewed:** ${new Date().toISOString()}\n\n---\n\n`;
      await Bun.write(report, header + stdout);

      this.logger.info(`Review saved: ${report}`);
      return { action: "review", success: true, reportPath: report };
    } catch (err) {
      this.logger.error(`Review process error for PR #${pr.number}: ${err}`);
      return { action: "review", success: false, message: String(err) };
    }
  }
}
