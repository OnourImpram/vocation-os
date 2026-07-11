export interface AdapterCapability {
  adapterId: string;
  discovery: boolean;
  execution: boolean;
  syntheticOnly: boolean;
}

const COMPILED_ADAPTERS: readonly AdapterCapability[] = [
  {
    adapterId: "local-fixture",
    discovery: true,
    execution: true,
    syntheticOnly: true
  }
];

export function compiledAdapterCapabilities(): readonly AdapterCapability[] {
  return COMPILED_ADAPTERS;
}

export function resolveEffectiveAdapterCapabilities(
  configuredAllowlist: readonly string[]
): AdapterCapability[] {
  const configured = new Set(configuredAllowlist);
  return COMPILED_ADAPTERS.filter((adapter) => configured.has(adapter.adapterId));
}

export function assertExecutableAdapter(
  adapterId: string,
  configuredAllowlist: readonly string[],
  profileScope: "synthetic" | "local-private"
): AdapterCapability {
  const adapter = resolveEffectiveAdapterCapabilities(configuredAllowlist)
    .find((candidate) => candidate.adapterId === adapterId);
  if (!adapter || !adapter.execution) throw new Error(`Adapter ${adapterId} is not executable by this build`);
  if (adapter.syntheticOnly && profileScope !== "synthetic") {
    throw new Error(`Adapter ${adapterId} is restricted to synthetic fixtures`);
  }
  return adapter;
}
