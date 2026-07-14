import {
  approveApplicationAttempt,
  blockApplicationAttempt,
  confirmApplicationAttempt,
  confirmationLedgerEntry,
  createApplicationAttempt,
  markSubmissionAttempted,
  type ApplicationAttempt,
  type ApplicationAttemptInput
} from "../application-lifecycle.js";
import type { ApprovalReference } from "../types.js";
import type { TrustedApprover } from "../approval.js";
import type { SubmissionProof, SubmissionProofEvaluation, TrustedCollector } from "../submission-proof.js";
import type { DomainAuthorityBindingInput, ProductRepositories, VersionedDomainRecord } from "./product-repositories.js";

export interface TrackerWriteContext {
  operationId: string;
  eventId?: string;
  authority?: DomainAuthorityBindingInput;
  now: Date;
}

export class ApplicationTracker {
  public constructor(
    private readonly repositories: ProductRepositories,
    private readonly trustedApprovers: readonly TrustedApprover[] = [],
    private readonly trustedCollectors: readonly TrustedCollector[] = []
  ) {}

  public async list(includeArchived = false): Promise<VersionedDomainRecord<ApplicationAttempt>[]> {
    return this.repositories.applications.list(includeArchived);
  }

  public async get(attemptId: string): Promise<VersionedDomainRecord<ApplicationAttempt> | null> {
    return this.repositories.applications.get(attemptId);
  }

  public async create(
    input: Omit<ApplicationAttemptInput, "now">,
    context: TrackerWriteContext
  ): Promise<VersionedDomainRecord<ApplicationAttempt>> {
    const replay = (await this.repositories.applications.list(true))
      .find((record) => record.operationId === context.operationId);
    if (replay) return replay;
    const attempt = createApplicationAttempt({ ...input, now: context.now });
    return this.repositories.applications.put({
      value: attempt,
      expectedVersion: 0,
      operationId: context.operationId,
      ...(context.eventId ? { eventId: context.eventId } : {}),
      now: context.now,
      ...(context.authority ? { authority: context.authority } : {})
    });
  }

  private async current(attemptId: string, expectedVersion: number): Promise<VersionedDomainRecord<ApplicationAttempt>> {
    const record = await this.repositories.applications.get(attemptId);
    if (!record) throw new Error(`Application attempt not found: ${attemptId}`);
    if (record.version !== expectedVersion) {
      throw new Error(`Application tracker version conflict, expected ${expectedVersion}, current ${record.version}`);
    }
    return record;
  }

  private async save(
    current: VersionedDomainRecord<ApplicationAttempt>,
    attempt: ApplicationAttempt,
    context: TrackerWriteContext,
    audit?: {
      proof: SubmissionProof;
      proofEvaluation: SubmissionProofEvaluation;
      ledgerEntry: ReturnType<typeof confirmationLedgerEntry>;
    }
  ): Promise<VersionedDomainRecord<ApplicationAttempt>> {
    return this.repositories.applications.put({
      value: attempt,
      expectedVersion: current.version,
      operationId: context.operationId,
      ...(context.eventId ? { eventId: context.eventId } : {}),
      now: context.now,
      ...(context.authority ? { authority: context.authority } : {}),
      ...(audit ? { audit } : {})
    });
  }

  public async approve(
    attemptId: string,
    expectedVersion: number,
    approval: ApprovalReference,
    context: TrackerWriteContext
  ): Promise<VersionedDomainRecord<ApplicationAttempt>> {
    const current = await this.current(attemptId, expectedVersion);
    return this.save(current, approveApplicationAttempt(current.value, approval, this.trustedApprovers, context.now), context);
  }

  public async markSubmitted(
    attemptId: string,
    expectedVersion: number,
    context: TrackerWriteContext
  ): Promise<VersionedDomainRecord<ApplicationAttempt>> {
    const current = await this.current(attemptId, expectedVersion);
    return this.save(current, markSubmissionAttempted(current.value, this.trustedApprovers, context.now), context);
  }

  public async block(
    attemptId: string,
    expectedVersion: number,
    blocker: string,
    context: TrackerWriteContext
  ): Promise<VersionedDomainRecord<ApplicationAttempt>> {
    const current = await this.current(attemptId, expectedVersion);
    return this.save(current, blockApplicationAttempt(current.value, blocker, context.now), context);
  }

  public async confirm(
    attemptId: string,
    expectedVersion: number,
    proof: SubmissionProof,
    context: TrackerWriteContext
  ): Promise<VersionedDomainRecord<ApplicationAttempt>> {
    const current = await this.current(attemptId, expectedVersion);
    const confirmation = confirmApplicationAttempt(current.value, proof, this.trustedCollectors, undefined, context.now);
    const ledgerEntry = confirmationLedgerEntry(confirmation.attempt, proof, context.now);
    return this.save(current, confirmation.attempt, context, {
      proof,
      proofEvaluation: confirmation.proofEvaluation,
      ledgerEntry
    });
  }
}
