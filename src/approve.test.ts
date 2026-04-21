import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { approveIssue } from "./approve";

const TEST_DIR = "/tmp/heimdall-approve-test";
const TRIAGE_DIR = join(TEST_DIR, "triage");
const QUEUE_DIR = join(TEST_DIR, "queue");
const CONFIG_PATH = join(TEST_DIR, "config.json");

const VALID_REPORT = {
  issue: { key: "TEST-1", title: "Test issue", description: "desc", url: "", project: "TEST", assignee: "", status: "", issueType: "", referenceUrls: [] },
  result: { criteria: { acceptance_clarity: 3, scope_boundedness: 2, technical_detail: 2 }, total: 7, max: 9, size: "M", verdict: "ready", concerns: "", suggested_files: ["src/foo.ts"], feasibility: null, confidence: "high", confidence_reasoning: null },
  verdict: "ready",
  confidence: "high",
  timestamp: "2026-04-21T00:00:00.000Z",
};

const TEST_CONFIG = {
  sources: [{ type: "jira", baseUrl: "https://jira.example.com", email: "a@b.com", apiToken: "tok", jql: "", projects: { TEST: { repo: "org/repo", cwd: "/tmp/repo" } } }],
};

beforeEach(() => {
  mkdirSync(TRIAGE_DIR, { recursive: true });
  mkdirSync(QUEUE_DIR, { recursive: true });
  writeFileSync(join(TRIAGE_DIR, "TEST-1.json"), JSON.stringify(VALID_REPORT));
  writeFileSync(CONFIG_PATH, JSON.stringify(TEST_CONFIG));
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

test("approves a ready issue", async () => {
  const result = await approveIssue("TEST-1", { heimdallDir: TEST_DIR, configPath: CONFIG_PATH });
  expect(result).toEqual({ ok: true });
  const queued = await Bun.file(join(QUEUE_DIR, "TEST-1.json")).json();
  expect(queued.issueKey).toBe("TEST-1");
  expect(queued.status).toBe("pending");
});

test("rejects when no triage report exists", async () => {
  const result = await approveIssue("MISSING-1", { heimdallDir: TEST_DIR, configPath: CONFIG_PATH });
  expect(result).toEqual({ ok: false, error: "no-report" });
});

test("rejects when verdict is not ready", async () => {
  const notReady = { ...VALID_REPORT, verdict: "needs_detail" };
  writeFileSync(join(TRIAGE_DIR, "TEST-2.json"), JSON.stringify(notReady));
  const result = await approveIssue("TEST-2", { heimdallDir: TEST_DIR, configPath: CONFIG_PATH });
  expect(result).toEqual({ ok: false, error: "not-ready" });
});

test("returns ok when already queued (idempotent)", async () => {
  await approveIssue("TEST-1", { heimdallDir: TEST_DIR, configPath: CONFIG_PATH });
  const result = await approveIssue("TEST-1", { heimdallDir: TEST_DIR, configPath: CONFIG_PATH });
  expect(result).toEqual({ ok: true, alreadyQueued: true });
});

test("rejects when no project config found", async () => {
  const noProject = { ...VALID_REPORT, issue: { ...VALID_REPORT.issue, project: "UNKNOWN" } };
  writeFileSync(join(TRIAGE_DIR, "UNK-1.json"), JSON.stringify(noProject));
  const result = await approveIssue("UNK-1", { heimdallDir: TEST_DIR, configPath: CONFIG_PATH });
  expect(result).toEqual({ ok: false, error: "no-config" });
});
