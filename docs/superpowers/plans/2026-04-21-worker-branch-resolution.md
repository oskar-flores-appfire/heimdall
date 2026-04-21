# Worker Branch Resolution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the worker resolve branch names from repo conventions (CLAUDE.md, AGENTS.md, existing branches) via a lightweight Claude call before creating the worktree, and push the branch immediately so others can collaborate.

**Architecture:** New `resolveBranchName()` and `gatherBranchContext()` methods in `worker.ts`. A one-shot Claude call (sonnet) reads repo docs + branch list and returns a branch name. Fallback to `heimdall/<issueKey>` on any failure. Early push after worktree creation.

**Tech Stack:** Bun, git CLI, claude CLI

**Spec:** `docs/superpowers/specs/2026-04-21-worker-branch-resolution-design.md`

---

### Task 1: Add `issueType` to `QueueItem` and propagate it

**Files:**
- Modify: `src/types.ts:146-160` — add field to `QueueItem`
- Modify: `src/approve.ts:59-70` — populate `issueType` from triage report
- Modify: `src/approve.test.ts:34-40` — verify `issueType` is stored

- [ ] **Step 1: Write the failing test**

In `src/approve.test.ts`, update the existing "approves a ready issue" test to also assert `issueType`:

```ts
test("approves a ready issue", async () => {
  const result = await approveIssue("TEST-1", { heimdallDir: TEST_DIR, configPath: CONFIG_PATH });
  expect(result).toEqual({ ok: true });
  const queued = await Bun.file(join(QUEUE_DIR, "TEST-1.json")).json();
  expect(queued.issueKey).toBe("TEST-1");
  expect(queued.status).toBe("pending");
  expect(queued.issueType).toBe("");
});
```

Note: The test fixture `VALID_REPORT` already has `issueType: ""` in `issue`, so the expected value is `""`.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/approve.test.ts`
Expected: FAIL — `queued.issueType` is `undefined` because `approve.ts` doesn't set it.

- [ ] **Step 3: Add `issueType` to `QueueItem` type**

In `src/types.ts`, add after line 159 (`allowedTools?: string[];`):

```ts
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
```

- [ ] **Step 4: Populate `issueType` in `approve.ts`**

In `src/approve.ts`, add `issueType` to the QueueItem construction (after `allowedTools` on line 69):

```ts
  const item: QueueItem = {
    issueKey,
    title: report.issue.title,
    description: report.issue.description,
    approvedAt: new Date().toISOString(),
    status: "pending",
    triageReport: join(heimdallDir, "triage", `${issueKey}.md`),
    repo: projectConfig.repo,
    cwd: resolveHomePath(projectConfig.cwd),
    systemPromptFile: projectConfig.systemPromptFile,
    allowedTools: projectConfig.allowedTools,
    issueType: report.issue.issueType,
  };
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test src/approve.test.ts`
Expected: ALL PASS

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/approve.ts src/approve.test.ts
git commit -m "feat: add issueType to QueueItem and propagate from triage"
```

---

### Task 2: Add `gatherBranchContext()` pure function

**Files:**
- Modify: `src/worker.ts` — add exported function
- Create: `src/worker.test.ts` — test the pure function

- [ ] **Step 1: Write the failing test**

Create `src/worker.test.ts`:

```ts
import { test, expect } from "bun:test";
import { buildBranchResolutionPrompt } from "./worker";

test("buildBranchResolutionPrompt includes issue key and title", () => {
  const prompt = buildBranchResolutionPrompt({
    issueKey: "PROJ-42",
    title: "Add login page",
    issueType: "Story",
    claudeMd: "Branch naming: feature/KEY-slug",
    agentsMd: "",
    branches: ["origin/main", "origin/feature/PROJ-40-signup"],
  });

  expect(prompt).toContain("PROJ-42");
  expect(prompt).toContain("Add login page");
  expect(prompt).toContain("Story");
  expect(prompt).toContain("feature/KEY-slug");
  expect(prompt).toContain("feature/PROJ-40-signup");
});

test("buildBranchResolutionPrompt handles missing docs", () => {
  const prompt = buildBranchResolutionPrompt({
    issueKey: "PROJ-1",
    title: "Fix bug",
    issueType: undefined,
    claudeMd: null,
    agentsMd: null,
    branches: [],
  });

  expect(prompt).toContain("PROJ-1");
  expect(prompt).toContain("No CLAUDE.md found");
  expect(prompt).toContain("No AGENTS.md found");
  expect(prompt).toContain("No remote branches found");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/worker.test.ts`
Expected: FAIL — `buildBranchResolutionPrompt` is not exported from `worker.ts`.

- [ ] **Step 3: Implement `buildBranchResolutionPrompt`**

Add this exported function to `src/worker.ts` in the "Pure utility functions" section (after `buildImplementationPrompt`):

