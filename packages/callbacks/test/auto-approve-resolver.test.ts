import { describe, expect, it } from "vitest";

import { AutoApproveResolver } from "../src/auto-approve-resolver.ts";
import type { ApprovalRequest } from "../src/queue.ts";

function req(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    toolCallId: "tc-1",
    toolName: "write_memory",
    riskLevel: "medio",
    params: {},
    ...overrides,
  };
}

describe("AutoApproveResolver", () => {
  it("approves every request with the self-describing system approver", async () => {
    const resolver = new AutoApproveResolver();
    const decision = await resolver.resolve(req());
    expect(decision.approved).toBe(true);
    expect(decision.approver).toBe("system:auto-approve");
  });

  it("approves regardless of risk level (medio and alto alike)", async () => {
    const resolver = new AutoApproveResolver();
    for (const riskLevel of ["medio", "alto"] as const) {
      const decision = await resolver.resolve(req({ riskLevel }));
      expect(decision.approved).toBe(true);
    }
  });

  it("exposes a stable APPROVER constant matching the decision approver", async () => {
    expect(AutoApproveResolver.APPROVER).toBe("system:auto-approve");
    const decision = await new AutoApproveResolver().resolve(req());
    expect(decision.approver).toBe(AutoApproveResolver.APPROVER);
  });
});
