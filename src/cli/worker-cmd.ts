import { loadConfig, resolveHomePath, HEIMDALL_DIR } from "../config";
import { createLogger } from "../logger";
import { QueueManager } from "../queue";
import { NotifyAction } from "../actions/notify";
import { Worker } from "../worker";

export async function workerCmd(): Promise<void> {
  const config = await loadConfig();
  const logger = createLogger({
    file: resolveHomePath(config.log.file),
    level: config.log.level,
  });

  logger.info("Heimdall worker started");

  const queue = new QueueManager(resolveHomePath(`${HEIMDALL_DIR}/queue`));
  const notifier = new NotifyAction(config.actions.notify.sound, logger);
  const worker = new Worker(queue, config, notifier, logger);

  const items = await queue.list();
  const inProgress = items.filter((i) => i.status === "in_progress").length;
  if (inProgress >= config.worker.maxParallel) {
    console.log(`Max parallel workers reached (${inProgress}/${config.worker.maxParallel}). Exiting.`);
    return;
  }

  const processed = await worker.processNext();
  if (!processed) {
    console.log("No pending items in queue.");
  }
}
