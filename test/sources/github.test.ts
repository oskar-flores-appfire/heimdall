import { describe, it, expect } from "bun:test";
import { GitHubSource } from "../../src/sources/github";
import { createLogger } from "../../src/logger";

const logger = createLogger({ file: "/tmp/heimdall-gh-test.log", level: "debug" });

describe("GitHubSource", () => {
  it("parses gh pr list JSON output into PullRequest[]", async () => {
    const source = new GitHubSource(["appfire-team/signal-iq"], "review-requested", logger);

    const proc = Bun.spawnSync(["gh", "auth", "status"]);
    if (proc.exitCode !== 0) {
      console.log("Skipping: gh not authenticated");
      return;
    }

    const prs = await source.poll();
    for (const pr of prs) {
      expect(pr).toHaveProperty("number");
      expect(pr).toHaveProperty("title");
      expect(pr).toHaveProperty("url");
      expect(pr).toHaveProperty("repo");
      expect(pr).toHaveProperty("author");
      expect(typeof pr.number).toBe("number");
      expect(pr.repo).toBe("appfire-team/signal-iq");
    }
  });

  it("returns empty array when no PRs match", async () => {
    const source = new GitHubSource(
      ["appfire-team/nonexistent-repo-12345"],
      "review-requested",
      logger
    );
    const prs = await source.poll();
    expect(prs).toEqual([]);
  });
});
