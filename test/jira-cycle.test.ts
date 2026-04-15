import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { runJiraCycle } from "../src/jira-cycle";
import { StateManager } from "../src/state";
import { mkdirSync, rmSync, existsSync } from "fs";
import type { JiraIssue, TriageReport } from "../src/types";
import type { Logger } from "../src/logger";

const TEST_DIR = "/tmp/heimdall-jira-cycle-test";
const TEST_STATE = `${TEST_DIR}/seen.json`;

const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

const testIssue: JiraIssue = {
  key: "PROJ-1",
  title: "Test issue",
  description: "Test",
  url: "https://test.atlassian.net/browse/PROJ-1",
  project: "PROJ",
  assignee: "test@example.com",
  status: "To Do",
  issueType: "Story",
};

const readyReport: TriageReport = {
  issue: testIssue,
  result: {
    criteria: { acceptance_clarity: 3, scope_boundedness: 2, technical_detail: 2 },
    total: 7,
    max: 9,
    size: "M",
    verdict: "Well-defined",
    concerns: "None",
    suggested_files: [],
  },
  verdict: "ready",
  timestamp: new Date().toISOString(),
};

describe("runJiraCycle", () => {
  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("skips already-seen issues", async () => {
    const state = new StateManager(TEST_STATE);
    await state.markKey("jira:test.atlassian.net", "PROJ-1");

    const pollFn = mock(() => Promise.resolve([testIssue]));
    const triageFn = mock(() => Promise.resolve(readyReport));
    const notifyFn = mock(() => Promise.resolve());

    await runJiraCycle({
      poll: pollFn,
      triage: triageFn,
      notify: notifyFn,
      state,
      namespace: "jira:test.atlassian.net",
      logger: noopLogger,
    });

    expect(triageFn).not.toHaveBeenCalled();
  });

  it("triages and notifies new issues", async () => {
    const state = new StateManager(TEST_STATE);

    const pollFn = mock(() => Promise.resolve([testIssue]));
    const triageFn = mock(() => Promise.resolve(readyReport));
    const notifyFn = mock(() => Promise.resolve());

    await runJiraCycle({
      poll: pollFn,
      triage: triageFn,
      notify: notifyFn,
      state,
      namespace: "jira:test.atlassian.net",
      logger: noopLogger,
    });

    expect(triageFn).toHaveBeenCalledTimes(1);
    expect(notifyFn).toHaveBeenCalledTimes(1);
  });

  it("marks triaged issues as seen", async () => {
    const state = new StateManager(TEST_STATE);

    await runJiraCycle({
      poll: () => Promise.resolve([testIssue]),
      triage: () => Promise.resolve(readyReport),
      notify: () => Promise.resolve(),
      state,
      namespace: "jira:test.atlassian.net",
      logger: noopLogger,
    });

    expect(await state.hasBeenSeen("jira:test.atlassian.net", "PROJ-1")).toBe(true);
  });
});
