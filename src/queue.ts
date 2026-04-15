import { existsSync, unlinkSync } from "fs";
import { join } from "path";
import type { QueueItem } from "./types";

export class QueueManager {
  constructor(private readonly dir: string) {}

  async enqueue(item: QueueItem): Promise<void> {
    const path = join(this.dir, `${item.issueKey}.json`);
    await Bun.write(path, JSON.stringify(item, null, 2));
  }

  async get(issueKey: string): Promise<QueueItem | null> {
    const path = join(this.dir, `${issueKey}.json`);
    if (!existsSync(path)) return null;
    return Bun.file(path).json();
  }

  async list(): Promise<QueueItem[]> {
    const glob = new Bun.Glob("*.json");
    const items: QueueItem[] = [];
    for await (const file of glob.scan(this.dir)) {
      const item = await Bun.file(join(this.dir, file)).json();
      items.push(item);
    }
    return items.sort((a, b) => a.approvedAt.localeCompare(b.approvedAt));
  }

  async pickNext(): Promise<QueueItem | null> {
    const items = await this.list();
    return items.find((i) => i.status === "pending") ?? null;
  }

  async update(issueKey: string, updates: Partial<QueueItem>): Promise<void> {
    const item = await this.get(issueKey);
    if (!item) return;
    Object.assign(item, updates);
    await this.enqueue(item);
  }

  async remove(issueKey: string): Promise<void> {
    const path = join(this.dir, `${issueKey}.json`);
    if (existsSync(path)) unlinkSync(path);
  }
}
