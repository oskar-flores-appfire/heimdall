import type { Source, PullRequest } from "../types";
import type { Logger } from "../logger";

interface GhPrJson {
  number: number;
  title: string;
  url: string;
  headRefName: string;
  baseRefName: string;
  author: { login: string };
}

export class GitHubSource implements Source {
  readonly name = "github";

  constructor(
    private readonly repos: string[],
    private readonly trigger: string,
    private readonly logger: Logger
  ) {}

  async poll(): Promise<PullRequest[]> {
    const allPrs: PullRequest[] = [];

    for (const repo of this.repos) {
      try {
        const prs = await this.pollRepo(repo);
        allPrs.push(...prs);
      } catch (err) {
        this.logger.error(`Failed to poll ${repo}: ${err}`);
      }
    }

    return allPrs;
  }

  private async pollRepo(repo: string): Promise<PullRequest[]> {
    const proc = Bun.spawn(
      [
        "gh", "pr", "list",
        "--repo", repo,
        "--search", `${this.trigger}:@me -reviewed-by:@me`,
        "--json", "number,title,url,headRefName,baseRefName,author",
        "--limit", "30",
      ],
      { stdout: "pipe", stderr: "pipe" }
    );

    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    if (exitCode !== 0) {
      this.logger.error(`gh pr list failed for ${repo}: ${stderr}`);
      return [];
    }
    if (!stdout.trim()) return [];

    const raw: GhPrJson[] = JSON.parse(stdout);
    return raw.map((pr) => ({
      number: pr.number,
      title: pr.title,
      url: pr.url,
      headRefName: pr.headRefName,
      baseRefName: pr.baseRefName,
      repo,
      author: pr.author.login,
    }));
  }
}
