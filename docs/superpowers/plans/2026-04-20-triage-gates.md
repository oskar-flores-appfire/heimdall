# Triage Gates & Confidence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add agent feasibility and confidence gates to triage, with decision trace output (text + mermaid).

**Architecture:** Single Claude call with an enriched prompt that evaluates three sequential gates. Verdict logic in `evaluateVerdict` checks gates in order and short-circuits. Report generation appends a deterministic decision trace (text + mermaid diagram) built from structured gate results.

**Tech Stack:** Bun, TypeScript, bun:test

**Spec:** `docs/superpowers/specs/2026-04-20-triage-gates-design.md`

---

### Task 1: Update types

**Files:**
- Modify: `src/types.ts:113-134`

- [ ] **Step 1: Write the failing test**

In `test/actions/triage.test.ts`, add a test that references the new type fields:

```ts
import type { TriageResult, TriageReport, TriageVerdict } from "../../src/types";

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
    expect(result.feasibility.unmockable_dependencies).toBe(false);
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/actions/triage.test.ts`
Expected: TypeScript compilation errors — `feasibility`, `confidence`, `confidence_reasoning` don't exist on `TriageResult`, `not_feasible` not assignable to `TriageVerdict`, `confidence` doesn't exist on `TriageReport`.

- [ ] **Step 3: Update TriageResult in types.ts**

In `src/types.ts`, replace the `TriageResult` interface (lines 113-125):

```ts
export interface TriageResult {
  criteria: {
    acceptance_clarity: number;
    scope_boundedness: number;
    technical_detail: number;
  };
  total: number;
  max: number;
  size: "S" | "M" | "L" | "XL";
  verdict: string;
  concerns: string;
  suggested_files: string[];
  feasibility: {
    unmockable_dependencies: boolean;
    human_dependency: boolean;
    ambiguity_overload: boolean;
    reasoning: string;
  } | null;
  confidence: "high" | "medium" | "low" | null;
  confidence_reasoning: string | null;
}
```

Note: `feasibility`, `confidence`, and `confidence_reasoning` are nullable because gate 1 failures skip gates 2 and 3.

- [ ] **Step 4: Update TriageVerdict in types.ts**

Replace line 127:

```ts
export type TriageVerdict = "ready" | "needs_detail" | "too_big" | "not_feasible";
```

- [ ] **Step 5: Update TriageReport in types.ts**

Replace the `TriageReport` interface (lines 129-134):

```ts
export interface TriageReport {
  issue: JiraIssue;
  result: TriageResult;
  verdict: TriageVerdict;
  confidence: "high" | "medium" | "low" | null;
  timestamp: string;
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `bun test test/actions/triage.test.ts`
Expected: The new type contract tests pass. Existing tests may fail due to missing fields in their test fixtures — that's expected and will be fixed in Task 2.

- [ ] **Step 7: Commit**

```bash
git add src/types.ts test/actions/triage.test.ts
git commit -m "feat: add feasibility, confidence, and not_feasible to triage types"
```

---

### Task 2: Fix existing test fixtures

**Files:**
- Modify: `test/actions/triage.test.ts:27-35`
- Modify: `test/actions/notify.test.ts:67-80`

The type changes from Task 1 break existing test fixtures that lack the new fields. Fix them before proceeding.

- [ ] **Step 1: Update validResult in triage.test.ts**

Replace `validResult` (line 27-35) in `test/actions/triage.test.ts`:

```ts
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
```

- [ ] **Step 2: Update testTriageReport in notify.test.ts**

Replace `testTriageReport` (line 67-80) in `test/actions/notify.test.ts`:

```ts
const testTriageReport: TriageReport = {
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
  timestamp: "2026-04-15T10:00:00Z",
};
```

- [ ] **Step 3: Run all tests to verify everything passes**

Run: `bun test`
Expected: All tests pass.

- [ ] **Step 4: Commit**

```bash
git add test/actions/triage.test.ts test/actions/notify.test.ts
git commit -m "fix: update test fixtures for new triage type fields"
```

---

### Task 3: Update evaluateVerdict with gate 2 logic

**Files:**
- Modify: `src/actions/triage.ts:78-87`
- Modify: `test/actions/triage.test.ts`

- [ ] **Step 1: Write failing tests for the new verdict logic**

Add to `test/actions/triage.test.ts` inside the `evaluateVerdict` describe block:

```ts
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

