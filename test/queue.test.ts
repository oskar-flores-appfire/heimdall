import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { QueueManager } from "../src/queue";
import { mkdirSync, rmSync, existsSync } from "fs";
import type { QueueItem } from "../src/types";

const TEST_DIR = "/tmp/heimdall-queue-test";

function makeItem(key: string, status: QueueItem["status"] = "pending"): QueueItem {
  return {
    issueKey: key,
    title: `${key} title`,
    description: "test description",
    approvedAt: new Date().toISOString(),
    status,
    triageReport: `~/.heimdall/triage/${key}.md`,
    repo: "org/repo",
    cwd: "/path/to/repo",
  };
}

describe("QueueManager", () => {
  let queue: QueueManager;

  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
    queue = new QueueManager(TEST_DIR);
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("enqueue writes a JSON file", async () => {
    await queue.enqueue(makeItem("PROJ-1"));
    expect(existsSync(`${TEST_DIR}/PROJ-1.json`)).toBe(true);
  });

  it("list returns all items sorted by approvedAt", async () => {
    const item1 = makeItem("PROJ-1");
    item1.approvedAt = "2026-04-14T10:00:00Z";
    const item2 = makeItem("PROJ-2");
    item2.approvedAt = "2026-04-14T09:00:00Z";
    await queue.enqueue(item1);
    await queue.enqueue(item2);

    const items = await queue.list();
    expect(items).toHaveLength(2);
    expect(items[0].issueKey).toBe("PROJ-2");
  });

  it("pickNext returns oldest pending item", async () => {
    const item1 = makeItem("PROJ-1");
    item1.approvedAt = "2026-04-14T10:00:00Z";
    const item2 = makeItem("PROJ-2");
    item2.approvedAt = "2026-04-14T09:00:00Z";
    await queue.enqueue(item1);
    await queue.enqueue(item2);

    const next = await queue.pickNext();
    expect(next!.issueKey).toBe("PROJ-2");
  });

  it("pickNext returns null when queue is empty", async () => {
    const next = await queue.pickNext();
    expect(next).toBeNull();
  });

  it("pickNext skips non-pending items", async () => {
    await queue.enqueue(makeItem("PROJ-1", "in_progress"));
    await queue.enqueue(makeItem("PROJ-2", "pending"));

    const next = await queue.pickNext();
    expect(next!.issueKey).toBe("PROJ-2");
  });

  it("update persists status changes", async () => {
    await queue.enqueue(makeItem("PROJ-1"));
    await queue.update("PROJ-1", { status: "in_progress", branch: "heimdall/PROJ-1" });

    const item = await queue.get("PROJ-1");
    expect(item!.status).toBe("in_progress");
    expect(item!.branch).toBe("heimdall/PROJ-1");
  });

  it("get returns null for nonexistent item", async () => {
    const item = await queue.get("NONEXISTENT-999");
    expect(item).toBeNull();
  });

  it("remove deletes the queue file", async () => {
    await queue.enqueue(makeItem("PROJ-1"));
    await queue.remove("PROJ-1");
    expect(existsSync(`${TEST_DIR}/PROJ-1.json`)).toBe(false);
  });
});
