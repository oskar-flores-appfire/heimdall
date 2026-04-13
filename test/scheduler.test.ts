import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { runCycle } from "../src/scheduler";
import { createLogger } from "../src/logger";
import { mkdirSync, rmSync, existsSync } from "fs";
import type { Source, Action, PullRequest, RepoConfig, ActionResult, HeimdallConfig } from "../src/types";
import { StateManager } from "../src/state";
import { DEFAULT_CONFIG } from "../src/config";

const TEST_DIR = "/tmp/heimdall-scheduler-test";
const logger = createLogger({ file: `${TEST_DIR}/test.log`, level: "debug" });

const fakePr: PullRequest = {
  number: 99,
  title: "Fake PR",
  url: "https://github.com/org/repo/pull/99",
  headRefName: "feature/fake",
  baseRefName: "main",
  repo: "org/repo",
  author: "tester",
};

class FakeSource implements Source {
  name = "fake";
  constructor(private prs: PullRequest[]) {}
  async poll() { return this.prs; }
}

class FakeAction implements Action {
  name = "fake";
  calls: PullRequest[] = [];
  async execute(pr: PullRequest, _rc: RepoConfig): Promise<ActionResult> {
    this.calls.push(pr);
    return { action: "fake", success: true };
  }
}

describe("Scheduler", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("runs actions for new PRs only", async () => {
    const state = new StateManager(`${TEST_DIR}/seen.json`);
    const source = new FakeSource([fakePr]);
    const action = new FakeAction();

    const config: HeimdallConfig = {
      ...DEFAULT_CONFIG,
      actions: {
        ...DEFAULT_CONFIG.actions,
        review: {
          ...DEFAULT_CONFIG.actions.review,
          repos: { "org/repo": { prompt: "review {{pr_number}}", cwd: "/tmp" } },
        },
      },
    };

    // First cycle: PR is new
    await runCycle(source, [action], state, config, logger);
    expect(action.calls).toHaveLength(1);
    expect(action.calls[0].number).toBe(99);

    // Second cycle: PR already seen
    const action2 = new FakeAction();
    await runCycle(source, [action2], state, config, logger);
    expect(action2.calls).toHaveLength(0);
  });

  it("handles source errors gracefully", async () => {
    const state = new StateManager(`${TEST_DIR}/seen.json`);
    const badSource: Source = {
      name: "bad",
      async poll() { throw new Error("network down"); },
    };
    const action = new FakeAction();

    await runCycle(badSource, [action], state, DEFAULT_CONFIG, logger);
    expect(action.calls).toHaveLength(0);
  });
});
