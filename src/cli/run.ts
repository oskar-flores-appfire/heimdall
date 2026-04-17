import { existsSync } from "fs";
import { loadConfig, ensureHeimdallDir, resolveHomePath, DEFAULT_CONFIG_PATH, DEFAULT_CONFIG } from "../config";
import { createLogger } from "../logger";
import { StateManager } from "../state";
import { GitHubSource } from "../sources/github";
import { NotifyAction } from "../actions/notify";
import { ReviewAction } from "../actions/review";
import { runCycle } from "../scheduler";
import { JiraSource } from "../sources/jira";
import { TriageAction } from "../actions/triage";
import { runJiraCycle } from "../jira-cycle";
import { startServer } from "../server";
import type { Action, HeimdallConfig, JiraSourceConfig } from "../types";
import type { Logger } from "../logger";

async function executeCycle(
  config: HeimdallConfig,
  logger: Logger,
  state: StateManager,
  actions: Action[]
): Promise<void> {
  const githubSources = config.sources.filter((s) => s.type === "github");
  for (const srcConfig of githubSources) {
    if (srcConfig.type !== "github") continue;
    if (srcConfig.repos.length === 0) {
      logger.warn("No repos configured for GitHub source. Skipping.");
      continue;
    }
    const source = new GitHubSource(srcConfig.repos, srcConfig.trigger, logger);
    await runCycle(source, actions, state, config, logger);
  }

  for (const srcConfig of config.sources) {
    if (srcConfig.type === "jira") {
      const jiraConfig = srcConfig as JiraSourceConfig;
      const jiraSource = new JiraSource(jiraConfig, logger);
      const triageAction = new TriageAction(config.triage, logger);
      const notifyAction = actions.find((a) => a.name === "notify") as NotifyAction | undefined;

      await runJiraCycle({
        poll: () => jiraSource.poll(),
        triage: (issue) => triageAction.triage(issue),
        notify: async (issue, report) => {
          if (!notifyAction) return;
          if (report.verdict === "ready") {
            await notifyAction.notifyTriage(issue, report);
          } else if (report.verdict === "needs_detail") {
            await notifyAction.notifyNeedsDetail(issue, report);
          } else {
            await notifyAction.notifyTooBig(issue, report);
          }
        },
        state,
        namespace: `jira:${jiraConfig.baseUrl}`,
        logger,
      });
    }
  }
}

export async function run(): Promise<void> {
  await ensureHeimdallDir();

  if (!existsSync(DEFAULT_CONFIG_PATH)) {
    const defaultWithRepo = {
      ...DEFAULT_CONFIG,
      sources: [
        {
          type: "github" as const,
          repos: ["appfire-team/signal-iq"],
          trigger: "review-requested" as const,
        },
      ],
      actions: {
        ...DEFAULT_CONFIG.actions,
        review: {
          ...DEFAULT_CONFIG.actions.review,
          repos: {
            "appfire-team/signal-iq": {
              prompt: "Review PR #{{pr_number}} in appfire-team/signal-iq against the project's DDD/Clean Architecture rules. Run automated scans. Report findings grouped by severity: FLAGRANT, VIOLATION, SUGGESTION.",
              cwd: "/Users/oskarflores/code/innovation/signal-iq",
            },
          },
        },
      },
    };
    await Bun.write(DEFAULT_CONFIG_PATH, JSON.stringify(defaultWithRepo, null, 2));
    console.log(`Config created at ${DEFAULT_CONFIG_PATH} — edit repos and paths.`);
  }

  const config = await loadConfig();
  const logger = createLogger({
    file: resolveHomePath(config.log.file),
    level: config.log.level,
  });

  const state = new StateManager(resolveHomePath("~/.heimdall/seen.json"));
  const actions: Action[] = [];

  if (config.actions.notify.enabled) {
    actions.push(new NotifyAction(config.actions.notify.sound, logger));
  }

  if (config.actions.review.enabled) {
    actions.push(
      new ReviewAction(
        config.actions.review.command,
        config.actions.review.defaultArgs,
        resolveHomePath(config.reports.dir),
        resolveHomePath("~/.heimdall/review-worktrees"),
        logger
      )
    );
  }

  const once = process.argv.includes("--once");

  if (once) {
    logger.info("Heimdall run — single poll cycle (--once)");
    await executeCycle(config, logger, state, actions);
    return;
  }

  // Persistent mode: start server + poll loop
  logger.info("Heimdall starting — persistent mode");
  startServer(config, logger);

  // Run first cycle immediately
  await executeCycle(config, logger, state, actions);

  // Schedule subsequent cycles
  setInterval(async () => {
    try {
      await executeCycle(config, logger, state, actions);
    } catch (err) {
      logger.error(`Poll cycle error: ${err}`);
    }
  }, config.interval * 1000);

  logger.info(`Polling every ${config.interval}s. Server on http://localhost:${config.server.port}`);
}
