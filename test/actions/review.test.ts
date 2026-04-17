import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { ReviewAction, buildPrompt } from "../../src/actions/review";
import { createLogger } from "../../src/logger";
import { mkdirSync, rmSync, existsSync } from "fs";
import type { PullRequest, RepoConfig } from "../../src/types";

const logger = createLogger({ file: "/tmp/heimdall-review-test.log", level: "debug" });
const REPORTS_DIR = "/tmp/heimdall-review-test-reports";
const WORKTREE_DIR = "/tmp/heimdall-review-test-worktrees";

const pr: PullRequest = {
  number: 42,
  title: "Fix the thing",
  url: "https://github.com/org/repo/pull/42",
  headRefName: "feature/fix",
  baseRefName: "main",
  repo: "org/repo",
  author: "alice",
};

describe("ReviewAction", () => {
  beforeEach(() => {
    mkdirSync(REPORTS_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(REPORTS_DIR)) rmSync(REPORTS_DIR, { recursive: true });
  });

  it("builds prompt with pr_number substitution", () => {
    const prompt = buildPrompt("/signaliq-code-review {{pr_number}}", pr);
    expect(prompt).toBe("/signaliq-code-review 42");
  });

  it("builds prompt with multiple placeholders", () => {
    const prompt = buildPrompt(
      "Review PR #{{pr_number}} '{{pr_title}}' by {{pr_author}} on {{pr_repo}}",
      pr
    );
    expect(prompt).toBe("Review PR #42 'Fix the thing' by alice on org/repo");
  });

  it("builds prompt with BRANCH_OR_PR and BASE_BRANCH substitution", () => {
    const prompt = buildPrompt(
      "Review branch {{BRANCH_OR_PR}} against {{BASE_BRANCH}}",
      pr
    );
    expect(prompt).toBe("Review branch feature/fix against main");
  });

  it("builds prompt with mixed old and new template vars", () => {
    const prompt = buildPrompt(
      "PR #{{pr_number}} on {{BRANCH_OR_PR}} (base: {{BASE_BRANCH}}) by {{pr_author}}",
      pr
    );
    expect(prompt).toBe("PR #42 on feature/fix (base: main) by alice");
  });

  it("generates correct report path", () => {
    const action = new ReviewAction(
      "claude",
      ["-p", "--output-format", "text"],
      REPORTS_DIR,
      WORKTREE_DIR,
      logger
    );
    const path = action.reportPath(pr);
    expect(path).toContain("org/repo");
    expect(path).toContain("PR-42.md");
  });
});
