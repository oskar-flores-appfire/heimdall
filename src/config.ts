import { existsSync, mkdirSync } from "fs";
import { homedir } from "os";
import type { HeimdallConfig } from "./types";

export const HEIMDALL_DIR = `${homedir()}/.heimdall`;
export const DEFAULT_CONFIG_PATH = `${HEIMDALL_DIR}/config.json`;

export const DEFAULT_CONFIG: HeimdallConfig = {
  interval: 600,
  sources: [
    {
      type: "github",
      repos: [],
      trigger: "review-requested",
    },
  ],
  actions: {
    notify: { enabled: true, sound: "Glass" },
    review: {
      enabled: true,
      command: "claude",
      defaultArgs: ["-p", "--permission-mode", "auto", "--output-format", "text"],
      repos: {},
    },
  },
  reports: { dir: `${HEIMDALL_DIR}/reviews` },
  log: { file: `${HEIMDALL_DIR}/heimdall.log`, level: "info" },
};

export function resolveHomePath(p: string): string {
  return p.startsWith("~") ? p.replace("~", homedir()) : p;
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
  mkdirSync(HEIMDALL_DIR, { recursive: true });
  mkdirSync(resolveHomePath(DEFAULT_CONFIG.reports.dir), { recursive: true });
}
