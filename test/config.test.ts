import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { loadConfig, DEFAULT_CONFIG, resolveHomePath } from "../src/config";
import { mkdirSync, rmSync, existsSync } from "fs";

const TEST_DIR = "/tmp/heimdall-config-test";
const TEST_CONFIG = `${TEST_DIR}/config.json`;

describe("Config", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  it("returns defaults when no config file exists", async () => {
    const config = await loadConfig("/tmp/nonexistent/config.json");
    expect(config.interval).toBe(DEFAULT_CONFIG.interval);
    expect(config.actions.notify.sound).toBe("Glass");
  });

  it("merges user config over defaults", async () => {
    await Bun.write(TEST_CONFIG, JSON.stringify({ interval: 300 }));
    const config = await loadConfig(TEST_CONFIG);
    expect(config.interval).toBe(300);
    expect(config.actions.notify.sound).toBe("Glass");
  });

  it("resolves ~ in paths", () => {
    const resolved = resolveHomePath("~/.heimdall/reviews");
    expect(resolved).not.toContain("~");
    expect(resolved).toContain("heimdall/reviews");
  });
});
