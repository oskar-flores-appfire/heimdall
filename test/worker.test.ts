import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { calculateCost, parseStreamJson, formatDuration, buildImplementationPrompt } from "../src/worker";
import type { QueueItem, CostConfig } from "../src/types";
import { mkdirSync, rmSync, existsSync } from "fs";
import { join } from "path";

const testCosts: CostConfig = {
  "claude-opus-4-6": { inputPer1k: 0.015, outputPer1k: 0.075 },
  "claude-sonnet-4-6": { inputPer1k: 0.003, outputPer1k: 0.015 },
};

describe("calculateCost", () => {
  it("calculates cost from token counts", () => {
    const cost = calculateCost(82000, 12000, testCosts, "claude-opus-4-6");
    expect(cost).toBeCloseTo(2.13, 2);
  });

  it("returns 0 for unknown model", () => {
    expect(calculateCost(1000, 1000, testCosts, "unknown-model")).toBe(0);
  });
});

describe("parseStreamJson", () => {
  it("extracts token usage from stream-json lines", () => {
    const lines = [
      '{"type":"system","subtype":"init"}',
      '{"type":"assistant","message":{"content":"hello"},"usage":{"input_tokens":100,"output_tokens":50}}',
      '{"type":"result","result":"done","total_cost_usd":0.05,"usage":{"input_tokens":200,"output_tokens":80}}',
    ].join("\n");

    const parsed = parseStreamJson(lines);
    expect(parsed.inputTokens).toBe(200);
    expect(parsed.outputTokens).toBe(80);
  });

  it("handles empty input", () => {
    const parsed = parseStreamJson("");
    expect(parsed.inputTokens).toBe(0);
    expect(parsed.outputTokens).toBe(0);
  });
});

describe("formatDuration", () => {
  it("formats seconds to m:ss", () => {
    expect(formatDuration(514)).toBe("8m 34s");
  });

  it("formats < 60s", () => {
    expect(formatDuration(45)).toBe("0m 45s");
  });
});

describe("buildImplementationPrompt", () => {
  it("includes issue key and title", () => {
    const item: QueueItem = {
      issueKey: "PROJ-123",
      title: "Auth refactor",
      description: "Refactor auth to use JWT",
      approvedAt: "",
      status: "pending",
      triageReport: "/path/to/report.md",
      repo: "org/repo",
      cwd: "/path/to/repo",
    };
    const triageContent = "# Triage: PROJ-123\nScore: 7/9";
    const prompt = buildImplementationPrompt(item, triageContent, "/worktrees/PROJ-123");
    expect(prompt).toContain("PROJ-123");
    expect(prompt).toContain("Auth refactor");
    expect(prompt).toContain("Refactor auth to use JWT");
    expect(prompt).toContain("/worktrees/PROJ-123");
    expect(prompt).toContain("Score: 7/9");
  });
});

describe("QueueItem skill fields", () => {
  it("accepts optional systemPromptFile", () => {
    const item: QueueItem = {
      issueKey: "SIQ-42",
      title: "Test",
      description: "Test desc",
      approvedAt: "",
      status: "pending",
      triageReport: "/path/report.md",
      repo: "org/repo",
      cwd: "/path/to/repo",
      systemPromptFile: "~/code/signal-iq/.claude/skills/signal-iq-review",
    };
    expect(item.systemPromptFile).toBe("~/code/signal-iq/.claude/skills/signal-iq-review");
  });

  it("accepts optional allowedTools", () => {
    const item: QueueItem = {
      issueKey: "SIQ-42",
      title: "Test",
      description: "Test desc",
      approvedAt: "",
      status: "pending",
      triageReport: "/path/report.md",
      repo: "org/repo",
      cwd: "/path/to/repo",
      allowedTools: ["Read", "Edit"],
    };
    expect(item.allowedTools).toEqual(["Read", "Edit"]);
  });
});

const APPROVE_TEST_DIR = "/tmp/heimdall-approve-test";

describe("approve config forwarding", () => {
  beforeEach(() => {
    mkdirSync(APPROVE_TEST_DIR, { recursive: true });
    mkdirSync(join(APPROVE_TEST_DIR, "queue"), { recursive: true });
    mkdirSync(join(APPROVE_TEST_DIR, "triage"), { recursive: true });
  });

  afterEach(() => {
    if (existsSync(APPROVE_TEST_DIR)) rmSync(APPROVE_TEST_DIR, { recursive: true });
  });

  it("includes systemPromptFile in queue item when project config has it", async () => {
    const triageReport = {
      issue: { key: "SIQ-42", title: "Test", description: "Desc", url: "", project: "SIQ", assignee: "", status: "", issueType: "" },
      result: { criteria: { acceptance_clarity: 3, scope_boundedness: 3, technical_detail: 3 }, total: 9, max: 9, size: "S", verdict: "ready", concerns: "", suggested_files: [] },
      verdict: "ready",
      timestamp: new Date().toISOString(),
    };
    await Bun.write(join(APPROVE_TEST_DIR, "triage", "SIQ-42.json"), JSON.stringify(triageReport));
    await Bun.write(join(APPROVE_TEST_DIR, "triage", "SIQ-42.md"), "# Triage");

    const { QueueManager } = await import("../src/queue");
    const queue = new QueueManager(join(APPROVE_TEST_DIR, "queue"));

    const projectConfig = {
      repo: "appfire-team/signal-iq",
      cwd: "/code/signal-iq",
      systemPromptFile: "/code/signal-iq/.claude/skills/signal-iq-review",
      allowedTools: ["Read", "Edit"],
    };

    const item: import("../src/types").QueueItem = {
      issueKey: "SIQ-42",
      title: triageReport.issue.title,
      description: triageReport.issue.description,
      approvedAt: new Date().toISOString(),
      status: "pending",
      triageReport: join(APPROVE_TEST_DIR, "triage", "SIQ-42.md"),
      repo: projectConfig.repo,
      cwd: projectConfig.cwd,
      systemPromptFile: projectConfig.systemPromptFile,
      allowedTools: projectConfig.allowedTools,
    };

    await queue.enqueue(item);
    const retrieved = await queue.get("SIQ-42");
    expect(retrieved?.systemPromptFile).toBe("/code/signal-iq/.claude/skills/signal-iq-review");
    expect(retrieved?.allowedTools).toEqual(["Read", "Edit"]);
  });
});
