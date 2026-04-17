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

## Scoring Rubric
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
  "suggested_files": ["<files likely to need changes>"]
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
  return "ready";
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
