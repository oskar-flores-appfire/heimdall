import type { Source, Action, PullRequest, HeimdallConfig } from "./types";
import type { Logger } from "./logger";
import type { StateManager } from "./state";

export async function runCycle(
  source: Source,
  actions: Action[],
  state: StateManager,
  config: HeimdallConfig,
  logger: Logger
): Promise<void> {
  logger.info("Poll cycle started");

  let prs: PullRequest[];
  try {
    prs = await source.poll();
    logger.info(`Found ${prs.length} PR(s) requesting review`);
  } catch (err) {
    logger.error(`Source poll failed: ${err}`);
    return;
  }

  const newPrs = await state.filterNew(prs);
  if (newPrs.length === 0) {
    logger.info("No new PRs to process");
    return;
  }

  logger.info(`Processing ${newPrs.length} new PR(s)`);

  await Promise.all(
    newPrs.map(async (pr) => {
      const repoConfig = config.actions.review.repos[pr.repo];
      if (!repoConfig) {
        logger.warn(`No review config for repo ${pr.repo}, skipping review`);
      }

      await state.markSeen(pr);

      for (const action of actions) {
        try {
          const result = await action.execute(
            pr,
            repoConfig ?? { prompt: "Review PR #{{pr_number}}", cwd: "/tmp" }
          );
          if (result.reportPath) {
            await state.markReviewed(pr, result.reportPath);
          }
          if (!result.success) {
            logger.warn(`Action ${action.name} failed for PR #${pr.number}: ${result.message}`);
          }
        } catch (err) {
          logger.error(`Action ${action.name} threw for PR #${pr.number}: ${err}`);
        }
      }
    })
  );

  await state.prune(30);
  logger.info("Poll cycle completed");
}
