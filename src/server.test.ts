// src/server.test.ts
import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { startServer } from "./server";
import type { HeimdallConfig } from "./types";
import { createLogger } from "./logger";

const TEST_PORT = 18787;
const TEST_HEIMDALL_DIR = "/tmp/heimdall-server-test";
const TEST_TRIAGE_DIR = join(TEST_HEIMDALL_DIR, "triage");
const TEST_QUEUE_DIR = join(TEST_HEIMDALL_DIR, "queue");
const TEST_REVIEWS_DIR = join(TEST_HEIMDALL_DIR, "reviews");
const TEST_CONFIG_PATH = join(TEST_HEIMDALL_DIR, "config.json");

let server: ReturnType<typeof Bun.serve>;

beforeAll(async () => {
  mkdirSync(TEST_TRIAGE_DIR, { recursive: true });
  mkdirSync(TEST_QUEUE_DIR, { recursive: true });
  mkdirSync(TEST_REVIEWS_DIR, { recursive: true });

  const triageReport = {
    issue: { key: "TEST-1", title: "Test issue", description: "desc", url: "https://jira.example.com/TEST-1", project: "TEST", assignee: "", status: "", issueType: "", referenceUrls: [] },
    result: { criteria: { acceptance_clarity: 3, scope_boundedness: 2, technical_detail: 2 }, total: 7, max: 9, size: "M", verdict: "ready", concerns: "", suggested_files: ["src/foo.ts"], feasibility: null, confidence: "high", confidence_reasoning: null },
    verdict: "ready",
    confidence: "high",
    timestamp: "2026-04-21T00:00:00.000Z",
  };
  writeFileSync(join(TEST_TRIAGE_DIR, "TEST-1.json"), JSON.stringify(triageReport));
  writeFileSync(join(TEST_TRIAGE_DIR, "TEST-1.md"), "# TEST-1 Triage\nSome content");

  const testConfig = {
    sources: [{ type: "jira", baseUrl: "https://jira.example.com", email: "a@b.com", apiToken: "tok", jql: "", projects: { TEST: { repo: "org/repo", cwd: "/tmp/repo" } } }],
  };
  writeFileSync(TEST_CONFIG_PATH, JSON.stringify(testConfig));

  const logger = createLogger({ file: "/dev/null", level: "error" });
  const config = { server: { port: TEST_PORT }, reports: { dir: TEST_REVIEWS_DIR } } as HeimdallConfig;
  server = startServer(config, logger, { heimdallDir: TEST_HEIMDALL_DIR, configPath: TEST_CONFIG_PATH });
});

afterAll(() => {
  server.stop();
  rmSync(TEST_HEIMDALL_DIR, { recursive: true, force: true });
});

test("GET / returns 200", async () => {
  const res = await fetch(`http://localhost:${TEST_PORT}/`);
  expect(res.status).toBe(200);
});

test("GET /reviews returns HTML", async () => {
  const res = await fetch(`http://localhost:${TEST_PORT}/reviews`);
  expect(res.status).toBe(200);
  expect(res.headers.get("Content-Type")).toContain("text/html");
});

test("GET /reviews/nonexistent/repo/PR-999 returns 404", async () => {
  const res = await fetch(`http://localhost:${TEST_PORT}/reviews/nonexistent/repo/PR-999`);
  expect(res.status).toBe(404);
});

test("GET /triage/TEST-1 shows approve button for ready verdict", async () => {
  const res = await fetch(`http://localhost:${TEST_PORT}/triage/TEST-1`);
  const html = await res.text();
  expect(html).toContain("Approve");
  expect(html).toContain("sticky-bar");
});

test("POST /triage/MISSING-1/approve returns redirect with error", async () => {
  const res = await fetch(`http://localhost:${TEST_PORT}/triage/MISSING-1/approve`, {
    method: "POST",
    redirect: "manual",
  });
  expect(res.status).toBe(303);
  expect(res.headers.get("Location")).toContain("error=no-report");
});
