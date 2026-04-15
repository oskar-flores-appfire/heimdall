import { describe, it, expect } from "bun:test";
import { NotifyAction, detectNotifier } from "../../src/actions/notify";
import { createLogger } from "../../src/logger";
import type { PullRequest, RepoConfig, JiraIssue, TriageReport, TriageResult } from "../../src/types";

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

const testIssue: JiraIssue = {
  key: "PROJ-123",
  title: "Auth middleware refactor",
  description: "Test description",
  url: "https://test.atlassian.net/browse/PROJ-123",
  project: "PROJ",
  assignee: "test@example.com",
  status: "To Do",
  issueType: "Story",
};

const testTriageReport: TriageReport = {
  issue: testIssue,
  result: {
    criteria: { acceptance_clarity: 2, scope_boundedness: 3, technical_detail: 2 },
    total: 7,
    max: 9,
    size: "M",
    verdict: "Well-defined",
    concerns: "None",
    suggested_files: ["src/auth.ts"],
  },
  verdict: "ready",
  timestamp: "2026-04-15T10:00:00Z",
};

describe("NotifyAction triage notifications", () => {
  it("notifyTriage returns success", async () => {
    const notify = new NotifyAction("Glass", logger);
    const result = await notify.notifyTriage(testIssue, testTriageReport);
    expect(result.action).toBe("notify");
  });

  it("notifyNeedsDetail returns success", async () => {
    const notify = new NotifyAction("Glass", logger);
    const needsDetail = { ...testTriageReport, verdict: "needs_detail" as const };
    const result = await notify.notifyNeedsDetail(testIssue, needsDetail);
    expect(result.action).toBe("notify");
  });

  it("notifyTooBig returns success", async () => {
    const notify = new NotifyAction("Glass", logger);
    const tooBig = { ...testTriageReport, verdict: "too_big" as const };
    tooBig.result = { ...tooBig.result, size: "XL" as const };
    const result = await notify.notifyTooBig(testIssue, tooBig);
    expect(result.action).toBe("notify");
  });

  it("notifyWorkerComplete returns success", async () => {
    const notify = new NotifyAction("Glass", logger);
    const result = await notify.notifyWorkerComplete("PROJ-123", "https://github.com/org/repo/pull/1", 7, "$0.47", "8m 34s");
    expect(result.action).toBe("notify");
  });

  it("notifyWorkerFailed returns success", async () => {
    const notify = new NotifyAction("Glass", logger);
    const result = await notify.notifyWorkerFailed("PROJ-123", "Tests failed");
    expect(result.action).toBe("notify");
  });
});
