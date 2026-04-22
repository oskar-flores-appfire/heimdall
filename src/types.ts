// --- Domain types ---

export interface PullRequest {
  number: number;
  title: string;
  url: string;
  headRefName: string;
  baseRefName: string;
  repo: string;
  author: string;
}

export type ReviewVerdict = "PASS" | "PASS (conditional)" | "FAIL" | "unknown";

export interface ActionResult {
  action: string;
  success: boolean;
  message?: string;
  reportPath?: string;
}

// --- Plugin interfaces ---

export interface Source {
  name: string;
  poll(): Promise<PullRequest[]>;
}

export interface Action {
  name: string;
  execute(pr: PullRequest, repoConfig: RepoConfig): Promise<ActionResult>;
}

// --- Config types ---

export interface HeimdallConfig {
  interval: number;
  sources: SourceConfig[];
  actions: ActionsConfig;
  reports: { dir: string };
  log: { file: string; level: LogLevel };
  triage: TriageConfig;
  worker: WorkerConfig;
  costs: CostConfig;
  server: { port: number };
}

export interface GitHubSourceConfig {
  type: "github";
  repos: string[];
  trigger: "review-requested";
}

export interface JiraProjectConfig {
  repo: string;
  cwd: string;
  systemPromptFile?: string;
  allowedTools?: string[];
}

export interface JiraSourceConfig {
  type: "jira";
  baseUrl: string;
  email: string;
  apiToken: string;
  jql: string;
  projects: Record<string, JiraProjectConfig>;
}

export type SourceConfig = GitHubSourceConfig | JiraSourceConfig;

export interface ActionsConfig {
  notify: { enabled: boolean; sound: string; maxPerCycle: number; batchThreshold: number };
  review: {
    enabled: boolean;
    repos: Record<string, RepoConfig>;
  };
}

export interface RepoConfig {
  prompt: string;
  cwd: string;
  systemPromptFile?: string;
  reviewPromptFile?: string;
  allowedTools?: string[];
}

export interface SeenEntry {
  seenAt: string;
  reviewed: boolean;
  reportPath?: string;
}

export type SeenState = Record<string, Record<string, SeenEntry>>;

export type LogLevel = "debug" | "info" | "warn" | "error";

// --- Jira types ---

export interface JiraIssue {
  key: string;
  title: string;
  description: string;
  url: string;
  project: string;
  assignee: string;
  status: string;
  issueType: string;
  referenceUrls: string[];
}

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

export type TriageVerdict = "ready" | "needs_detail" | "too_big" | "not_feasible";

export interface TriageReport {
  issue: JiraIssue;
  result: TriageResult;
  verdict: TriageVerdict;
  confidence: "high" | "medium" | "low" | null;
  timestamp: string;
}

export interface QueueItem {
  issueKey: string;
  title: string;
  description: string;
  approvedAt: string;
  status: "pending" | "in_progress" | "completed" | "failed";
  triageReport: string;
  repo: string;
  cwd: string;
  branch?: string;
  prUrl?: string;
  error?: string;
  systemPromptFile?: string;
  allowedTools?: string[];
  issueType?: string;
}

export interface ImplementationSummary {
  issueKey: string;
  title: string;
  triageScore: number;
  size: string;
  timings: { triageSeconds: number; implementationSeconds: number };
  cost: { inputTokens: number; outputTokens: number; cacheTokens: number; totalUsd: number };
  model: string;
  tests: { passing: number; failing: number };
  filesChanged: number;
  prUrl: string;
  status: "complete" | "incomplete";
  error?: string;
  implementationResult?: string;
  changedFiles?: string[];
}

// --- Config types (extended) ---

export interface TriageConfig {
  threshold: number;
  maxSize: "S" | "M" | "L" | "XL";
  model: string;
  timeoutMinutes: number;
}

export interface WorkerConfig {
  maxParallel: number;
  model: string;
  worktreeDir: string;
  maxTurns: number;
}

export interface CostConfig {
  [model: string]: { inputPer1k: number; outputPer1k: number };
}
