import type { JiraIssue, JiraSourceConfig } from "../types";
import type { Logger } from "../logger";
import { resolveSecret } from "../config";

export function adfToText(node: any): string {
  if (!node) return "";
  if (node.type === "text") return node.text || "";
  if (node.content && Array.isArray(node.content)) {
    const parts = node.content.map(adfToText);
    if (node.type === "doc") return parts.join("\n");
    return parts.join("");
  }
  return "";
}

export class JiraSource {
  readonly name = "jira";

  constructor(
    private readonly config: JiraSourceConfig,
    private readonly logger: Logger
  ) {}

  async poll(): Promise<JiraIssue[]> {
    const token = resolveSecret(this.config.apiToken);
    const auth = btoa(`${this.config.email}:${token}`);
    const jql = encodeURIComponent(this.config.jql);
    const fields = "summary,description,status,assignee,issuetype,project";
    const url = `${this.config.baseUrl}/rest/api/3/search/jql?jql=${jql}&fields=${fields}`;

    this.logger.info(`Polling Jira: ${this.config.baseUrl}`);

    try {
      const res = await fetch(url, {
        headers: {
          Authorization: `Basic ${auth}`,
          Accept: "application/json",
        },
      });

      if (!res.ok) {
        this.logger.error(`Jira API error: ${res.status} ${res.statusText}`);
        return [];
      }

      const data = await res.json();
      const issues: JiraIssue[] = (data.issues || []).map((issue: any) => ({
        key: issue.key,
        title: issue.fields.summary,
        description: adfToText(issue.fields.description),
        url: `${this.config.baseUrl}/browse/${issue.key}`,
        project: issue.fields.project.key,
        assignee: issue.fields.assignee?.emailAddress || "",
        status: issue.fields.status.name,
        issueType: issue.fields.issuetype.name,
      }));

      this.logger.info(`Found ${issues.length} Jira issue(s)`);
      return issues;
    } catch (err) {
      this.logger.error(`Jira poll failed: ${err}`);
      return [];
    }
  }
}