it("returns ready when feasibility is null (gate 1 already failed)", () => {
  const nullFeasibility = {
    ...validResult,
    feasibility: null,
    confidence: null,
    confidence_reasoning: null,
  };
  // When feasibility is null, gate 2 is skipped — verdict depends on gate 1
  expect(evaluateVerdict(nullFeasibility, triageConfig)).toBe("ready");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/actions/triage.test.ts`
Expected: The `not_feasible` tests fail because `evaluateVerdict` doesn't check feasibility yet.

- [ ] **Step 3: Update evaluateVerdict**

In `src/actions/triage.ts`, replace `evaluateVerdict` (lines 78-87):

```ts
export function evaluateVerdict(
  result: TriageResult,
  config: TriageConfig
): TriageVerdict {
  const sizeIdx = SIZE_ORDER.indexOf(result.size);
  const maxIdx = SIZE_ORDER.indexOf(config.maxSize);
  if (sizeIdx > maxIdx || result.size === "XL") return "too_big";
  if (result.total < config.threshold) return "needs_detail";
  if (
    result.feasibility &&
    (result.feasibility.unmockable_dependencies ||
      result.feasibility.human_dependency ||
      result.feasibility.ambiguity_overload)
  ) {
    return "not_feasible";
  }
  return "ready";
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/actions/triage.test.ts`
Expected: All tests pass including the new not_feasible tests.

- [ ] **Step 5: Commit**

```bash
git add src/actions/triage.ts test/actions/triage.test.ts
git commit -m "feat: add gate 2 (feasibility) check to evaluateVerdict"
```

---

### Task 4: Update buildTriagePrompt

**Files:**
- Modify: `src/actions/triage.ts:15-68`
- Modify: `test/actions/triage.test.ts`

- [ ] **Step 1: Write failing tests**

Add to `test/actions/triage.test.ts` inside the `buildTriagePrompt` describe block:

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/actions/triage.test.ts`
Expected: FAIL — prompt doesn't contain the new sections yet.

- [ ] **Step 3: Update buildTriagePrompt**

In `src/actions/triage.ts`, replace `buildTriagePrompt` (lines 15-68):

```ts
export function buildTriagePrompt(issue: JiraIssue): string {
  return `You are evaluating a Jira issue for automated implementation by an AI coding agent.

## Issue
Key: ${issue.key}
Title: ${issue.title}
Type: ${issue.issueType}
Status: ${issue.status}

## Description
${issue.description}

## Gate 1: Scoring Rubric
Rate each criterion 0-3:

1. **acceptance_clarity** (0-3): Are acceptance criteria explicit and testable?
   - 0: No acceptance criteria
   - 1: Vague requirements
   - 2: Clear but incomplete criteria
   - 3: Explicit, testable acceptance criteria

2. **scope_boundedness** (0-3): Is the scope well-defined and contained?
   - 0: Unbounded, unclear scope
   - 1: Broad scope, many unknowns
   - 2: Mostly bounded, minor ambiguities
   - 3: Tightly scoped, clear boundaries

3. **technical_detail** (0-3): Is enough technical context provided?
   - 0: No technical context
   - 1: Minimal technical info
   - 2: Adequate context, some gaps
   - 3: Full technical context, files/APIs identified

## Size Estimate
- S: < 50 lines changed, 1-2 files
- M: 50-200 lines, 3-5 files
- L: 200-500 lines, 5-10 files
- XL: > 500 lines or > 10 files

## Gate 2: Agent Feasibility
Evaluate whether an AI coding agent can tackle this issue autonomously:

- **unmockable_dependencies** (true/false): Does this require real external systems that cannot be mocked or simulated? (production databases, hardware, third-party APIs without sandbox)
- **human_dependency** (true/false): Does this require design decisions, stakeholder sign-off, or cross-team coordination before coding can begin?
- **ambiguity_overload** (true/false): Would the agent need to ask 3+ clarifying questions before it could start?

If the total score is below 6 or size is XL, set feasibility to null.

## Gate 3: Confidence Assessment
If all feasibility signals are false, rate confidence that an AI agent can produce a mergeable PR on the first try:

- "high": Straightforward implementation, clear patterns, no unknowns
- "medium": Implementable but likely needs one round of human review on approach
- "low": Significant unknowns that would slow the agent down

If feasibility is null or any signal is true, set confidence and confidence_reasoning to null.

## Output
Respond with ONLY valid JSON (no markdown wrapping):
{
  "criteria": {
    "acceptance_clarity": <0-3>,
    "scope_boundedness": <0-3>,
    "technical_detail": <0-3>
  },
  "total": <sum of criteria>,
  "max": 9,
  "size": "<S|M|L|XL>",
  "verdict": "<one sentence assessment>",
  "concerns": "<what is missing or concerning>",
  "suggested_files": ["<files likely to need changes>"],
  "feasibility": {
    "unmockable_dependencies": <true|false>,
    "human_dependency": <true|false>,
    "ambiguity_overload": <true|false>,
    "reasoning": "<one sentence per signal>"
  } | null,
  "confidence": "<high|medium|low>" | null,
  "confidence_reasoning": "<one sentence justification>" | null
}`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/actions/triage.test.ts`
Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/actions/triage.ts test/actions/triage.test.ts
git commit -m "feat: add feasibility and confidence sections to triage prompt"
```

---

### Task 5: Add decision trace generators

**Files:**
- Modify: `src/actions/triage.ts`
- Modify: `test/actions/triage.test.ts`

- [ ] **Step 1: Write failing tests for buildDecisionTrace**

Add a new describe block to `test/actions/triage.test.ts`:

```ts
import {
  buildTriagePrompt,
  parseTriageResult,
  evaluateVerdict,
  buildDecisionTrace,
  buildMermaidDiagram,
} from "../../src/actions/triage";
```

```ts
describe("buildDecisionTrace", () => {
  it("shows all gates passing for ready verdict", () => {
    const trace = buildDecisionTrace(validResult, "ready", "high");
    expect(trace).toContain("Gate 1 (Specification): PASS");
    expect(trace).toContain("score 6/9, size M");
    expect(trace).toContain("Gate 2 (Feasibility): PASS");
    expect(trace).toContain("Gate 3 (Confidence): HIGH");
    expect(trace).toContain("Verdict: READY | Confidence: HIGH");
  });

  it("stops at gate 1 for needs_detail", () => {
    const lowScore = { ...validResult, total: 3 };
    const trace = buildDecisionTrace(lowScore, "needs_detail", null);
    expect(trace).toContain("Gate 1 (Specification): FAIL");
    expect(trace).toContain("Verdict: NEEDS_DETAIL");
    expect(trace).not.toContain("Gate 2");
    expect(trace).not.toContain("Gate 3");
  });

  it("stops at gate 1 for too_big", () => {
    const xl = { ...validResult, size: "XL" as const };
    const trace = buildDecisionTrace(xl, "too_big", null);
    expect(trace).toContain("Gate 1 (Specification): FAIL");
    expect(trace).toContain("Verdict: TOO_BIG");
  });

  it("stops at gate 2 for not_feasible", () => {
    const infeasible = {
      ...validResult,
      feasibility: {
        unmockable_dependencies: true,
        human_dependency: false,
        ambiguity_overload: false,
        reasoning: "Requires production Stripe API",
      },
    };
    const trace = buildDecisionTrace(infeasible, "not_feasible", null);
    expect(trace).toContain("Gate 1 (Specification): PASS");
    expect(trace).toContain("Gate 2 (Feasibility): FAIL");
    expect(trace).toContain("unmockable dependencies");
    expect(trace).toContain("Verdict: NOT_FEASIBLE");
    expect(trace).not.toContain("Gate 3");
  });
});
```

- [ ] **Step 2: Write failing tests for buildMermaidDiagram**

```ts
describe("buildMermaidDiagram", () => {
  it("generates all-green diagram for ready verdict", () => {
    const diagram = buildMermaidDiagram(validResult, "ready", "high");
    expect(diagram).toContain("graph TD");
    expect(diagram).toContain("PASS");
    expect(diagram).toContain("READY");
    expect(diagram).toContain("fill:#6f6");
  });

  it("generates red stop at gate 2 for not_feasible", () => {
    const infeasible = {
      ...validResult,
      feasibility: {
        unmockable_dependencies: true,
        human_dependency: false,
        ambiguity_overload: false,
        reasoning: "Requires prod Stripe API",
      },
    };
    const diagram = buildMermaidDiagram(infeasible, "not_feasible", null);
    expect(diagram).toContain("fill:#f66");
    expect(diagram).toContain("NOT FEASIBLE");
    expect(diagram).toContain("fill:#999"); // skipped gate 3
  });

  it("generates red stop at gate 1 for needs_detail", () => {
    const low = { ...validResult, total: 3 };
    const diagram = buildMermaidDiagram(low, "needs_detail", null);
    expect(diagram).toContain("NEEDS DETAIL");
    expect(diagram).toContain("fill:#f66");
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `bun test test/actions/triage.test.ts`
Expected: FAIL — `buildDecisionTrace` and `buildMermaidDiagram` don't exist yet.

- [ ] **Step 4: Implement buildDecisionTrace**

Add to `src/actions/triage.ts` after `evaluateVerdict`:

```ts
export function buildDecisionTrace(
  result: TriageResult,
  verdict: TriageVerdict,
  confidence: "high" | "medium" | "low" | null
): string {
  const lines: string[] = [];

  if (verdict === "too_big") {
    lines.push(`- Gate 1 (Specification): FAIL — size ${result.size} exceeds limit`);
    lines.push(`→ Verdict: TOO_BIG`);
    return lines.join("\n");
  }

  if (verdict === "needs_detail") {
    lines.push(`- Gate 1 (Specification): FAIL — score ${result.total}/${result.max}, below threshold`);
    lines.push(`→ Verdict: NEEDS_DETAIL`);
    return lines.join("\n");
  }

  lines.push(`- Gate 1 (Specification): PASS — score ${result.total}/${result.max}, size ${result.size}`);

  if (verdict === "not_feasible") {
    const reasons: string[] = [];
    if (result.feasibility?.unmockable_dependencies) reasons.push("unmockable dependencies");
    if (result.feasibility?.human_dependency) reasons.push("human dependency");
    if (result.feasibility?.ambiguity_overload) reasons.push("ambiguity overload");
    lines.push(`- Gate 2 (Feasibility): FAIL — ${reasons.join(", ")}`);
    lines.push(`→ Verdict: NOT_FEASIBLE`);
    return lines.join("\n");
  }

  lines.push(`- Gate 2 (Feasibility): PASS — no blockers`);
  lines.push(`- Gate 3 (Confidence): ${confidence!.toUpperCase()} — ${result.confidence_reasoning ?? ""}`);
  lines.push(`→ Verdict: READY | Confidence: ${confidence!.toUpperCase()}`);
  return lines.join("\n");
}
```

- [ ] **Step 5: Implement buildMermaidDiagram**

Add to `src/actions/triage.ts` after `buildDecisionTrace`:

```ts
export function buildMermaidDiagram(
  result: TriageResult,
  verdict: TriageVerdict,
  confidence: "high" | "medium" | "low" | null
): string {
  const lines: string[] = ["```mermaid", "graph TD"];

  if (verdict === "too_big") {
    lines.push(`    G1["Gate 1: Specification<br/>FAIL size ${result.size}"] --> V["TOO BIG"]`);
    lines.push(`    style G1 fill:#f66`);
    lines.push(`    style V fill:#f66`);
  } else if (verdict === "needs_detail") {
    lines.push(`    G1["Gate 1: Specification<br/>FAIL ${result.total}/${result.max}"] --> V["NEEDS DETAIL"]`);
    lines.push(`    style G1 fill:#f66`);
    lines.push(`    style V fill:#f66`);
  } else if (verdict === "not_feasible") {
    const reasons: string[] = [];
    if (result.feasibility?.unmockable_dependencies) reasons.push("unmockable deps");
    if (result.feasibility?.human_dependency) reasons.push("human dep");
    if (result.feasibility?.ambiguity_overload) reasons.push("ambiguity");
    lines.push(`    G1["Gate 1: Specification<br/>PASS ${result.total}/${result.max}, ${result.size}"] -->|PASS| G2["Gate 2: Feasibility<br/>FAIL: ${reasons.join(", ")}"]`);
    lines.push(`    G2 --> V["NOT FEASIBLE"]`);
    lines.push(`    G3["Gate 3: Confidence<br/>SKIPPED"]`);
    lines.push(`    style G1 fill:#6f6`);
    lines.push(`    style G2 fill:#f66`);
    lines.push(`    style V fill:#f66`);
    lines.push(`    style G3 fill:#999`);
  } else {
    lines.push(`    G1["Gate 1: Specification<br/>PASS ${result.total}/${result.max}, ${result.size}"] -->|PASS| G2["Gate 2: Feasibility<br/>PASS"]`);
    lines.push(`    G2 -->|PASS| G3["Gate 3: Confidence<br/>${confidence!.toUpperCase()}"]`);
    lines.push(`    G3 --> V["READY"]`);
    lines.push(`    style G1 fill:#6f6`);
    lines.push(`    style G2 fill:#6f6`);
    lines.push(`    style G3 fill:#6f6`);
    lines.push(`    style V fill:#6f6`);
  }

  lines.push("```");
  return lines.join("\n");
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `bun test test/actions/triage.test.ts`
Expected: All tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/actions/triage.ts test/actions/triage.test.ts
git commit -m "feat: add buildDecisionTrace and buildMermaidDiagram helpers"
```

---

### Task 6: Update TriageAction (triage method + saveReport)

**Files:**
- Modify: `src/actions/triage.ts:89-182`

- [ ] **Step 1: Update the triage method to populate confidence on the report**

In `src/actions/triage.ts`, in the `triage` method, replace lines 126-135:

```ts
    const result = parseTriageResult(resultText);
    const verdict = evaluateVerdict(result, this.config);
    const confidence = verdict === "ready" ? result.confidence : null;

    this.logger.info(
      `Triage ${issue.key}: score=${result.total}/${result.max} size=${result.size} verdict=${verdict}` +
      (confidence ? ` confidence=${confidence}` : "") +
      ` (${elapsed}s)`
    );

    const report: TriageReport = {
      issue,
      result,
      verdict,
      confidence,
      timestamp: new Date().toISOString(),
    };
```

- [ ] **Step 2: Update saveReport to include decision trace and mermaid**

Replace the `saveReport` method:

```ts
  private async saveReport(report: TriageReport): Promise<void> {
    const path = this.reportPath(report.issue.key);
    mkdirSync(dirname(path), { recursive: true });

    const trace = buildDecisionTrace(report.result, report.verdict, report.confidence);
    const diagram = buildMermaidDiagram(report.result, report.verdict, report.confidence);

    const suggestedFiles = report.result.suggested_files.map((f) => `- \`${f}\``).join("\n");
    const confidenceLine = report.confidence
      ? `\n**Confidence:** ${report.confidence.toUpperCase()}`
      : "";

    const md = `# Triage: ${report.issue.key}

**Title:** ${report.issue.title}
**Type:** ${report.issue.issueType}
**Verdict:** ${report.verdict.toUpperCase()}
**Score:** ${report.result.total}/${report.result.max}
**Size:** ${report.result.size}${confidenceLine}
**Triaged:** ${report.timestamp}

## Scores
| Criterion | Score |
|-----------|-------|
| Acceptance Clarity | ${report.result.criteria.acceptance_clarity}/3 |
| Scope Boundedness | ${report.result.criteria.scope_boundedness}/3 |
| Technical Detail | ${report.result.criteria.technical_detail}/3 |

## Assessment
${report.result.verdict}

## Concerns
${report.result.concerns}

## Suggested Files
${suggestedFiles}

## Decision Trace
${trace}

${diagram}

---
*Triage report generated by Heimdall*
`;

    await Bun.write(path, md);
    await Bun.write(path.replace(".md", ".json"), JSON.stringify(report, null, 2));
    this.logger.info(`Triage report saved: ${path}`);
  }
```

- [ ] **Step 3: Run tests to verify nothing broke**

Run: `bun test`
Expected: All tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/actions/triage.ts
git commit -m "feat: include confidence and decision trace in triage reports"
```

---

### Task 7: Add notifyNotFeasible and update notifyTriage

**Files:**
- Modify: `src/actions/notify.ts:90-109`
- Modify: `test/actions/notify.test.ts`

- [ ] **Step 1: Write failing tests**

Add to `test/actions/notify.test.ts` inside the triage notifications describe block:

```ts
it("notifyNotFeasible returns success", async () => {
  const notify = new NotifyAction("Glass", logger);
  const notFeasible: TriageReport = {
    ...testTriageReport,
    verdict: "not_feasible",
    confidence: null,
    result: {
      ...testTriageReport.result,
      feasibility: {
        unmockable_dependencies: true,
        human_dependency: false,
        ambiguity_overload: false,
        reasoning: "Requires production Stripe API",
      },
      confidence: null,
      confidence_reasoning: null,
    },
  };
  const result = await notify.notifyNotFeasible(testIssue, notFeasible);
  expect(result.action).toBe("notify");
  expect(result.success).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/actions/notify.test.ts`
Expected: FAIL — `notifyNotFeasible` doesn't exist.

- [ ] **Step 3: Add notifyNotFeasible method**

Add to `src/actions/notify.ts` after `notifyTooBig` (after line 146):

```ts
  async notifyNotFeasible(issue: JiraIssue, report: TriageReport): Promise<ActionResult> {
    const reasoning = report.result.feasibility?.reasoning ?? "Agent cannot tackle this autonomously";
    const message = `Not feasible — ${reasoning}`;
    try {
      await this.send(
        `Heimdall — ${issue.key}`,
        issue.title,
        message,
        issue.url,
        `heimdall-triage-${issue.key}`
      );
      this.logger.info(`Not-feasible notification: ${issue.key}`);
      return { action: "notify", success: true, message };
    } catch (err) {
      this.logger.error(`Not-feasible notification failed: ${err}`);
      return { action: "notify", success: false, message: String(err) };
    }
  }
```

- [ ] **Step 4: Update notifyTriage to show confidence**

Replace `notifyTriage` (lines 90-109) in `src/actions/notify.ts`:

```ts
  async notifyTriage(issue: JiraIssue, report: TriageReport): Promise<ActionResult> {
    const score = `${report.result.total}/${report.result.max}`;
    const files = report.result.suggested_files.length;
    const conf = report.confidence ? report.confidence : "unknown";
    const message = `Score: ${score} | Size: ${report.result.size} | Confidence: ${conf} | ${files} file(s)`;
    try {
      if (report.confidence === "low") {
        // Low confidence: no Approve button, just link to Jira
        await this.send(
          `Heimdall — ${issue.key}`,
          issue.title,
          `${message}\nLow confidence — review recommended`,
          issue.url,
          `heimdall-triage-${issue.key}`
        );
      } else {
        await this.sendTriage(
          `Heimdall — ${issue.key}`,
          issue.title,
          message,
          `heimdall triage ${issue.key}`,
          `heimdall approve ${issue.key}`,
          `heimdall-triage-${issue.key}`
        );
      }
      this.logger.info(`Triage notification sent: ${issue.key}`);
      return { action: "notify", success: true, message };
    } catch (err) {
      this.logger.error(`Triage notification failed: ${err}`);
      return { action: "notify", success: false, message: String(err) };
    }
  }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test test/actions/notify.test.ts`
Expected: All tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/actions/notify.ts test/actions/notify.test.ts
git commit -m "feat: add notifyNotFeasible and show confidence in triage notifications"
```

---

### Task 8: Update notification routing in run.ts

**Files:**
- Modify: `src/cli/run.ts:43-51`

- [ ] **Step 1: Update the notify callback**

Replace the `notify` callback (lines 43-51) in `src/cli/run.ts`:

```ts
        notify: async (issue, report) => {
          if (!notifyAction) return;
          if (report.verdict === "ready") {
            await notifyAction.notifyTriage(issue, report);
          } else if (report.verdict === "needs_detail") {
            await notifyAction.notifyNeedsDetail(issue, report);
          } else if (report.verdict === "not_feasible") {
            await notifyAction.notifyNotFeasible(issue, report);
          } else {
            await notifyAction.notifyTooBig(issue, report);
          }
        },
```

- [ ] **Step 2: Run tests to verify nothing broke**

Run: `bun test`
Expected: All tests pass.

- [ ] **Step 3: Commit**

```bash
git add src/cli/run.ts
git commit -m "feat: route not_feasible verdict to new notification method"
```

---

### Task 9: Update triage CLI

**Files:**
- Modify: `src/cli/triage.ts`

- [ ] **Step 1: Update triage.ts to show confidence and gate approve on verdict**

Replace the entire file `src/cli/triage.ts`:

```ts
import { existsSync } from "fs";
import { join } from "path";
import { HEIMDALL_DIR, resolveHomePath } from "../config";
import type { TriageReport } from "../types";

export async function triage(): Promise<void> {
  const issueKey = process.argv[3];
  if (!issueKey) {
    console.error("Usage: heimdall triage <ISSUE-KEY>");
    process.exit(1);
  }

  const reportDir = join(resolveHomePath(HEIMDALL_DIR), "triage");
  const mdPath = join(reportDir, `${issueKey}.md`);
  const jsonPath = join(reportDir, `${issueKey}.json`);

  if (!existsSync(mdPath)) {
    console.error(`No triage report found for ${issueKey}`);
    console.error(`Expected: ${mdPath}`);
    process.exit(1);
  }

  // Display the report
  const bat = Bun.spawnSync(["which", "bat"]);
  const viewer = bat.exitCode === 0 ? "bat" : "cat";
  const proc = Bun.spawn([viewer, mdPath], {
    stdout: "inherit",
    stderr: "inherit",
  });
  await proc.exited;

  // Check verdict from JSON report
  if (existsSync(jsonPath)) {
    const report: TriageReport = await Bun.file(jsonPath).json();

    if (report.verdict !== "ready") {
      console.log(`\nVerdict: ${report.verdict.toUpperCase()} — not eligible for approval.`);
      process.exit(0);
    }

    if (report.confidence === "low") {
      console.log(`\nVerdict: READY but confidence is LOW — review recommended before approval.`);
    }
  }

  process.stdout.write(`\nApprove ${issueKey} for Heimdall? [y/n]: `);
  const reader = Bun.stdin.stream().getReader();
  const { value } = await reader.read();
  reader.releaseLock();
  const answer = new TextDecoder().decode(value).trim().toLowerCase();

  if (answer === "y" || answer === "yes") {
    const { approve } = await import("./approve");
    process.argv[3] = issueKey;
    await approve();
  } else {
    console.log("Skipped.");
  }
}
```

- [ ] **Step 2: Run tests to verify nothing broke**

Run: `bun test`
Expected: All tests pass.

- [ ] **Step 3: Commit**

```bash
git add src/cli/triage.ts
git commit -m "feat: show confidence and gate approval on verdict in triage CLI"
```

---

### Task 10: Final integration verification

- [ ] **Step 1: Run full test suite**

Run: `bun test`
Expected: All tests pass.

- [ ] **Step 2: Type check**

Run: `bunx tsc --noEmit`
Expected: No type errors.

- [ ] **Step 3: Commit plan doc**

```bash
git add docs/superpowers/plans/2026-04-20-triage-gates.md
git commit -m "docs: add triage gates implementation plan"
```
