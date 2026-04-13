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
}

export interface SourceConfig {
  type: "github";
  repos: string[];
  trigger: "review-requested";
}

export interface ActionsConfig {
  notify: { enabled: boolean; sound: string; maxPerCycle: number; batchThreshold: number };
  review: {
    enabled: boolean;
    command: string;
    defaultArgs: string[];
    repos: Record<string, RepoConfig>;
  };
}

export interface RepoConfig {
  prompt: string;
  cwd: string;
  systemPromptFile?: string;
  allowedTools?: string[];
}

export interface SeenEntry {
  seenAt: string;
  reviewed: boolean;
  reportPath?: string;
}

export type SeenState = Record<string, Record<string, SeenEntry>>;

export type LogLevel = "debug" | "info" | "warn" | "error";
