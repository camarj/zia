export type { RiskLevel, ToolCall } from "./approval.js";
export { PolicyClassifier, MalformedPoliciesError, classifyToolCall } from "./approval.js";

export type { ToolResultContent, ToolResult, WrappableTool } from "./types.js";

export { ApprovalSerializer } from "./serializer.js";

export type {
  Decision,
  ApprovalRequest,
  ApprovalResolver,
  PendingApproval,
} from "./queue.js";
export { ApprovalQueue } from "./queue.js";

export type { AuditEntry, AuditLog } from "./audit-log.js";
export { JsonlAuditLog } from "./audit-log.js";

export { wrapToolsWithApproval } from "./tool-gate.js";
export type { ToolGateDeps } from "./tool-gate.js";

export { TuiApprovalResolver } from "./tui-resolver.js";
export type { TuiApprovalResolverDeps } from "./tui-resolver.js";
