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
