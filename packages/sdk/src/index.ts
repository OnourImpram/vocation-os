export const AUTHORITY_OPERATIONS = [
  "health",
  "auto-apply-status",
  "auto-apply-kill",
  "auto-apply-rearm",
  "auto-apply-enable",
  "auto-apply-evaluate",
  "legacy-import-plan",
  "legacy-import-apply",
  "checkpoint-create",
  "checkpoint-verify",
  "approver-list",
  "approver-register",
  "approver-revoke",
  "audit-export"
] as const;

export type AuthorityOperation = (typeof AUTHORITY_OPERATIONS)[number];

export interface VocationTransportRequest {
  operation: AuthorityOperation;
  payload: unknown;
  requestId?: string;
  timeoutMs?: number;
}

export interface VocationTransport {
  execute(request: VocationTransportRequest): Promise<unknown>;
}

export interface VocationRequestOptions {
  requestId?: string;
  timeoutMs?: number;
}

export class VocationClient {
  public constructor(private readonly transport: VocationTransport) {}

  public async request(
    operation: AuthorityOperation,
    payload: unknown = {},
    options: VocationRequestOptions = {}
  ): Promise<unknown> {
    return this.transport.execute({
      operation,
      payload,
      ...(options.requestId ? { requestId: options.requestId } : {}),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {})
    });
  }
}
