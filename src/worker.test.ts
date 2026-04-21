import { test, expect } from "bun:test";
import { buildBranchResolutionPrompt, parseBranchName } from "./worker";

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

test("parseBranchName rejects .lock suffix", () => {
  expect(parseBranchName("feature/foo.lock")).toBeNull();
});

test("parseBranchName rejects @{ sequence", () => {
  expect(parseBranchName("feature/@{foo")).toBeNull();
});

test("parseBranchName rejects consecutive slashes", () => {
  expect(parseBranchName("feature//foo")).toBeNull();
});

test("parseBranchName rejects control characters", () => {
  expect(parseBranchName("feature/\x01foo")).toBeNull();
});

test("parseBranchName allows slashes and dashes", () => {
  expect(parseBranchName("bugfix/PROJ-42-fix-crash")).toBe(
    "bugfix/PROJ-42-fix-crash"
  );
});
