import { sha256, stableStringify } from "../hash.js";

export const MODEL_PROVIDER_IDS = [
  "ollama",
  "lm-studio",
  "openai",
  "anthropic",
  "gemini",
  "azure-openai",
  "openrouter",
  "mistral",
  "cohere",
  "deepseek",
  "openai-compatible"
] as const;

export type ModelProviderId = (typeof MODEL_PROVIDER_IDS)[number];
export type ModelDataCategory =
  | "public-opportunity"
  | "profile-claims"
  | "career-constraints"
  | "application-document"
  | "interview-content"
  | "credential-metadata";

export interface ModelProviderManifest {
  providerId: ModelProviderId;
  displayName: string;
  locality: "local" | "remote" | "configurable";
  defaultEndpoint: string | null;
  requiresCredential: boolean;
  requiresEgressApproval: boolean;
  retentionDisclosureRequired: boolean;
  protocol: "openai-compatible" | "anthropic" | "gemini" | "cohere";
  allowedHostPatterns: readonly string[];
}

export interface ModelEgressApproval {
  approvalId: string;
  invocationId: string;
  providerId: ModelProviderId;
  approvedBy: string;
  approvedAt: string;
  expiresAt: string;
  allowedPurposes: string[];
  allowedDataCategories: ModelDataCategory[];
  allowedModelIds: string[];
  endpointHash: string;
  retentionAcknowledged: boolean;
  approvalTextHash: string;
}

export interface ModelInvocationIntent {
  invocationId: string;
  providerId: ModelProviderId;
  endpoint: string;
  modelId: string;
  purpose: string;
  dataCategories: ModelDataCategory[];
  redactionPreview: string[];
  payloadHashes: string[];
  retentionStatement: string | null;
  approval: ModelEgressApproval | null;
}

export interface ModelEgressDecision {
  allowed: boolean;
  blockedBy: string[];
  providerId: ModelProviderId;
  invocationId: string;
  decisionHash: string;
}

export interface ModelInvocationRequest {
  intent: ModelInvocationIntent;
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  temperature: number;
  maximumOutputTokens: number;
}

export interface ModelInvocationReceipt {
  invocationId: string;
  providerId: ModelProviderId;
  modelId: string;
  requestHash: string;
  responseHash: string;
  startedAt: string;
  completedAt: string;
  inputTokens: number | null;
  outputTokens: number | null;
  retentionStatement: string | null;
}

export interface GovernedModelTransport {
  invoke(request: ModelInvocationRequest): Promise<{ text: string; inputTokens?: number; outputTokens?: number }>;
}

export const MAX_MODEL_MESSAGES = 64;
export const MAX_MODEL_MESSAGE_BYTES = 1 * 1024 * 1024;
export const MAX_MODEL_REQUEST_BYTES = 4 * 1024 * 1024;
export const MAX_MODEL_RESPONSE_BYTES = 4 * 1024 * 1024;
export const MAX_MODEL_OUTPUT_TOKENS = 131_072;

export const MODEL_PROVIDER_MANIFESTS: readonly ModelProviderManifest[] = [
  { providerId: "ollama", displayName: "Ollama", locality: "local", defaultEndpoint: "http://127.0.0.1:11434", requiresCredential: false, requiresEgressApproval: false, retentionDisclosureRequired: false, protocol: "openai-compatible", allowedHostPatterns: ["127.0.0.1", "[::1]"] },
  { providerId: "lm-studio", displayName: "LM Studio", locality: "local", defaultEndpoint: "http://127.0.0.1:1234", requiresCredential: false, requiresEgressApproval: false, retentionDisclosureRequired: false, protocol: "openai-compatible", allowedHostPatterns: ["127.0.0.1", "[::1]"] },
  { providerId: "openai", displayName: "OpenAI", locality: "remote", defaultEndpoint: "https://api.openai.com", requiresCredential: true, requiresEgressApproval: true, retentionDisclosureRequired: true, protocol: "openai-compatible", allowedHostPatterns: ["api.openai.com"] },
  { providerId: "anthropic", displayName: "Anthropic", locality: "remote", defaultEndpoint: "https://api.anthropic.com", requiresCredential: true, requiresEgressApproval: true, retentionDisclosureRequired: true, protocol: "anthropic", allowedHostPatterns: ["api.anthropic.com"] },
  { providerId: "gemini", displayName: "Google Gemini", locality: "remote", defaultEndpoint: "https://generativelanguage.googleapis.com", requiresCredential: true, requiresEgressApproval: true, retentionDisclosureRequired: true, protocol: "gemini", allowedHostPatterns: ["generativelanguage.googleapis.com"] },
  { providerId: "azure-openai", displayName: "Azure OpenAI", locality: "remote", defaultEndpoint: null, requiresCredential: true, requiresEgressApproval: true, retentionDisclosureRequired: true, protocol: "openai-compatible", allowedHostPatterns: ["*.openai.azure.com"] },
  { providerId: "openrouter", displayName: "OpenRouter", locality: "remote", defaultEndpoint: "https://openrouter.ai/api", requiresCredential: true, requiresEgressApproval: true, retentionDisclosureRequired: true, protocol: "openai-compatible", allowedHostPatterns: ["openrouter.ai"] },
  { providerId: "mistral", displayName: "Mistral AI", locality: "remote", defaultEndpoint: "https://api.mistral.ai", requiresCredential: true, requiresEgressApproval: true, retentionDisclosureRequired: true, protocol: "openai-compatible", allowedHostPatterns: ["api.mistral.ai"] },
  { providerId: "cohere", displayName: "Cohere", locality: "remote", defaultEndpoint: "https://api.cohere.com", requiresCredential: true, requiresEgressApproval: true, retentionDisclosureRequired: true, protocol: "cohere", allowedHostPatterns: ["api.cohere.com"] },
  { providerId: "deepseek", displayName: "DeepSeek", locality: "remote", defaultEndpoint: "https://api.deepseek.com", requiresCredential: true, requiresEgressApproval: true, retentionDisclosureRequired: true, protocol: "openai-compatible", allowedHostPatterns: ["api.deepseek.com"] },
  { providerId: "openai-compatible", displayName: "OpenAI Compatible Endpoint", locality: "configurable", defaultEndpoint: null, requiresCredential: false, requiresEgressApproval: true, retentionDisclosureRequired: true, protocol: "openai-compatible", allowedHostPatterns: [] }
];

