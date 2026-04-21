import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { getWorkerStatus } from "./heartbeat";

const TEST_DIR = "/tmp/heimdall-heartbeat-test";

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

test("returns idle when no PID file", () => {
  const status = getWorkerStatus(TEST_DIR);
  expect(status.state).toBe("idle");
});

test("returns dead when PID file exists but no heartbeat", () => {
  writeFileSync(join(TEST_DIR, "worker.pid"), "12345");
  const status = getWorkerStatus(TEST_DIR);
  expect(status.state).toBe("dead");
});

test("returns dead when heartbeat is stale (>60s)", () => {
  writeFileSync(join(TEST_DIR, "worker.pid"), "12345");
  const staleTime = new Date(Date.now() - 120_000).toISOString();
  writeFileSync(join(TEST_DIR, "worker.heartbeat"), staleTime);
  const status = getWorkerStatus(TEST_DIR);
  expect(status.state).toBe("dead");
});

test("returns active when heartbeat is fresh", () => {
  writeFileSync(join(TEST_DIR, "worker.pid"), "12345");
  writeFileSync(join(TEST_DIR, "worker.heartbeat"), new Date().toISOString());
  const status = getWorkerStatus(TEST_DIR);
  expect(status.state).toBe("active");
  expect(status.pid).toBe(12345);
});
