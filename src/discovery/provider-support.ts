import {
  DISCOVERY_PROVIDER_ADAPTERS,
  type DiscoveryProviderAdapter
} from "./provider-adapters.js";
import {
  DISCOVERY_PROVIDER_MANIFESTS,
  type DiscoveryProviderManifest,
  type DiscoveryProviderId
} from "./providers.js";

export interface ProviderSupportReport {
  readonly manifestCount: number;
  readonly executableAdapterCount: number;
  readonly contractTestedGaCount: number;
  readonly manifestOnlyCount: number;
  readonly assistOnlyCount: number;
  readonly contractTestedGaProviderIds: readonly DiscoveryProviderId[];
  readonly invalidGaProviderIds: readonly DiscoveryProviderId[];
  readonly all36ContractTestedGa: boolean;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function buildProviderSupportReport(
  manifests: readonly DiscoveryProviderManifest[] = DISCOVERY_PROVIDER_MANIFESTS,
  adapters: readonly DiscoveryProviderAdapter[] = DISCOVERY_PROVIDER_ADAPTERS
): ProviderSupportReport {
  const manifestIds = new Set<string>();
  for (const manifest of manifests) {
    if (manifestIds.has(manifest.providerId)) throw new Error(`Duplicate provider manifest: ${manifest.providerId}`);
    manifestIds.add(manifest.providerId);
  }
  const adaptersById = new Map<string, DiscoveryProviderAdapter>();
  for (const adapter of adapters) {
    if (adaptersById.has(adapter.providerId)) throw new Error(`Duplicate executable provider adapter: ${adapter.providerId}`);
    if (!manifestIds.has(adapter.providerId)) throw new Error(`Executable adapter has no provider manifest: ${adapter.providerId}`);
    adaptersById.set(adapter.providerId, adapter);
  }

  const contractTestedGaProviderIds: DiscoveryProviderId[] = [];
  const invalidGaProviderIds: DiscoveryProviderId[] = [];
  for (const manifest of manifests) {
    if (manifest.supportStatus !== "contract-tested-ga") continue;
    const adapter = adaptersById.get(manifest.providerId);
    const receipt = manifest.contractTestReceipt;
    if (
      adapter?.executable === true &&
      receipt !== null &&
      receipt.contractVersion === adapter.contractVersion &&
      receipt.suite === "test/unit/discovery-provider-contracts.test.ts"
    ) {
      contractTestedGaProviderIds.push(manifest.providerId as DiscoveryProviderId);
    } else {
      invalidGaProviderIds.push(manifest.providerId as DiscoveryProviderId);
    }
  }
  contractTestedGaProviderIds.sort(compareText);
  invalidGaProviderIds.sort(compareText);
  const report: ProviderSupportReport = {
    manifestCount: manifests.length,
    executableAdapterCount: adaptersById.size,
    contractTestedGaCount: contractTestedGaProviderIds.length,
    manifestOnlyCount: manifests.filter((manifest) => manifest.supportStatus === "manifest-only").length,
    assistOnlyCount: manifests.filter((manifest) => manifest.supportStatus === "assist-only").length,
    contractTestedGaProviderIds: Object.freeze(contractTestedGaProviderIds),
    invalidGaProviderIds: Object.freeze(invalidGaProviderIds),
    all36ContractTestedGa:
      manifests.length === 36 &&
      adaptersById.size === 36 &&
      contractTestedGaProviderIds.length === 36 &&
      invalidGaProviderIds.length === 0
  };
  return Object.freeze(report);
}

export function assertGaProviderCountClaim(
  claimedCount: number,
  manifests: readonly DiscoveryProviderManifest[] = DISCOVERY_PROVIDER_MANIFESTS,
  adapters: readonly DiscoveryProviderAdapter[] = DISCOVERY_PROVIDER_ADAPTERS
): ProviderSupportReport {
  if (!Number.isSafeInteger(claimedCount) || claimedCount < 0) {
    throw new Error("Claimed GA provider count must be a non-negative integer");
  }
  const report = buildProviderSupportReport(manifests, adapters);
  if (claimedCount === 36 && !report.all36ContractTestedGa) {
    throw new Error(
      `Cannot claim 36 GA providers. ${report.contractTestedGaCount} have executable contract-tested adapters`
    );
  }
  if (claimedCount !== report.contractTestedGaCount || report.invalidGaProviderIds.length > 0) {
    throw new Error(
      `Cannot claim ${claimedCount} GA providers. Executable contract-tested count is ${report.contractTestedGaCount}`
    );
  }
  return report;
}

export const DISCOVERY_PROVIDER_SUPPORT_REPORT = buildProviderSupportReport();
export const CONTRACT_TESTED_GA_PROVIDER_COUNT = DISCOVERY_PROVIDER_SUPPORT_REPORT.contractTestedGaCount;
