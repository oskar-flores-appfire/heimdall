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
    private readonly logger: Logger
  ) {
    this.notifier = detectNotifier();
    if (this.notifier === "none") {
      logger.warn("No notification tool found. Install terminal-notifier: brew install terminal-notifier");
    } else if (this.notifier === "osascript") {
      logger.info("Using osascript for notifications. For clickable notifications: brew install terminal-notifier");
    }
  }

  async execute(pr: PullRequest, _repoConfig: RepoConfig): Promise<ActionResult> {
    const title = "Heimdall";
    const subtitle = pr.repo;
    const message = `PR #${pr.number}: ${pr.title}`;

    try {
      if (this.notifier === "terminal-notifier") {
        await this.terminalNotifier(title, subtitle, message, pr.url);
      } else if (this.notifier === "osascript") {
        await this.osascript(title, subtitle, message);
      } else {
        this.logger.warn(`No notifier available for PR #${pr.number}`);
      }

      this.logger.info(`Notified: ${message}`);
      return { action: "notify", success: true, message };
    } catch (err) {
      this.logger.error(`Notification failed: ${err}`);
      return { action: "notify", success: false, message: String(err) };
    }
  }

  private async terminalNotifier(
    title: string,
    subtitle: string,
    message: string,
    url: string
  ): Promise<void> {
    const proc = Bun.spawn([
      "terminal-notifier",
      "-title", title,
      "-subtitle", subtitle,
      "-message", message,
      "-open", url,
      "-sound", this.sound,
      "-group", "heimdall",
    ]);
    await proc.exited;
  }

  private async osascript(
    title: string,
    subtitle: string,
    message: string
  ): Promise<void> {
    const script = `display notification "${message}" with title "${title}" subtitle "${subtitle}" sound name "${this.sound}"`;
    const proc = Bun.spawn(["osascript", "-e", script]);
    await proc.exited;
  }
}
