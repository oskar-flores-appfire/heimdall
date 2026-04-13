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

  it("executes start notification without throwing", async () => {
    const action = new NotifyAction("Glass", logger);
    const result = await action.notifyStart(pr);
    expect(result.action).toBe("notify");
    expect(result.success).toBe(true);
  });

  it("executes complete notification without throwing", async () => {
    const action = new NotifyAction("Glass", logger);
    const result = await action.notifyComplete(pr, "/tmp/review.md");
    expect(result.action).toBe("notify");
    expect(result.success).toBe(true);
  });

  it("detects batch threshold", () => {
    const action = new NotifyAction("Glass", logger, 5, 3);
    expect(action.shouldBatch(2)).toBe(false);
    expect(action.shouldBatch(4)).toBe(true);
  });

  it("detects max per cycle", () => {
    const action = new NotifyAction("Glass", logger, 5, 3);
    expect(action.exceedsMax(5)).toBe(false);
    expect(action.exceedsMax(6)).toBe(true);
  });
});
