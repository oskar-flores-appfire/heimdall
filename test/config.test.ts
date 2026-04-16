import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { loadConfig, DEFAULT_CONFIG, resolveHomePath, resolveSecret } from "../src/config";
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

describe("resolveSecret", () => {
  it("returns plain strings as-is", () => {
    expect(resolveSecret("my-token-123")).toBe("my-token-123");
  });

  it("resolves env: prefix to environment variable", () => {
    process.env.TEST_HEIMDALL_TOKEN = "secret-from-env";
    expect(resolveSecret("env:TEST_HEIMDALL_TOKEN")).toBe("secret-from-env");
    delete process.env.TEST_HEIMDALL_TOKEN;
  });

  it("throws when env var is not set", () => {
    expect(() => resolveSecret("env:NONEXISTENT_VAR_XYZ")).toThrow("not set");
  });

  it("resolves file: prefix by reading file contents", async () => {
    const secretFile = `${TEST_DIR}/test-secret`;
    await Bun.write(secretFile, "token-from-file\n");
    expect(resolveSecret(`file:${secretFile}`)).toBe("token-from-file");
  });

  it("throws when secret file does not exist", () => {
    expect(() => resolveSecret("file:/tmp/nonexistent-secret")).toThrow("not found");
  });
});

describe("JiraProjectConfig", () => {
  it("loads jira source with systemPromptFile in project config", async () => {
    const configWithSkill = {
      sources: [
        {
          type: "jira",
          baseUrl: "https://team.atlassian.net",
          email: "test@test.com",
          apiToken: "token",
          jql: "assignee = currentUser()",
          projects: {
            SIQ: {
              repo: "appfire-team/signal-iq",
              cwd: "~/code/signal-iq",
              systemPromptFile: "~/code/signal-iq/.claude/skills/signal-iq-review",
            },
          },
        },
      ],
    };
    await Bun.write(TEST_CONFIG, JSON.stringify(configWithSkill));
    const config = await loadConfig(TEST_CONFIG);
    const jiraSource = config.sources.find((s) => s.type === "jira");
    expect(jiraSource).toBeDefined();
    const jira = jiraSource as import("../src/types").JiraSourceConfig;
    expect(jira.projects.SIQ.systemPromptFile).toBe(
      "~/code/signal-iq/.claude/skills/signal-iq-review"
    );
  });

  it("loads jira source with allowedTools in project config", async () => {
    const configWithTools = {
      sources: [
        {
          type: "jira",
          baseUrl: "https://team.atlassian.net",
          email: "test@test.com",
          apiToken: "token",
          jql: "assignee = currentUser()",
          projects: {
            SIQ: {
              repo: "appfire-team/signal-iq",
              cwd: "~/code/signal-iq",
              allowedTools: ["Read", "Edit", "Write", "Bash"],
            },
          },
        },
      ],
    };
    await Bun.write(TEST_CONFIG, JSON.stringify(configWithTools));
    const config = await loadConfig(TEST_CONFIG);
    const jira = config.sources.find((s) => s.type === "jira") as import("../src/types").JiraSourceConfig;
    expect(jira.projects.SIQ.allowedTools).toEqual(["Read", "Edit", "Write", "Bash"]);
  });
});
