/**
 * Shared Claude CLI spawn utility.
 * Centralizes args, env, stderr capture, and permission mode
 * so bugs are fixed in one place.
 */

export interface ClaudeSpawnOptions {
  prompt: string;
  outputFormat: "text" | "json" | "stream-json";
  cwd?: string;
  model?: string;
  maxTurns?: number;
  systemPrompt?: string;
  allowedTools?: string[];
  timeout?: number;
}

export interface ClaudeSpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export async function spawnClaude(opts: ClaudeSpawnOptions): Promise<ClaudeSpawnResult> {
  const args = ["claude", "-p", opts.prompt];

  args.push("--permission-mode", "auto");
  args.push("--output-format", opts.outputFormat);

  if (opts.outputFormat === "stream-json") {
    args.push("--verbose");
  }

  if (opts.model) {
    args.push("--model", opts.model);
  }

  if (opts.maxTurns) {
    args.push("--max-turns", String(opts.maxTurns));
  }

  if (opts.systemPrompt) {
    args.push("--append-system-prompt", opts.systemPrompt);
  }

  if (opts.allowedTools?.length) {
    args.push("--allowlist-tools", opts.allowedTools.join(","));
  }

  const proc = Bun.spawn(args, {
    cwd: opts.cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, TERM: "dumb" },
  });

  let timer: Timer | undefined;
  if (opts.timeout) {
    timer = setTimeout(() => proc.kill(), opts.timeout);
  }

  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  if (timer) clearTimeout(timer);

  return { stdout, stderr, exitCode };
}
