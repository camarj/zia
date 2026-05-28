import { readFile } from "node:fs/promises";
import { join } from "node:path";

export type RiskLevel = "trivial" | "medio" | "alto";

export interface ToolCall {
  readonly toolName: string;
  readonly params: Record<string, unknown>;
}

export class MalformedPoliciesError extends Error {}

const RISK_RANK: Record<RiskLevel, number> = { trivial: 0, medio: 1, alto: 2 };

type RiskMap = ReadonlyMap<string, RiskLevel>;

function sectionRiskFromHeading(line: string): RiskLevel | undefined {
  const m = /^##\s+(\w+)/.exec(line);
  if (!m?.[1]) return undefined;
  const key = m[1].toLowerCase();
  if (key === "trivial") return "trivial";
  if (key === "medio") return "medio";
  if (key === "alto") return "alto";
  return undefined;
}

function extractToolTokens(text: string): string[] {
  return text
    .split(",")
    .map((t) => t.toLowerCase().trim())
    .filter((t) => /^[a-z0-9_]+$/.test(t));
}

function parsePolicies(policiesText: string): RiskMap {
  const riskMap = new Map<string, RiskLevel>();
  let current: RiskLevel | undefined = undefined;

  for (const line of policiesText.split("\n")) {
    // H1 (not H2) resets context
    if (/^#[^#]/.test(line)) {
      current = undefined;
      continue;
    }

    // H2 — try to detect a classified section
    if (line.startsWith("##")) {
      current = sectionRiskFromHeading(line);
      continue;
    }

    if (current === undefined) continue;

    // Standalone "Tools: ..." line (not inside parentheses)
    const standaloneMatch = /^\s*tools?:\s*(.+)$/i.exec(line);
    if (standaloneMatch?.[1]) {
      for (const token of extractToolTokens(standaloneMatch[1])) {
        const existing = riskMap.get(token);
        if (existing === undefined || RISK_RANK[current] > RISK_RANK[existing]) {
          riskMap.set(token, current);
        }
      }
      continue;
    }

    // Inline "(tools: ...)" or "(tool: ...)" annotation
    const inlineRegex = /\(tools?:\s*([^)]+)\)/gi;
    let match: RegExpExecArray | null;
    while ((match = inlineRegex.exec(line)) !== null) {
      if (!match[1]) continue;
      for (const token of extractToolTokens(match[1])) {
        const existing = riskMap.get(token);
        if (existing === undefined || RISK_RANK[current] > RISK_RANK[existing]) {
          riskMap.set(token, current);
        }
      }
    }
  }

  return riskMap;
}

export class PolicyClassifier {
  private constructor(private readonly riskMap: RiskMap) {}

  static fromPolicies(policiesText: string): PolicyClassifier {
    return new PolicyClassifier(parsePolicies(policiesText));
  }

  static async fromFichaDir(fichaDir: string): Promise<PolicyClassifier> {
    let text = "";
    try {
      text = await readFile(join(fichaDir, "POLICIES.md"), "utf8");
    } catch {
      /* absent → fail-safe: everything classifies alto */
    }
    return PolicyClassifier.fromPolicies(text);
  }

  classify(toolCall: Pick<ToolCall, "toolName">): RiskLevel {
    return this.riskMap.get(toolCall.toolName.toLowerCase()) ?? "alto";
  }
}

export function classifyToolCall(
  policiesText: string,
  toolCall: Pick<ToolCall, "toolName">
): RiskLevel {
  return PolicyClassifier.fromPolicies(policiesText).classify(toolCall);
}
