import { describe, it, expect, mock } from "bun:test";
import {
  buildTriagePrompt,
  parseTriageResult,
  evaluateVerdict,
} from "../../src/actions/triage";
import type { JiraIssue, TriageConfig } from "../../src/types";

const testIssue: JiraIssue = {
  key: "PROJ-123",
  title: "Auth middleware refactor",
  description: "Refactor auth middleware to use JWT. AC: tokens expire after 1h.",
  url: "https://test.atlassian.net/browse/PROJ-123",
  project: "PROJ",
  assignee: "test@example.com",
  status: "To Do",
  issueType: "Story",
};

const triageConfig: TriageConfig = {
  threshold: 6,
  maxSize: "L",
  model: "sonnet",
  timeoutMinutes: 120,
};

const validResult = {
  criteria: { acceptance_clarity: 2, scope_boundedness: 3, technical_detail: 1 },
  total: 6,
  max: 9,
  size: "M" as const,
  verdict: "Well-defined. Touches auth middleware and its tests.",
  concerns: "No error handling scenarios specified.",
  suggested_files: ["src/auth/middleware.ts"],
};

describe("buildTriagePrompt", () => {
  it("includes issue key and title", () => {
    const prompt = buildTriagePrompt(testIssue);
    expect(prompt).toContain("PROJ-123");
    expect(prompt).toContain("Auth middleware refactor");
  });

  it("includes issue description", () => {
    const prompt = buildTriagePrompt(testIssue);
    expect(prompt).toContain("Refactor auth middleware to use JWT");
  });

  it("includes scoring rubric", () => {
    const prompt = buildTriagePrompt(testIssue);
    expect(prompt).toContain("acceptance_clarity");
    expect(prompt).toContain("scope_boundedness");
    expect(prompt).toContain("technical_detail");
  });
});

describe("parseTriageResult", () => {
  it("parses valid JSON response", () => {
    const result = parseTriageResult(JSON.stringify(validResult));
    expect(result.total).toBe(6);
    expect(result.size).toBe("M");
    expect(result.criteria.acceptance_clarity).toBe(2);
  });

  it("extracts JSON from markdown-wrapped response", () => {
    const wrapped = "```json\n" + JSON.stringify(validResult) + "\n```";
    const result = parseTriageResult(wrapped);
    expect(result.total).toBe(6);
  });

  it("throws on invalid JSON", () => {
    expect(() => parseTriageResult("not json at all")).toThrow();
  });
});

describe("evaluateVerdict", () => {
  it("returns ready when score >= threshold and size <= maxSize", () => {
    expect(evaluateVerdict(validResult, triageConfig)).toBe("ready");
  });

  it("returns needs_detail when score < threshold", () => {
    const low = { ...validResult, total: 3 };
    expect(evaluateVerdict(low, triageConfig)).toBe("needs_detail");
  });

  it("returns too_big when size is XL", () => {
    const xl = { ...validResult, size: "XL" as const };
    expect(evaluateVerdict(xl, triageConfig)).toBe("too_big");
  });

  it("returns too_big when size exceeds maxSize", () => {
    const config = { ...triageConfig, maxSize: "S" as const };
    expect(evaluateVerdict(validResult, config)).toBe("too_big");
  });
});
