import type { Action, PullRequest, RepoConfig, ActionResult, JiraIssue, TriageReport, ReviewVerdict } from "../types";
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

  async notifyComplete(
    pr: PullRequest,
    _reportPath: string,
    verdict: ReviewVerdict,
    reviewUrl: string
  ): Promise<ActionResult> {
    const icon = verdict === "PASS" ? "✓" : verdict === "PASS (conditional)" ? "⚠" : "✗";
    const title = `Heimdall ${icon}`;
    const message = `PR #${pr.number}: ${verdict} — ${pr.title}`;
    try {
      await this.sendReviewComplete(title, pr.repo, message, reviewUrl, pr.url, `heimdall-${pr.repo}-${pr.number}`);
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

  async notifyTriage(issue: JiraIssue, report: TriageReport, triageUrl: string): Promise<ActionResult> {
    const score = `${report.result.total}/${report.result.max}`;
    const files = report.result.suggested_files.length;
    const conf = report.confidence ? report.confidence : "unknown";
    const message = `Score: ${score} | Size: ${report.result.size} | Confidence: ${conf} | ${files} file(s)`;
    try {
      await this.sendTriageNotification(
        `Heimdall — ${issue.key}`,
        issue.title,
        message,
        triageUrl,
        `heimdall approve ${issue.key}`,
        `heimdall-triage-${issue.key}`
      );
      this.logger.info(`Triage notification sent: ${issue.key}`);
      return { action: "notify", success: true, message };
    } catch (err) {
      this.logger.error(`Triage notification failed: ${err}`);
      return { action: "notify", success: false, message: String(err) };
    }
  }

  async notifyNeedsDetail(issue: JiraIssue, report: TriageReport, triageUrl: string): Promise<ActionResult> {
    const score = `${report.result.total}/${report.result.max}`;
    const message = `Score: ${score} — ${report.result.concerns}`;
    try {
      await this.send(
        `Heimdall — ${issue.key}`,
        issue.title,
        message,
        triageUrl,
        `heimdall-triage-${issue.key}`
      );
      this.logger.info(`Needs-detail notification: ${issue.key}`);
      return { action: "notify", success: true, message };
    } catch (err) {
      this.logger.error(`Needs-detail notification failed: ${err}`);
      return { action: "notify", success: false, message: String(err) };
    }
  }

  async notifyTooBig(issue: JiraIssue, report: TriageReport, triageUrl: string): Promise<ActionResult> {
    const message = `Size: ${report.result.size} — too large for autonomous implementation. Consider decomposing.`;
    try {
      await this.send(
        `Heimdall — ${issue.key}`,
        issue.title,
        message,
        triageUrl,
        `heimdall-triage-${issue.key}`
      );
      this.logger.info(`Too-big notification: ${issue.key}`);
      return { action: "notify", success: true, message };
    } catch (err) {
      this.logger.error(`Too-big notification failed: ${err}`);
      return { action: "notify", success: false, message: String(err) };
    }
  }

  async notifyNotFeasible(issue: JiraIssue, report: TriageReport, triageUrl: string): Promise<ActionResult> {
    const reasoning = report.result.feasibility?.reasoning ?? "Agent cannot tackle this autonomously";
    const message = `Not feasible — ${reasoning}`;
    try {
      await this.send(
        `Heimdall — ${issue.key}`,
        issue.title,
        message,
        triageUrl,
        `heimdall-triage-${issue.key}`
      );
      this.logger.info(`Not-feasible notification: ${issue.key}`);
      return { action: "notify", success: true, message };
    } catch (err) {
      this.logger.error(`Not-feasible notification failed: ${err}`);
      return { action: "notify", success: false, message: String(err) };
    }
  }

  async notifyWorkerComplete(
    issueKey: string,
    prUrl: string,
    score: number,
    cost: string,
    duration: string
  ): Promise<ActionResult> {
    const message = `PR opened | ${score}/9 confidence | ${cost} | ${duration}`;
    try {
      await this.send(
        `Heimdall ✓ — ${issueKey}`,
        "Implementation complete",
        message,
        prUrl,
        `heimdall-worker-${issueKey}`
      );
      this.logger.info(`Worker complete notification: ${issueKey}`);
      return { action: "notify", success: true, message };
    } catch (err) {
      this.logger.error(`Worker complete notification failed: ${err}`);
      return { action: "notify", success: false, message: String(err) };
    }
  }

  async notifyWorkerFailed(issueKey: string, error: string): Promise<ActionResult> {
    const message = `${issueKey} failed — ${error}`;
    try {
      await this.send(
        `Heimdall ✗ — ${issueKey}`,
        "Implementation failed",
        message,
        "",
        `heimdall-worker-${issueKey}`
      );
      this.logger.info(`Worker failed notification: ${issueKey}`);
      return { action: "notify", success: true, message };
    } catch (err) {
      this.logger.error(`Worker failed notification failed: ${err}`);
      return { action: "notify", success: false, message: String(err) };
    }
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

  private async sendTriageNotification(
    title: string,
    subtitle: string,
    message: string,
    triageUrl: string,
    approveCommand: string,
    group: string
  ): Promise<void> {
    if (this.notifier === "terminal-notifier") {
      const proc = Bun.spawn([
        "terminal-notifier",
        "-title", title,
        "-subtitle", subtitle,
        "-message", message,
        "-open", triageUrl,
        "-actions", "Approve",
        "-execute", approveCommand,
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

  private async sendReviewComplete(
    title: string,
    subtitle: string,
    message: string,
    reviewUrl: string,
    prUrl: string,
    group: string
  ): Promise<void> {
    if (this.notifier === "terminal-notifier") {
      const proc = Bun.spawn([
        "terminal-notifier",
        "-title", title,
        "-subtitle", subtitle,
        "-message", message,
        "-open", reviewUrl,
        "-actions", "Open PR",
        "-execute", `open ${prUrl}`,
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