function provider(providerId: ModelProviderId): ModelProviderManifest {
  const manifest = MODEL_PROVIDER_MANIFESTS.find((candidate) => candidate.providerId === providerId);
  if (!manifest) throw new Error(`Unknown model provider: ${providerId}`);
  return manifest;
}

function isLoopbackEndpoint(value: string): boolean {
  const url = new URL(value);
  return (url.protocol === "http:" || url.protocol === "https:")
    && (url.hostname === "127.0.0.1" || url.hostname === "[::1]");
}

function hostMatches(hostname: string, pattern: string): boolean {
  if (!pattern.startsWith("*.")) return hostname === pattern;
  const suffix = pattern.slice(2);
  return hostname !== suffix && hostname.endsWith(`.${suffix}`);
}

function canonicalModelEndpoint(value: string): URL {
  const endpoint = new URL(value);
  if (endpoint.username || endpoint.password || endpoint.hash || endpoint.search) {
    throw new Error("Model endpoint must not contain credentials, query, or fragment data");
  }
  return endpoint;
}

export function modelEndpointHash(value: string): string {
  return sha256(canonicalModelEndpoint(value).toString());
}

export function decideModelEgress(intent: ModelInvocationIntent, now = new Date()): ModelEgressDecision {
  const manifest = provider(intent.providerId);
  const blockedBy: string[] = [];
  if (!intent.invocationId.trim() || !intent.modelId.trim() || !intent.purpose.trim()) blockedBy.push("model-intent-identity-missing");
  const knownCategories = new Set<ModelDataCategory>([
    "public-opportunity", "profile-claims", "career-constraints", "application-document",
    "interview-content", "credential-metadata"
  ]);
  if (intent.dataCategories.length === 0) blockedBy.push("model-data-categories-missing");
  if (new Set(intent.dataCategories).size !== intent.dataCategories.length || intent.dataCategories.some((category) => !knownCategories.has(category))) {
    blockedBy.push("model-data-categories-invalid");
  }
  if (intent.redactionPreview.length === 0 || intent.redactionPreview.some((entry) => !entry.trim())) blockedBy.push("model-redaction-preview-missing");
  if (intent.payloadHashes.length === 0 || intent.payloadHashes.some((hash) => !/^sha256:[a-f0-9]{64}$/.test(hash))) {
    blockedBy.push("model-payload-hash-invalid");
  }
  let endpoint: URL | null = null;
  try {
    endpoint = canonicalModelEndpoint(intent.endpoint);
  } catch {
    blockedBy.push("model-endpoint-invalid");
  }
  const localInvocation = endpoint !== null && isLoopbackEndpoint(endpoint.toString());
  if (manifest.locality === "local" && !localInvocation) blockedBy.push("local-model-endpoint-not-loopback");
  if (manifest.locality === "remote" && endpoint?.protocol !== "https:") blockedBy.push("remote-model-endpoint-not-https");
  if (
    endpoint !== null &&
    !localInvocation &&
    manifest.allowedHostPatterns.length > 0 &&
    !manifest.allowedHostPatterns.some((pattern) => hostMatches(endpoint!.hostname, pattern))
  ) {
    blockedBy.push("model-endpoint-host-not-allowed");
  }
  const requiresApproval = manifest.requiresEgressApproval && !localInvocation;
  if (requiresApproval) {
    const approval = intent.approval;
    if (!approval) {
      blockedBy.push("model-egress-approval-missing");
    } else {
      if (approval.providerId !== intent.providerId) blockedBy.push("model-egress-approval-provider-mismatch");
      if (approval.invocationId !== intent.invocationId) blockedBy.push("model-egress-approval-invocation-mismatch");
      if (!approval.approvalId.startsWith("APR-") || !approval.approvedBy.trim()) blockedBy.push("model-egress-approval-invalid");
      if (!/^sha256:[a-f0-9]{64}$/.test(approval.approvalTextHash)) blockedBy.push("model-egress-approval-hash-invalid");
      if (endpoint === null || approval.endpointHash !== sha256(endpoint.toString())) blockedBy.push("model-egress-approval-endpoint-mismatch");
      if (!Number.isFinite(Date.parse(approval.approvedAt)) || !Number.isFinite(Date.parse(approval.expiresAt))) {
        blockedBy.push("model-egress-approval-time-invalid");
      } else {
        const approvedAt = Date.parse(approval.approvedAt);
        const expiresAt = Date.parse(approval.expiresAt);
        if (approvedAt > now.getTime() + 300_000 || expiresAt <= approvedAt) blockedBy.push("model-egress-approval-time-invalid");
        else if (expiresAt <= now.getTime()) blockedBy.push("model-egress-approval-expired");
        else if (expiresAt - approvedAt > 86_400_000) blockedBy.push("model-egress-approval-window-too-wide");
      }
      if (new Set(approval.allowedPurposes).size !== approval.allowedPurposes.length) blockedBy.push("model-egress-approval-purpose-invalid");
      if (!approval.allowedPurposes.includes(intent.purpose)) blockedBy.push("model-egress-purpose-not-approved");
      if (new Set(approval.allowedDataCategories).size !== approval.allowedDataCategories.length) blockedBy.push("model-egress-approval-data-category-invalid");
      if (intent.dataCategories.some((category) => !approval.allowedDataCategories.includes(category))) {
        blockedBy.push("model-egress-data-category-not-approved");
      }
      if (new Set(approval.allowedModelIds).size !== approval.allowedModelIds.length || !approval.allowedModelIds.includes(intent.modelId)) {
        blockedBy.push("model-egress-model-not-approved");
      }
      if (manifest.retentionDisclosureRequired && (!approval.retentionAcknowledged || !intent.retentionStatement?.trim())) {
        blockedBy.push("model-retention-not-acknowledged");
      }
    }
  }
  const body = {
    allowed: blockedBy.length === 0,
    blockedBy: [...new Set(blockedBy)].sort(),
    providerId: intent.providerId,
    invocationId: intent.invocationId
  };
  return { ...body, decisionHash: sha256(stableStringify(body)) };
}

