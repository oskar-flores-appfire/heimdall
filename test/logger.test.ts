import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createLogger } from "../src/logger";
import { existsSync, unlinkSync } from "fs";

const TEST_LOG = "/tmp/heimdall-test.log";

describe("Logger", () => {
  beforeEach(() => {
    if (existsSync(TEST_LOG)) unlinkSync(TEST_LOG);
  });

  afterEach(() => {
    if (existsSync(TEST_LOG)) unlinkSync(TEST_LOG);
  });

  it("writes info messages to file", async () => {
    const log = createLogger({ file: TEST_LOG, level: "info" });
    log.info("hello world");
    await Bun.sleep(50);
    const content = await Bun.file(TEST_LOG).text();
    expect(content).toContain("hello world");
    expect(content).toContain("[INFO]");
  });

  it("respects log level", async () => {
    const log = createLogger({ file: TEST_LOG, level: "warn" });
    log.info("should not appear");
    log.warn("should appear");
    await Bun.sleep(50);
    const content = await Bun.file(TEST_LOG).text();
    expect(content).not.toContain("should not appear");
    expect(content).toContain("should appear");
  });

  it("includes timestamp", async () => {
    const log = createLogger({ file: TEST_LOG, level: "info" });
    log.info("timestamped");
    await Bun.sleep(50);
    const content = await Bun.file(TEST_LOG).text();
    expect(content).toMatch(/\d{4}-\d{2}-\d{2}T/);
  });
});