```ts
export interface BranchResolutionInput {
  issueKey: string;
  title: string;
  issueType?: string;
  claudeMd: string | null;
  agentsMd: string | null;
  branches: string[];
}

export function buildBranchResolutionPrompt(input: BranchResolutionInput): string {
  const docsSection = [
    input.claudeMd ?? "No CLAUDE.md found.",
    input.agentsMd ?? "No AGENTS.md found.",
  ].join("\n\n");

  const branchSection =
    input.branches.length > 0
      ? input.branches.join("\n")
      : "No remote branches found.";

  return `You are deciding the git branch name for a new issue.

## Issue
Key: ${input.issueKey}
Title: ${input.title}
Type: ${input.issueType || "unknown"}

## Repository conventions
${docsSection}

## Existing branches
${branchSection}

Based on the repository's documented conventions and existing branch naming patterns, reply with ONLY the branch name. Nothing else.`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/worker.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add src/worker.ts src/worker.test.ts
git commit -m "feat: add buildBranchResolutionPrompt pure function"
```

---

### Task 3: Add `parseBranchName()` pure function with validation

**Files:**
- Modify: `src/worker.ts` — add exported function
- Modify: `src/worker.test.ts` — add tests

- [ ] **Step 1: Write the failing tests**

Append to `src/worker.test.ts`:

```ts
import { buildBranchResolutionPrompt, parseBranchName } from "./worker";

test("parseBranchName extracts first non-empty line", () => {
  expect(parseBranchName("\n  feature/PROJ-42-login \n\nsome extra text")).toBe(
    "feature/PROJ-42-login"
  );
});

test("parseBranchName strips markdown code fences", () => {
  expect(parseBranchName("```\nfeature/PROJ-42-login\n```")).toBe(
    "feature/PROJ-42-login"
  );
});

test("parseBranchName returns null for empty response", () => {
  expect(parseBranchName("")).toBeNull();
  expect(parseBranchName("   \n  \n  ")).toBeNull();
});

test("parseBranchName returns null for names with spaces", () => {
  expect(parseBranchName("feature PROJ-42 login")).toBeNull();
});

test("parseBranchName returns null for names with invalid chars", () => {
  expect(parseBranchName("feature/PROJ~42")).toBeNull();
  expect(parseBranchName("feature/PROJ^42")).toBeNull();
  expect(parseBranchName("feature/PROJ:42")).toBeNull();
});

test("parseBranchName allows slashes and dashes", () => {
  expect(parseBranchName("bugfix/PROJ-42-fix-crash")).toBe(
    "bugfix/PROJ-42-fix-crash"
  );
});
```

Also update the import at the top of the file to include `parseBranchName`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/worker.test.ts`
Expected: FAIL — `parseBranchName` not exported.

- [ ] **Step 3: Implement `parseBranchName`**

Add to `src/worker.ts` in the pure utilities section:

```ts
export function parseBranchName(raw: string): string | null {
  // Strip markdown code fences
  const cleaned = raw.replace(/```\w*/g, "").trim();

  // Take first non-empty line
  const line = cleaned
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);

  if (!line) return null;

  // Basic git ref validation: no spaces, no ~^:?*[\, no double dots, no trailing dot/slash
  if (/[\s~^:?*\[\]\\]/.test(line)) return null;
  if (line.includes("..")) return null;
  if (line.endsWith(".") || line.endsWith("/")) return null;
  if (line.startsWith("-")) return null;

  return line;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/worker.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add src/worker.ts src/worker.test.ts
git commit -m "feat: add parseBranchName with git ref validation"
```

---

### Task 4: Add `gatherBranchContext()` method to Worker

**Files:**
- Modify: `src/worker.ts` — add private method to `Worker` class

This method is not unit-tested (it reads the filesystem and spawns git) — same pattern as other Worker methods.

- [ ] **Step 1: Add `gatherBranchContext` method**

Add this private method to the `Worker` class in `src/worker.ts`, after `createWorktree`:

```ts
  private async gatherBranchContext(
    cwd: string
  ): Promise<{ claudeMd: string | null; agentsMd: string | null; branches: string[] }> {
    // Read convention docs
    const claudeMdPath = join(cwd, "CLAUDE.md");
    const agentsMdPath = join(cwd, "AGENTS.md");
    const claudeMd = existsSync(claudeMdPath) ? await Bun.file(claudeMdPath).text() : null;
    const agentsMd = existsSync(agentsMdPath) ? await Bun.file(agentsMdPath).text() : null;

    // List remote branches (cap at 50)
    const proc = Bun.spawn(["git", "branch", "-r"], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);

    let branches: string[] = [];
    if (exitCode === 0) {
      branches = stdout
        .trim()
        .split("\n")
        .map((b) => b.trim())
        .filter((b) => b && !b.includes("->"))
        .slice(-50);
    }

    return { claudeMd, agentsMd, branches };
  }
