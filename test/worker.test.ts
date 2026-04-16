import { describe, it, expect } from "bun:test";
import { calculateCost, parseStreamJson, formatDuration, buildImplementationPrompt } from "../src/worker";
import type { QueueItem, CostConfig } from "../src/types";

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
