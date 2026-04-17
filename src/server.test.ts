import { test, expect, beforeAll, afterAll } from "bun:test";
import { startServer } from "./server";
import type { HeimdallConfig } from "./types";
import { createLogger } from "./logger";

const TEST_PORT = 18787;
let server: ReturnType<typeof Bun.serve>;

beforeAll(async () => {
  const logger = createLogger({ file: "/dev/null", level: "error" });
  const config = { server: { port: TEST_PORT }, reports: { dir: "/tmp/heimdall-test-reviews" } } as HeimdallConfig;
  server = startServer(config, logger);
});

afterAll(() => {
  server.stop();
});

test("GET / redirects to /reviews", async () => {
  const res = await fetch(`http://localhost:${TEST_PORT}/`, { redirect: "manual" });
  expect(res.status).toBe(302);
  expect(res.headers.get("Location")).toBe("/reviews");
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

