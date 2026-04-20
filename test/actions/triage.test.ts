import { describe, it, expect, mock } from "bun:test";
import {
  buildTriagePrompt,
  parseTriageResult,
  evaluateVerdict,
} from "../../src/actions/triage";
import type { JiraIssue, TriageConfig, TriageResult, TriageReport, TriageVerdict } from "../../src/types";

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
  feasibility: {
    unmockable_dependencies: false,
    human_dependency: false,
    ambiguity_overload: false,
    reasoning: "All deps mockable, no human gates, clear scope",
  },
  confidence: "high" as const,
  confidence_reasoning: "Straightforward refactor with clear boundaries",
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

  it("includes agent feasibility section", () => {
    const prompt = buildTriagePrompt(testIssue);
    expect(prompt).toContain("Agent Feasibility");
    expect(prompt).toContain("unmockable_dependencies");
    expect(prompt).toContain("human_dependency");
    expect(prompt).toContain("ambiguity_overload");
  });

  it("includes confidence assessment section", () => {
    const prompt = buildTriagePrompt(testIssue);
    expect(prompt).toContain("Confidence Assessment");
    expect(prompt).toContain('"high"');
    expect(prompt).toContain('"medium"');
    expect(prompt).toContain('"low"');
  });

  it("includes feasibility and confidence in JSON output schema", () => {
    const prompt = buildTriagePrompt(testIssue);
    expect(prompt).toContain('"feasibility"');
    expect(prompt).toContain('"confidence"');
    expect(prompt).toContain('"confidence_reasoning"');
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

  it("returns not_feasible when unmockable_dependencies is true", () => {
    const infeasible = {
      ...validResult,
      feasibility: {
        ...validResult.feasibility,
        unmockable_dependencies: true,
        reasoning: "Requires production Stripe API",
      },
    };
    expect(evaluateVerdict(infeasible, triageConfig)).toBe("not_feasible");
  });

  it("returns not_feasible when human_dependency is true", () => {
    const infeasible = {
      ...validResult,
      feasibility: {
        ...validResult.feasibility,
        human_dependency: true,
        reasoning: "Needs design review before implementation",
      },
    };
    expect(evaluateVerdict(infeasible, triageConfig)).toBe("not_feasible");
  });

  it("returns not_feasible when ambiguity_overload is true", () => {
    const infeasible = {
      ...validResult,
      feasibility: {
        ...validResult.feasibility,
        ambiguity_overload: true,
        reasoning: "Too many open questions about auth flow",
      },
    };
    expect(evaluateVerdict(infeasible, triageConfig)).toBe("not_feasible");
  });

  it("too_big takes priority over not_feasible", () => {
    const both = {
      ...validResult,
      size: "XL" as const,
      feasibility: {
        ...validResult.feasibility,
        unmockable_dependencies: true,
        reasoning: "Requires prod API",
      },
    };
    expect(evaluateVerdict(both, triageConfig)).toBe("too_big");
  });

  it("needs_detail takes priority over not_feasible", () => {
    const both = {
      ...validResult,
      total: 3,
      feasibility: {
        ...validResult.feasibility,
        human_dependency: true,
        reasoning: "Needs stakeholder input",
      },
    };
    expect(evaluateVerdict(both, triageConfig)).toBe("needs_detail");
  });

  it("returns ready when feasibility is null", () => {
    const nullFeasibility = {
      ...validResult,
      feasibility: null,
      confidence: null,
      confidence_reasoning: null,
    };
    expect(evaluateVerdict(nullFeasibility, triageConfig)).toBe("ready");
  });
});

describe("type contracts", () => {
  it("TriageResult includes feasibility and confidence fields", () => {
    const result: TriageResult = {
      criteria: { acceptance_clarity: 2, scope_boundedness: 3, technical_detail: 2 },
      total: 7,
      max: 9,
      size: "M",
      verdict: "Well-defined",
      concerns: "None",
      suggested_files: ["src/auth.ts"],
      feasibility: {
        unmockable_dependencies: false,
        human_dependency: false,
        ambiguity_overload: false,
        reasoning: "All deps mockable, no human gates, scope is clear",
      },
      confidence: "high",
      confidence_reasoning: "Straightforward CRUD, familiar patterns",
    };
    expect(result.feasibility!.unmockable_dependencies).toBe(false);
    expect(result.confidence).toBe("high");
  });

  it("TriageVerdict includes not_feasible", () => {
    const v: TriageVerdict = "not_feasible";
    expect(v).toBe("not_feasible");
  });

  it("TriageReport includes confidence", () => {
    const report: TriageReport = {
      issue: testIssue,
      result: {
        criteria: { acceptance_clarity: 2, scope_boundedness: 3, technical_detail: 2 },
        total: 7,
        max: 9,
        size: "M",
        verdict: "Well-defined",
        concerns: "None",
        suggested_files: ["src/auth.ts"],
        feasibility: {
          unmockable_dependencies: false,
          human_dependency: false,
          ambiguity_overload: false,
          reasoning: "All mockable",
        },
        confidence: "high",
        confidence_reasoning: "Clear scope",
      },
      verdict: "ready",
      confidence: "high",
      timestamp: "2026-04-20T10:00:00Z",
    };
    expect(report.confidence).toBe("high");
  });
});
