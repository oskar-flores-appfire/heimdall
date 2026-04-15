import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { StateManager } from "../src/state";
import { existsSync, rmSync, mkdirSync } from "fs";
import type { PullRequest } from "../src/types";


const TEST_STATE = "/tmp/heimdall-state-test/seen.json";

const pr1: PullRequest = {
  number: 42,
  title: "Fix bug",
  url: "https://github.com/org/repo/pull/42",
  headRefName: "feature/fix",
  baseRefName: "main",
  repo: "org/repo",
  author: "alice",
};

const pr2: PullRequest = {
  number: 53,
  title: "Add feature",
  url: "https://github.com/org/repo/pull/53",
  headRefName: "feature/add",
  baseRefName: "main",
  repo: "org/repo",
  author: "bob",
};

describe("StateManager", () => {
  beforeEach(() => {
    mkdirSync("/tmp/heimdall-state-test", { recursive: true });
    if (existsSync(TEST_STATE)) rmSync(TEST_STATE);
  });

  afterEach(() => {
    rmSync("/tmp/heimdall-state-test", { recursive: true, force: true });
  });

  it("returns all PRs as new when state file is empty", async () => {
    const state = new StateManager(TEST_STATE);
    const newPrs = await state.filterNew([pr1, pr2]);
    expect(newPrs).toHaveLength(2);
  });

  it("filters out already-seen PRs", async () => {
    const state = new StateManager(TEST_STATE);
    await state.markSeen(pr1);
    const newPrs = await state.filterNew([pr1, pr2]);
    expect(newPrs).toHaveLength(1);
    expect(newPrs[0].number).toBe(53);
  });

  it("marks PR as reviewed with report path", async () => {
    const state = new StateManager(TEST_STATE);
    await state.markSeen(pr1);
    await state.markReviewed(pr1, "/path/to/report.md");
    const data = await Bun.file(TEST_STATE).json();
    expect(data["org/repo"]["42"].reviewed).toBe(true);
    expect(data["org/repo"]["42"].reportPath).toBe("/path/to/report.md");
  });

  it("prunes entries older than maxAgeDays", async () => {
    const state = new StateManager(TEST_STATE);
    const staleDate = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
    await Bun.write(
      TEST_STATE,
      JSON.stringify({
        "org/repo": {
          "1": { seenAt: staleDate, reviewed: true },
          "2": { seenAt: new Date().toISOString(), reviewed: true },
        },
      })
    );
    const state2 = new StateManager(TEST_STATE);
    await state2.prune(30);
    const data = await Bun.file(TEST_STATE).json();
    expect(data["org/repo"]["1"]).toBeUndefined();
    expect(data["org/repo"]["2"]).toBeDefined();
  });
});

describe("StateManager generic methods", () => {
  beforeEach(() => {
    mkdirSync("/tmp/heimdall-state-test", { recursive: true });
    if (existsSync(TEST_STATE)) rmSync(TEST_STATE);
  });

  afterEach(() => {
    rmSync("/tmp/heimdall-state-test", { recursive: true, force: true });
  });

  it("hasBeenSeen returns false for unseen keys", async () => {
    const state = new StateManager(TEST_STATE);
    expect(await state.hasBeenSeen("jira:test", "PROJ-123")).toBe(false);
  });

  it("hasBeenSeen returns true after markKey", async () => {
    const state = new StateManager(TEST_STATE);
    await state.markKey("jira:test", "PROJ-123");
    expect(await state.hasBeenSeen("jira:test", "PROJ-123")).toBe(true);
  });

  it("markKey stores custom entry data", async () => {
    const state = new StateManager(TEST_STATE);
    await state.markKey("jira:test", "PROJ-456", { reviewed: true });
    const data = await Bun.file(TEST_STATE).json();
    expect(data["jira:test"]["PROJ-456"].reviewed).toBe(true);
  });
});
