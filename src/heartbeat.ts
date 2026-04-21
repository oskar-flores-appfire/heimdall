import { existsSync, readFileSync, writeFileSync, unlinkSync } from "fs";
import { join } from "path";

export interface WorkerStatus {
  state: "active" | "idle" | "dead";
  pid?: number;
}

const STALE_THRESHOLD_MS = 60_000;

export function getWorkerStatus(heimdallDir: string): WorkerStatus {
  const pidPath = join(heimdallDir, "worker.pid");
  const heartbeatPath = join(heimdallDir, "worker.heartbeat");

  if (!existsSync(pidPath)) return { state: "idle" };

  const pid = parseInt(readFileSync(pidPath, "utf-8").trim(), 10);

  if (!existsSync(heartbeatPath)) return { state: "dead", pid };

  const heartbeat = readFileSync(heartbeatPath, "utf-8").trim();
  const age = Date.now() - new Date(heartbeat).getTime();

  if (age > STALE_THRESHOLD_MS) return { state: "dead", pid };
  return { state: "active", pid };
}

export function writeHeartbeat(heimdallDir: string): void {
  writeFileSync(join(heimdallDir, "worker.heartbeat"), new Date().toISOString());
}

export function writePid(heimdallDir: string): void {
  writeFileSync(join(heimdallDir, "worker.pid"), String(process.pid));
}

export function clearHeartbeatFiles(heimdallDir: string): void {
  const pidPath = join(heimdallDir, "worker.pid");
  const heartbeatPath = join(heimdallDir, "worker.heartbeat");
  if (existsSync(pidPath)) unlinkSync(pidPath);
  if (existsSync(heartbeatPath)) unlinkSync(heartbeatPath);
}
