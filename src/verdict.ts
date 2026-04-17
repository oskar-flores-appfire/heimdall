import type { ReviewVerdict } from "./types";

export function parseVerdict(reportContent: string): ReviewVerdict {
  const match = reportContent.match(/VERDICT:\s*\*\*(.+?)\*\*/);
  if (!match) return "unknown";

  const raw = match[1].toLowerCase();
  if (raw.includes("pass") && raw.includes("conditional")) return "PASS (conditional)";
  if (raw.includes("pass")) return "PASS";
  if (raw.includes("fail")) return "FAIL";
  return "unknown";
}