export async function executeModelInvocation(
  request: ModelInvocationRequest,
  transport: GovernedModelTransport,
  now = new Date()
): Promise<{ text: string; receipt: ModelInvocationReceipt }> {
  const decision = decideModelEgress(request.intent, now);
  if (!decision.allowed) throw new Error(`Model invocation blocked: ${decision.blockedBy.join(", ")}`);
  if (request.messages.length < 1 || request.messages.length > MAX_MODEL_MESSAGES) {
    throw new Error(`Model invocation requires between 1 and ${MAX_MODEL_MESSAGES} messages`);
  }
  const messageHashes: string[] = [];
  let requestBytes = 0;
  for (const message of request.messages) {
    const bytes = Buffer.byteLength(message.content, "utf8");
    if (bytes > MAX_MODEL_MESSAGE_BYTES) throw new Error("Model message exceeds the byte limit");
    requestBytes += bytes;
    if (requestBytes > MAX_MODEL_REQUEST_BYTES) throw new Error("Model request exceeds the byte limit");
    messageHashes.push(sha256(message.content));
  }
  if (stableStringify(messageHashes) !== stableStringify(request.intent.payloadHashes)) {
    throw new Error("Model invocation payload does not match the approved intent hashes");
  }
  if (!Number.isFinite(request.temperature) || request.temperature < 0 || request.temperature > 2) {
    throw new Error("Model temperature must be between 0 and 2");
  }
  if (
    !Number.isSafeInteger(request.maximumOutputTokens)
    || request.maximumOutputTokens < 1
    || request.maximumOutputTokens > MAX_MODEL_OUTPUT_TOKENS
  ) {
    throw new Error(`Model maximum output tokens must be between 1 and ${MAX_MODEL_OUTPUT_TOKENS}`);
  }
  const startedAt = now.toISOString();
  const result = await transport.invoke(request);
  if (typeof result.text !== "string" || Buffer.byteLength(result.text, "utf8") > MAX_MODEL_RESPONSE_BYTES) {
    throw new Error("Model response exceeds the trusted response boundary");
  }
  for (const [name, value] of [["inputTokens", result.inputTokens], ["outputTokens", result.outputTokens]] as const) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
      throw new Error(`Model transport returned an invalid ${name}`);
    }
  }
  const completedAt = new Date().toISOString();
  const requestHash = sha256(stableStringify({
    ...request,
    messages: request.messages.map((message, index) => ({ ...message, content: messageHashes[index] }))
  }));
  const receipt: ModelInvocationReceipt = {
    invocationId: request.intent.invocationId,
    providerId: request.intent.providerId,
    modelId: request.intent.modelId,
    requestHash,
    responseHash: sha256(result.text),
    startedAt,
    completedAt,
    inputTokens: result.inputTokens ?? null,
    outputTokens: result.outputTokens ?? null,
    retentionStatement: request.intent.retentionStatement
  };
  return { text: result.text, receipt };
}
