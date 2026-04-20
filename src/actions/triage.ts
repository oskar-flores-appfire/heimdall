import { mkdirSync } from "fs";
import { join, dirname } from "path";
import type {
  JiraIssue,
  TriageResult,
  TriageVerdict,
  TriageReport,
  TriageConfig,
} from "../types";
import type { Logger } from "../logger";
import { HEIMDALL_DIR, resolveHomePath } from "../config";

const SIZE_ORDER = ["S", "M", "L", "XL"] as const;

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

export function parseTriageResult(raw: string): TriageResult {
  let text = raw.trim();
  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenceMatch) text = fenceMatch[1].trim();
  return JSON.parse(text) as TriageResult;
}

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

export class TriageAction {
  constructor(
    private readonly config: TriageConfig,
    private readonly logger: Logger
  ) {}

  async triage(issue: JiraIssue): Promise<TriageReport> {
    const prompt = buildTriagePrompt(issue);
    this.logger.info(`Triaging ${issue.key}: ${issue.title}`);

    const startTime = Date.now();
    const proc = Bun.spawn(
      ["claude", "-p", prompt, "--output-format", "json", "--model", this.config.model],
      { stdout: "pipe", stderr: "pipe", env: { ...process.env, TERM: "dumb" } }
    );

    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    if (exitCode !== 0) {
      this.logger.error(`Triage failed for ${issue.key}: ${stderr}`);
      throw new Error(`Triage claude process exited with code ${exitCode}: ${stderr}`);
    }

    let resultText = stdout;
    try {
      const jsonOutput = JSON.parse(stdout);
      if (jsonOutput.result) resultText = jsonOutput.result;
    } catch {
      // stdout may be the raw text if not wrapped in JSON envelope
    }

    const result = parseTriageResult(resultText);
    const verdict = evaluateVerdict(result, this.config);

    this.logger.info(`Triage ${issue.key}: score=${result.total}/${result.max} size=${result.size} verdict=${verdict} (${elapsed}s)`);

    const report: TriageReport = {
      issue,
      result,
      verdict,
      confidence: verdict === "ready" ? result.confidence : null,
      timestamp: new Date().toISOString(),
    };

    await this.saveReport(report);
    return report;
  }

  private async saveReport(report: TriageReport): Promise<void> {
    const path = this.reportPath(report.issue.key);
    mkdirSync(dirname(path), { recursive: true });

    const md = `# Triage: ${report.issue.key}

**Title:** ${report.issue.title}
**Type:** ${report.issue.issueType}
**Verdict:** ${report.verdict.toUpperCase()}
**Score:** ${report.result.total}/${report.result.max}
**Size:** ${report.result.size}
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
${report.result.suggested_files.map((f) => `- \`${f}\``).join("\n")}

---
*Triage report generated by Heimdall*
`;

    await Bun.write(path, md);
    await Bun.write(path.replace(".md", ".json"), JSON.stringify(report, null, 2));
    this.logger.info(`Triage report saved: ${path}`);
  }

  reportPath(issueKey: string): string {
    return join(resolveHomePath(`${HEIMDALL_DIR}/triage`), `${issueKey}.md`);
  }
}
