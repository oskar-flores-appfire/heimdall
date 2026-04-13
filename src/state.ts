import { existsSync, mkdirSync } from "fs";
import { dirname } from "path";
import type { PullRequest, SeenState, SeenEntry } from "./types";

export class StateManager {
  constructor(private readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
  }

  private async load(): Promise<SeenState> {
    if (!existsSync(this.path)) return {};
    return Bun.file(this.path).json();
  }

  private async save(state: SeenState): Promise<void> {
    await Bun.write(this.path, JSON.stringify(state, null, 2));
  }

  async filterNew(prs: PullRequest[]): Promise<PullRequest[]> {
    const state = await this.load();
    return prs.filter((pr) => {
      const repoState = state[pr.repo];
      if (!repoState) return true;
      return !repoState[String(pr.number)];
    });
  }

  async markSeen(pr: PullRequest): Promise<void> {
    const state = await this.load();
    if (!state[pr.repo]) state[pr.repo] = {};
    state[pr.repo][String(pr.number)] = {
      seenAt: new Date().toISOString(),
      reviewed: false,
    };
    await this.save(state);
  }

  async markReviewed(pr: PullRequest, reportPath: string): Promise<void> {
    const state = await this.load();
    if (!state[pr.repo]) state[pr.repo] = {};
    const entry = state[pr.repo][String(pr.number)];
    if (entry) {
      entry.reviewed = true;
      entry.reportPath = reportPath;
    } else {
      state[pr.repo][String(pr.number)] = {
        seenAt: new Date().toISOString(),
        reviewed: true,
        reportPath,
      };
    }
    await this.save(state);
  }

  async prune(maxAgeDays: number): Promise<void> {
    const state = await this.load();
    const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
    for (const repo of Object.keys(state)) {
      for (const prNum of Object.keys(state[repo])) {
        const entry = state[repo][prNum];
        if (new Date(entry.seenAt).getTime() < cutoff) {
          delete state[repo][prNum];
        }
      }
      if (Object.keys(state[repo]).length === 0) {
        delete state[repo];
      }
    }
    await this.save(state);
  }
}
