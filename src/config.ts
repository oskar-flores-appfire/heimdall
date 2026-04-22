import { existsSync, mkdirSync, readFileSync } from "fs";
import { homedir } from "os";
import type { HeimdallConfig } from "./types";

export const HEIMDALL_DIR = `${homedir()}/.heimdall`;
export const DEFAULT_CONFIG_PATH = `${HEIMDALL_DIR}/config.json`;

export const DEFAULT_CONFIG: HeimdallConfig = {
  interval: 600,
  sources: [
    { type: "github", repos: [], trigger: "review-requested" },
  ],
  actions: {
    notify: { enabled: true, sound: "Glass", maxPerCycle: 5, batchThreshold: 3 },
    review: {
      enabled: true,
      repos: {},
    },
  },
  reports: { dir: `${HEIMDALL_DIR}/reviews` },
  log: { file: `${HEIMDALL_DIR}/heimdall.log`, level: "info" },
  triage: {
    threshold: 6,
    maxSize: "L",
    model: "sonnet",
    timeoutMinutes: 120,
  },
  worker: {
    maxParallel: 1,
    model: "opus",
    worktreeDir: `${HEIMDALL_DIR}/worktrees`,
    maxTurns: 100,
  },
  costs: {
    "claude-opus-4-6": { inputPer1k: 0.015, outputPer1k: 0.075 },
    "claude-sonnet-4-6": { inputPer1k: 0.003, outputPer1k: 0.015 },
  },
  server: { port: 7878 },
};

export function resolveHomePath(p: string): string {
  return p.startsWith("~") ? p.replace("~", homedir()) : p;
}

export function resolveSecret(value: string): string {
  if (value.startsWith("env:")) {
    const envVar = value.slice(4);
    const val = process.env[envVar];
    if (!val) throw new Error(`Environment variable ${envVar} is not set`);
    return val;
  }
  if (value.startsWith("file:")) {
    const filePath = resolveHomePath(value.slice(5));
    if (!existsSync(filePath)) throw new Error(`Secret file not found: ${filePath}`);
    return readFileSync(filePath, "utf-8").trim();
  }
  return value;
}

function deepMerge(target: any, source: any): any {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (
      source[key] &&
      typeof source[key] === "object" &&
      !Array.isArray(source[key]) &&
      target[key] &&
      typeof target[key] === "object" &&
      !Array.isArray(target[key])
    ) {
      result[key] = deepMerge(target[key], source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

export async function loadConfig(
  path: string = DEFAULT_CONFIG_PATH
): Promise<HeimdallConfig> {
  const resolvedPath = resolveHomePath(path);

  if (!existsSync(resolvedPath)) {
    return { ...DEFAULT_CONFIG };
  }

  const userConfig = await Bun.file(resolvedPath).json();
  return deepMerge(DEFAULT_CONFIG, userConfig) as HeimdallConfig;
}

export async function ensureHeimdallDir(): Promise<void> {
  for (const dir of [
    HEIMDALL_DIR,
    resolveHomePath(DEFAULT_CONFIG.reports.dir),
    `${HEIMDALL_DIR}/queue`,
    `${HEIMDALL_DIR}/triage`,
    `${HEIMDALL_DIR}/worktrees`,
    `${HEIMDALL_DIR}/review-worktrees`,
    `${HEIMDALL_DIR}/runs`,
  ]) {
    mkdirSync(dir, { recursive: true });
  }
}