```

- [ ] **Step 2: Run all tests to verify nothing broke**

Run: `bun test`
Expected: ALL PASS

- [ ] **Step 3: Commit**

```bash
git add src/worker.ts
git commit -m "feat: add gatherBranchContext to Worker class"
```

---

### Task 5: Add `resolveBranchName()` method to Worker

**Files:**
- Modify: `src/worker.ts` — add private method that orchestrates the resolution

- [ ] **Step 1: Add `resolveBranchName` method**

Add this private method to the `Worker` class, after `gatherBranchContext`:

```ts
  private async resolveBranchName(item: QueueItem): Promise<string> {
    const fallback = `heimdall/${item.issueKey}`;

    try {
      this.logger.info(`Resolving branch name for ${item.issueKey}`);
      const context = await this.gatherBranchContext(item.cwd);

      const prompt = buildBranchResolutionPrompt({
        issueKey: item.issueKey,
        title: item.title,
        issueType: item.issueType,
        claudeMd: context.claudeMd,
        agentsMd: context.agentsMd,
        branches: context.branches,
      });

      const triageModel = this.config.triage.model;
      const proc = Bun.spawn(
        ["claude", "-p", prompt, "--model", triageModel, "--output-format", "text"],
        { cwd: item.cwd, stdout: "pipe", stderr: "pipe" }
      );

      const timeout = setTimeout(() => proc.kill(), 30_000);
      const [exitCode, stdout] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      clearTimeout(timeout);

      if (exitCode !== 0) {
        this.logger.warn(`Branch resolution failed (exit ${exitCode}), using fallback: ${fallback}`);
        return fallback;
      }

      const resolved = parseBranchName(stdout);
      if (!resolved) {
        this.logger.warn(`Branch resolution returned invalid name, using fallback: ${fallback}`);
        return fallback;
      }

      this.logger.info(`Resolved branch name: ${resolved}`);
      return resolved;
    } catch (err) {
      this.logger.warn(`Branch resolution error: ${err}, using fallback: ${fallback}`);
      return fallback;
    }
  }
```

- [ ] **Step 2: Run all tests to verify nothing broke**

Run: `bun test`
Expected: ALL PASS

- [ ] **Step 3: Commit**

```bash
git add src/worker.ts
git commit -m "feat: add resolveBranchName to Worker class"
```

---

### Task 6: Wire branch resolution and early push into `processNext()`

**Files:**
- Modify: `src/worker.ts:175-205` — update `processNext()` flow

- [ ] **Step 1: Update `processNext()` to use branch resolution and early push**

Replace the hardcoded branch assignment and add early push. In `processNext()`, change lines 185-190 from:

```ts
    const worktreePath = join(this.worktreeDir, item.issueKey);
    const branch = `heimdall/${item.issueKey}`;

    try {
      await this.createWorktree(item.cwd, worktreePath, branch);
      await this.queue.update(item.issueKey, { branch });
```

To:

```ts
    const worktreePath = join(this.worktreeDir, item.issueKey);

    try {
      // Gate 1: Resolve branch name from repo conventions
      const branch = await this.resolveBranchName(item);

      // Gate 2: Create worktree and push branch for collaboration
      await this.createWorktree(item.cwd, worktreePath, branch);
      await this.queue.update(item.issueKey, { branch });
      await this.pushBranch(worktreePath, branch);
```

- [ ] **Step 2: Remove duplicate push before PR creation**

The existing flow already calls `pushBranch` later (around line 212 in the original). Since implementation may add commits, we still need a final push. But since `pushBranch` uses `-u`, the second call will just push new commits — no change needed there. Keep both pushes.

Actually, verify: the early push pushes an empty branch (just the base commit). The final push after implementation pushes the work. Both are needed. No code change here — just verify the logic is sound.

- [ ] **Step 3: Run all tests to verify nothing broke**

Run: `bun test`
Expected: ALL PASS

- [ ] **Step 4: Commit**

```bash
git add src/worker.ts
git commit -m "feat: wire branch resolution and early push into worker flow"
```

---

### Task 7: Manual integration test

**Files:** None — this is a verification step.

- [ ] **Step 1: Verify the full flow with a dry run**

Create a temporary queue item and check that branch resolution works end-to-end. Use an existing repo with a CLAUDE.md:

```bash
# Check the branch resolution prompt builds correctly
bun -e "
  const { buildBranchResolutionPrompt } = require('./src/worker');
  console.log(buildBranchResolutionPrompt({
    issueKey: 'TEST-1',
    title: 'Add login page',
    issueType: 'Story',
    claudeMd: 'Use feature/KEY-description branch naming.',
    agentsMd: null,
    branches: ['origin/main', 'origin/feature/TEST-0-signup'],
  }));
"
```

Expected: Well-formed prompt with all sections populated.

- [ ] **Step 2: Verify parseBranchName handles real Claude output**

```bash
bun -e "
  const { parseBranchName } = require('./src/worker');
  console.log(parseBranchName('feature/TEST-1-add-login-page'));
  console.log(parseBranchName('\`\`\`\nfeature/TEST-1\n\`\`\`'));
  console.log(parseBranchName(''));
"
```

Expected: `feature/TEST-1-add-login-page`, `feature/TEST-1`, `null`

- [ ] **Step 3: Run full test suite**

Run: `bun test`
Expected: ALL PASS

- [ ] **Step 4: Commit (no changes expected — just verification)**

If any fixes were needed, commit them:

```bash
git add -A
git commit -m "fix: address issues found during integration testing"
```
