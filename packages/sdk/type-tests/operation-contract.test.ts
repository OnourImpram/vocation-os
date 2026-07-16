import type {
  ArtifactExportResponse,
  ArtifactManifest,
  AuthorityOperation,
  AuthorityOperationContractMap,
  AuthorityOperationPayload,
  AuthorityOperationResult,
  CredentialExportResponse,
  CredentialImportResponse,
  TaxonomyImportResponse,
  TaxonomyQueryResponse,
  UnknownAuthorityResult,
  VocationClient,
  VocationTransport
} from "../src/index.js";

type Equal<TLeft, TRight> =
  (<T>() => T extends TLeft ? 1 : 2) extends
  (<T>() => T extends TRight ? 1 : 2)
    ? true
    : false;

type Expect<TValue extends true> = TValue;

type ContractCoversEveryOperation = Expect<Equal<keyof AuthorityOperationContractMap, AuthorityOperation>>;
type EveryContractIsListed = Expect<Equal<AuthorityOperation, keyof AuthorityOperationContractMap>>;
type HealthRemainsExplicitlyUnknown = Expect<Equal<AuthorityOperationResult<"health">, UnknownAuthorityResult>>;
type TaxonomyPayloadIsExact = Expect<Equal<
  AuthorityOperationPayload<"taxonomy-query">,
  {
    readonly snapshotId: string;
    readonly queries: readonly string[];
    readonly limit: number;
    readonly minimumScore: number;
  }
>>;

declare const client: VocationClient;
declare const transport: VocationTransport;
declare const manifest: ArtifactManifest;
declare const dynamicOperation: AuthorityOperation;
declare const dynamicPayload: unknown;

const dynamicResult: Promise<UnknownAuthorityResult> = client.request(dynamicOperation, dynamicPayload);
const healthResult: Promise<UnknownAuthorityResult> = client.request("health");

function forwardTypedOperation<O extends AuthorityOperation>(
  operation: O,
  payload: AuthorityOperationPayload<O>
): Promise<AuthorityOperationResult<O>> {
  return client.request(operation, payload);
}

const taxonomyImport: Promise<TaxonomyImportResponse> = client.request(
  "taxonomy-snapshot-import-artifact",
  { expectedVersion: 0, manifest }
);

const taxonomyQuery: Promise<TaxonomyQueryResponse> = client.request("taxonomy-query", {
  snapshotId: "TAXONOMY-1",
  queries: ["clinical psychologist"],
  limit: 5,
  minimumScore: 0.25
});

const credentialImport: Promise<CredentialImportResponse> = client.request(
  "credential-import-artifact",
  {
    expectedSubjectId: null,
    expectedVersion: 0,
    format: "json-ld",
    importedAt: "2026-07-14T12:00:00.000Z",
    manifest
  }
);

const credentialExport: Promise<CredentialExportResponse> = client.request(
  "credential-export-artifact",
  { passportId: "CRED-1", exportedAt: "2026-07-14T12:00:00.000Z" }
);

credentialExport.then((response) => {
  const packageHash: string = response.packageHash;
  const recordId: string = response.record.recordId;
  // @ts-expect-error Export responses must not expose embedded credential values.
  response.record.value;
  void packageHash;
  void recordId;
});

const artifactExport: Promise<ArtifactExportResponse> = transport.execute({
  operation: "artifact-export",
  payload: { manifest, outputPath: "C:\\exports\\credential.json" }
});

// @ts-expect-error Taxonomy queries require an explicit bounded result limit.
client.request("taxonomy-query", {
  snapshotId: "TAXONOMY-1",
  queries: ["clinical psychologist"],
  minimumScore: 0.25
});

// @ts-expect-error Credential imports accept only declared artifact formats.
client.request("credential-import-artifact", {
  expectedSubjectId: null,
  expectedVersion: 0,
  format: "xml",
  importedAt: "2026-07-14T12:00:00.000Z",
  manifest
});

// @ts-expect-error Artifact export returns a boolean recovery marker, not a string.
const invalidArtifactExport: Promise<{ recoveredExisting: string }> = transport.execute({
  operation: "artifact-export",
  payload: { manifest, outputPath: "C:\\exports\\credential.json" }
});

// @ts-expect-error Artifact export paths are strings.
client.request("artifact-export", { manifest, outputPath: 42 });

// @ts-expect-error Credential export payloads contain only passportId and exportedAt.
client.request("credential-export-artifact", {
  passportId: "CRED-1",
  exportedAt: "2026-07-14T12:00:00.000Z",
  outputPath: "C:\\exports\\credential.json"
});

// @ts-expect-error Direct taxonomy snapshot records are intentionally unavailable.
client.request("taxonomy-snapshot-record", { expectedVersion: 0, value: {} });

// @ts-expect-error Direct credential passport records are intentionally unavailable.
client.request("credential-passport-record", { expectedVersion: 0, value: {} });

void taxonomyImport;
void taxonomyQuery;
void credentialImport;
void credentialExport;
void artifactExport;
void dynamicResult;
void healthResult;
void forwardTypedOperation;
void invalidArtifactExport;
void (null as unknown as ContractCoversEveryOperation);
void (null as unknown as EveryContractIsListed);
void (null as unknown as HealthRemainsExplicitlyUnknown);
void (null as unknown as TaxonomyPayloadIsExact);
