import { appendFileSync, mkdirSync } from "fs";
import { dirname } from "path";
import type { LogLevel } from "./types";

const LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export interface Logger {
  debug(msg: string): void;
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

export function createLogger(config: { file: string; level: LogLevel }): Logger {
  const minLevel = LEVELS[config.level];
  mkdirSync(dirname(config.file), { recursive: true });

  function write(level: LogLevel, msg: string) {
    if (LEVELS[level] < minLevel) return;
    const line = `${new Date().toISOString()} [${level.toUpperCase()}] ${msg}\n`;
    appendFileSync(config.file, line);
    if (level === "error") {
      console.error(line.trimEnd());
    } else {
      console.log(line.trimEnd());
    }
  }

  return {
    debug: (msg) => write("debug", msg),
    info: (msg) => write("info", msg),
    warn: (msg) => write("warn", msg),
    error: (msg) => write("error", msg),
  };
}
