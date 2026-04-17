import { test, expect, beforeAll, afterAll } from "bun:test";
import { startServer, markdownToHtml } from "./server";
import type { HeimdallConfig } from "./types";
import { createLogger } from "./logger";

const TEST_PORT = 18787;
let server: ReturnType<typeof Bun.serve>;

beforeAll(async () => {
  const logger = createLogger({ file: "/dev/null", level: "error" });
  const config = { server: { port: TEST_PORT }, reports: { dir: "/tmp/heimdall-test-reviews" } } as HeimdallConfig;
  server = startServer(config, logger);
});

afterAll(() => {
  server.stop();
});

test("GET / redirects to /reviews", async () => {
  const res = await fetch(`http://localhost:${TEST_PORT}/`, { redirect: "manual" });
  expect(res.status).toBe(302);
  expect(res.headers.get("Location")).toBe("/reviews");
});

test("GET /reviews returns HTML", async () => {
  const res = await fetch(`http://localhost:${TEST_PORT}/reviews`);
  expect(res.status).toBe(200);
  expect(res.headers.get("Content-Type")).toContain("text/html");
});

test("GET /reviews/nonexistent/repo/PR-999 returns 404", async () => {
  const res = await fetch(`http://localhost:${TEST_PORT}/reviews/nonexistent/repo/PR-999`);
  expect(res.status).toBe(404);
});

test("markdownToHtml converts headers", () => {
  const html = markdownToHtml("# Title\n## Subtitle");
  expect(html).toContain("<h1>Title</h1>");
  expect(html).toContain("<h2>Subtitle</h2>");
});

test("markdownToHtml converts fenced code blocks", () => {
  const html = markdownToHtml("```typescript\nconst x = 1;\n```");
  expect(html).toContain("<pre>");
  expect(html).toContain("<code");
  expect(html).toContain("const x = 1;");
});

test("markdownToHtml converts bold and italic", () => {
  const html = markdownToHtml("**bold** and *italic*");
  expect(html).toContain("<strong>bold</strong>");
  expect(html).toContain("<em>italic</em>");
});

test("markdownToHtml converts tables", () => {
  const html = markdownToHtml("| A | B |\n|---|---|\n| 1 | 2 |");
  expect(html).toContain("<table>");
  expect(html).toContain("<th>");
  expect(html).toContain("<td>");
});

test("markdownToHtml converts unordered lists", () => {
  const html = markdownToHtml("- item one\n- item two");
  expect(html).toContain("<ul>");
  expect(html).toContain("<li>");
});

test("markdownToHtml preserves code blocks from other transforms", () => {
  const html = markdownToHtml("```\n| not a table |\n**not bold**\n```");
  expect(html).not.toContain("<table>");
  expect(html).not.toContain("<strong>");
});
