import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { JiraSource, adfToText } from "../../src/sources/jira";
import type { JiraSourceConfig } from "../../src/types";
import type { Logger } from "../../src/logger";

const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

const testConfig: JiraSourceConfig = {
  type: "jira",
  baseUrl: "https://test.atlassian.net",
  email: "test@example.com",
  apiToken: "test-token",
  jql: "assignee = currentUser() AND status = 'To Do'",
  projects: {
    PROJ: { repo: "org/repo", cwd: "/path/to/repo" },
  },
};

const jiraApiResponse = {
  issues: [
    {
      key: "PROJ-123",
      fields: {
        summary: "Auth middleware refactor",
        description: {
          type: "doc",
          version: 1,
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: "Refactor the auth middleware to use JWT." }],
            },
          ],
        },
        status: { name: "To Do" },
        assignee: { emailAddress: "test@example.com" },
        issuetype: { name: "Story" },
        project: { key: "PROJ" },
      },
    },
  ],
};

describe("adfToText", () => {
  it("extracts text from ADF document", () => {
    const adf = jiraApiResponse.issues[0].fields.description;
    expect(adfToText(adf)).toBe("Refactor the auth middleware to use JWT.");
  });

  it("returns empty string for null/undefined", () => {
    expect(adfToText(null)).toBe("");
    expect(adfToText(undefined)).toBe("");
  });

  it("handles nested content with multiple paragraphs", () => {
    const adf = {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "Line 1." }] },
        { type: "paragraph", content: [{ type: "text", text: "Line 2." }] },
      ],
    };
    expect(adfToText(adf)).toBe("Line 1.\nLine 2.");
  });
});

describe("JiraSource", () => {
  it("polls and normalizes issues", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(JSON.stringify(jiraApiResponse), { status: 200 }))
    ) as any;

    const source = new JiraSource(testConfig, noopLogger);
    const issues = await source.poll();

    expect(issues).toHaveLength(1);
    expect(issues[0].key).toBe("PROJ-123");
    expect(issues[0].title).toBe("Auth middleware refactor");
    expect(issues[0].description).toBe("Refactor the auth middleware to use JWT.");
    expect(issues[0].url).toBe("https://test.atlassian.net/browse/PROJ-123");
    expect(issues[0].project).toBe("PROJ");

    globalThis.fetch = originalFetch;
  });

  it("sends correct auth header", async () => {
    let capturedHeaders: Headers | undefined;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock((url: string, init: RequestInit) => {
      capturedHeaders = new Headers(init.headers);
      return Promise.resolve(new Response(JSON.stringify({ issues: [] }), { status: 200 }));
    }) as any;

    const source = new JiraSource(testConfig, noopLogger);
    await source.poll();

    const authHeader = capturedHeaders!.get("Authorization")!;
    const decoded = atob(authHeader.replace("Basic ", ""));
    expect(decoded).toBe("test@example.com:test-token");

    globalThis.fetch = originalFetch;
  });

  it("returns empty array on API error", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response("Unauthorized", { status: 401 }))
    ) as any;

    const source = new JiraSource(testConfig, noopLogger);
    const issues = await source.poll();
    expect(issues).toHaveLength(0);

    globalThis.fetch = originalFetch;
  });
});
