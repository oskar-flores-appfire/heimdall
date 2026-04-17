import { test, expect } from "bun:test";
import { parseVerdict } from "./verdict";

test("parses PASS verdict", () => {
  const content = `## VERDICT: **PASS**\n\nSome text`;
  expect(parseVerdict(content)).toBe("PASS");
});

test("parses PASS (conditional) verdict", () => {
  const content = `VERDICT: **PASS (conditional — fix violations before merge)**`;
  expect(parseVerdict(content)).toBe("PASS (conditional)");
});

test("parses FAIL verdict", () => {
  const content = `## VERDICT: **FAIL**`;
  expect(parseVerdict(content)).toBe("FAIL");
});

test("returns unknown when no verdict found", () => {
  const content = `# Code Review\n\nNo verdict here.`;
  expect(parseVerdict(content)).toBe("unknown");
});

test("handles verdict inside code block (real report format)", () => {
  const content = `\`\`\`\nVERDICT: **PASS (conditional — fix violations before merge)**\n\`\`\``;
  expect(parseVerdict(content)).toBe("PASS (conditional)");
});

test("parses plain text verdict without bold markers", () => {
  const content = `VERDICT: PASS (conditional — fix violations before merge)`;
  expect(parseVerdict(content)).toBe("PASS (conditional)");
});

test("parses plain FAIL verdict without bold markers", () => {
  const content = `VERDICT: FAIL`;
  expect(parseVerdict(content)).toBe("FAIL");
});
