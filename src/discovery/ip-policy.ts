import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export interface ResolvedAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

export interface DnsResolver {
  resolve(hostname: string, signal?: AbortSignal): Promise<readonly ResolvedAddress[]>;
}

export class NodeDnsResolver implements DnsResolver {
  public async resolve(hostname: string, signal?: AbortSignal): Promise<readonly ResolvedAddress[]> {
    if (signal?.aborted) throw new Error("DNS resolution was aborted");
    const resolved = await lookup(hostname, { all: true, verbatim: true });
    if (signal?.aborted) throw new Error("DNS resolution was aborted");
    return resolved.map((entry) => {
      if (entry.family !== 4 && entry.family !== 6) throw new Error("DNS resolver returned an unsupported address family");
      return {
        address: entry.address,
        family: entry.family
      };
    });
  }
}

function parseIpv4(value: string): number | null {
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  let result = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet < 0 || octet > 255 || String(octet) !== part) return null;
    result = result * 256 + octet;
  }
  return result >>> 0;
}

function ipv4InCidr(value: number, base: number, prefixLength: number): boolean {
  const mask = prefixLength === 0 ? 0 : (0xffffffff << (32 - prefixLength)) >>> 0;
  return (value & mask) >>> 0 === (base & mask) >>> 0;
}

function isPublicIpv4(value: string): boolean {
  const address = parseIpv4(value);
  if (address === null) return false;
  const denied: ReadonlyArray<readonly [number, number]> = [
    [0x00000000, 8],
    [0x0a000000, 8],
    [0x64400000, 10],
    [0x7f000000, 8],
    [0xa9fe0000, 16],
    [0xac100000, 12],
    [0xc0000000, 24],
    [0xc0000200, 24],
    [0xc0586300, 24],
    [0xc0a80000, 16],
    [0xc6120000, 15],
    [0xc6336400, 24],
    [0xcb007100, 24],
    [0xe0000000, 4],
    [0xf0000000, 4]
  ];
  return !denied.some(([base, prefix]) => ipv4InCidr(address, base, prefix));
}

function parseIpv6(value: string): bigint | null {
  let normalized = value.toLowerCase();
  if (normalized.startsWith("[") && normalized.endsWith("]")) normalized = normalized.slice(1, -1);
  if (normalized.includes("%")) return null;
  if (normalized.includes(".")) {
    const separator = normalized.lastIndexOf(":");
    if (separator < 0) return null;
    const ipv4 = parseIpv4(normalized.slice(separator + 1));
    if (ipv4 === null) return null;
    const high = ((ipv4 >>> 16) & 0xffff).toString(16);
    const low = (ipv4 & 0xffff).toString(16);
    normalized = `${normalized.slice(0, separator)}:${high}:${low}`;
  }
  const compressed = normalized.split("::");
  if (compressed.length > 2) return null;
  const left = compressed[0] ? compressed[0].split(":") : [];
  const right = compressed.length === 2 && compressed[1] ? compressed[1].split(":") : [];
  if ([...left, ...right].some((part) => !/^[0-9a-f]{1,4}$/.test(part))) return null;
  const missing = 8 - left.length - right.length;
  if ((compressed.length === 1 && missing !== 0) || (compressed.length === 2 && missing < 1)) return null;
  const parts = [...left, ...Array.from({ length: missing }, () => "0"), ...right];
  if (parts.length !== 8) return null;
  let result = 0n;
  for (const part of parts) result = (result << 16n) | BigInt(parseInt(part, 16));
  return result;
}

function ipv6InCidr(value: bigint, base: bigint, prefixLength: number): boolean {
  if (prefixLength === 0) return true;
  const shift = 128n - BigInt(prefixLength);
  return value >> shift === base >> shift;
}

function ipv6Base(value: string): bigint {
  const parsed = parseIpv6(value);
  if (parsed === null) throw new Error(`Invalid internal IPv6 prefix: ${value}`);
  return parsed;
}

function ipv4FromBigInt(value: bigint): string {
  return [24n, 16n, 8n, 0n]
    .map((shift) => Number((value >> shift) & 0xffn))
    .join(".");
}

function isPublicIpv6(value: string): boolean {
  const address = parseIpv6(value);
  if (address === null) return false;

  const high96 = address >> 32n;
  if (high96 === 0n || high96 === 0xffffn) return isPublicIpv4(ipv4FromBigInt(address));
  if (!ipv6InCidr(address, ipv6Base("2000::"), 3)) return false;

  const denied: ReadonlyArray<readonly [bigint, number]> = [
    [ipv6Base("2001::"), 32],
    [ipv6Base("2001:2::"), 48],
    [ipv6Base("2001:10::"), 28],
    [ipv6Base("2001:20::"), 28],
    [ipv6Base("2001:db8::"), 32],
    [ipv6Base("2002::"), 16],
    [ipv6Base("fc00::"), 7],
    [ipv6Base("fe80::"), 10],
    [ipv6Base("fec0::"), 10],
    [ipv6Base("ff00::"), 8]
  ];
  return !denied.some(([base, prefix]) => ipv6InCidr(address, base, prefix));
}

export function isPublicNetworkAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isPublicIpv4(address);
  if (family === 6) return isPublicIpv6(address);
  return false;
}

export function validateResolvedAddresses(addresses: readonly ResolvedAddress[]): readonly ResolvedAddress[] {
  if (addresses.length === 0) throw new Error("DNS resolution returned no addresses");
  const normalized = new Map<string, ResolvedAddress>();
  for (const entry of addresses) {
    if (isIP(entry.address) !== entry.family) throw new Error("DNS resolution returned an invalid address family");
    if (!isPublicNetworkAddress(entry.address)) throw new Error("DNS resolution returned a non-public address");
    normalized.set(`${entry.family}:${entry.address.toLowerCase()}`, {
      address: entry.address.toLowerCase(),
      family: entry.family
    });
  }
  return [...normalized.values()].sort((left, right) =>
    left.family - right.family || left.address.localeCompare(right.address)
  );
}
