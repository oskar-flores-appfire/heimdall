import type { Action, PullRequest, RepoConfig, ActionResult } from "../types";
import type { Logger } from "../logger";

type Notifier = "terminal-notifier" | "osascript" | "none";

export function detectNotifier(): Notifier {
  const tn = Bun.spawnSync(["which", "terminal-notifier"]);
  if (tn.exitCode === 0) return "terminal-notifier";

  const osa = Bun.spawnSync(["which", "osascript"]);
  if (osa.exitCode === 0) return "osascript";

  return "none";
}

export class NotifyAction implements Action {
  readonly name = "notify";
  private readonly notifier: Notifier;

  constructor(
    private readonly sound: string,
    private readonly logger: Logger,
    private readonly maxPerCycle: number = 5,
    private readonly batchThreshold: number = 3
  ) {
    this.notifier = detectNotifier();
    if (this.notifier === "none") {
      logger.warn("No notification tool found. Install terminal-notifier: brew install terminal-notifier");
    } else if (this.notifier === "osascript") {
      logger.info("Using osascript for notifications. For clickable notifications: brew install terminal-notifier");
    }
  }

  async execute(pr: PullRequest, _repoConfig: RepoConfig): Promise<ActionResult> {
    return this.notifyStart(pr);
  }

  async notifyStart(pr: PullRequest): Promise<ActionResult> {
    const message = `Reviewing PR #${pr.number}: ${pr.title}`;
    try {
      await this.send("Heimdall", pr.repo, message, pr.url, `heimdall-${pr.repo}-${pr.number}`);
      this.logger.info(`Notified: ${message}`);
      return { action: "notify", success: true, message };
    } catch (err) {
      this.logger.error(`Notification failed: ${err}`);
      return { action: "notify", success: false, message: String(err) };
    }
  }

  async notifyComplete(pr: PullRequest, _reportPath: string): Promise<ActionResult> {
    const message = `Review ready: PR #${pr.number} — ${pr.title}`;
    try {
      await this.send("Heimdall ✓", pr.repo, message, pr.url, `heimdall-${pr.repo}-${pr.number}`);
      this.logger.info(`Review complete notification: ${message}`);
      return { action: "notify", success: true, message };
    } catch (err) {
      this.logger.error(`Completion notification failed: ${err}`);
      return { action: "notify", success: false, message: String(err) };
    }
  }

  async notifyBatch(prs: PullRequest[]): Promise<ActionResult> {
    const message = `${prs.length} PRs need review`;
    const subtitle = [...new Set(prs.map((p) => p.repo))].join(", ");
    try {
      await this.send("Heimdall", subtitle, message, prs[0].url, "heimdall-batch");
      this.logger.info(`Batch notification: ${message}`);
      return { action: "notify", success: true, message };
    } catch (err) {
      this.logger.error(`Batch notification failed: ${err}`);
      return { action: "notify", success: false, message: String(err) };
    }
  }

  shouldBatch(count: number): boolean {
    return count > this.batchThreshold;
  }

  exceedsMax(count: number): boolean {
    return count > this.maxPerCycle;
  }

  private async send(
    title: string,
    subtitle: string,
    message: string,
    url: string,
    group: string
  ): Promise<void> {
    if (this.notifier === "terminal-notifier") {
      const proc = Bun.spawn([
        "terminal-notifier",
        "-title", title,
        "-subtitle", subtitle,
        "-message", message,
        "-open", url,
        "-sound", this.sound,
        "-group", group,
      ]);
      await proc.exited;
    } else if (this.notifier === "osascript") {
      const script = `display notification "${message}" with title "${title}" subtitle "${subtitle}" sound name "${this.sound}"`;
      const proc = Bun.spawn(["osascript", "-e", script]);
      await proc.exited;
    }
  }
}
