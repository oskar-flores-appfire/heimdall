import { describe, it, expect } from "bun:test";
import { NotifyAction, detectNotifier } from "../../src/actions/notify";
import { createLogger } from "../../src/logger";
import type { PullRequest, RepoConfig } from "../../src/types";

const logger = createLogger({ file: "/tmp/heimdall-notify-test.log", level: "debug" });

const pr: PullRequest = {
  number: 42,
  title: "Fix the thing",
  url: "https://github.com/org/repo/pull/42",
  headRefName: "feature/fix",
  baseRefName: "main",
  repo: "org/repo",
  author: "alice",
};

const repoConfig: RepoConfig = {
  prompt: "review {{pr_number}}",
  cwd: "/tmp",
};

describe("NotifyAction", () => {
  it("detects available notifier", () => {
    const notifier = detectNotifier();
    expect(["terminal-notifier", "osascript", "none"]).toContain(notifier);
  });

  it("executes without throwing", async () => {
    const action = new NotifyAction("Glass", logger);
    const result = await action.execute(pr, repoConfig);
    expect(result.action).toBe("notify");
    expect(result.success).toBe(true);
  });
});
