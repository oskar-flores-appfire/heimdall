import type { Logger } from "./logger";

export async function createReviewWorktree(
  repoCwd: string,
  worktreePath: string,
  branch: string,
  logger: Logger
): Promise<void> {
  logger.info(`Fetching origin/${branch}`);
  const fetchProc = Bun.spawn(["git", "fetch", "origin", branch], {
    cwd: repoCwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [fetchExit, , fetchErr] = await Promise.all([
    fetchProc.exited,
    new Response(fetchProc.stdout).text(),
    new Response(fetchProc.stderr).text(),
  ]);
  if (fetchExit !== 0) {
    throw new Error(`git fetch failed: ${fetchErr}`);
  }

  logger.info(`Creating review worktree: ${worktreePath}`);
  const proc = Bun.spawn(
    ["git", "worktree", "add", "--detach", worktreePath, `origin/${branch}`],
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

export async function removeReviewWorktree(
  repoCwd: string,
  worktreePath: string,
  logger: Logger
): Promise<void> {
  logger.info(`Removing review worktree: ${worktreePath}`);
  const proc = Bun.spawn(
    ["git", "worktree", "remove", worktreePath, "--force"],
    { cwd: repoCwd, stdout: "pipe", stderr: "pipe" }
  );
  const [exitCode, , stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  if (exitCode !== 0) {
    logger.warn(`Failed to remove review worktree ${worktreePath}: ${stderr}`);
  }
}
