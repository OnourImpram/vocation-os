const CONTRACT_KEYS = [
  "authority",
  "host",
  "launchPathPrefix",
  "launchTokenBytes",
  "maxEnvelopeBytes",
  "network",
  "schemaVersion",
  "scheme",
  "status",
  "timeoutMs"
];
const ENVELOPE_KEYS = ["authority", "network", "status", "url"];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function exactKeys(value, expected, name) {
  assert(value && typeof value === "object" && !Array.isArray(value), `${name} must be an object`);
  assert(
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify(expected),
    `${name} fields do not match the contract`
  );
}

export function parseBootstrapContract(value) {
  exactKeys(value, CONTRACT_KEYS, "Bootstrap contract");
  assert(value.schemaVersion === 1, "Bootstrap schema version must be 1");
  for (const field of ["status", "authority", "network", "scheme", "host", "launchPathPrefix"]) {
    assert(typeof value[field] === "string" && value[field].length > 0, `${field} must be a string`);
  }
  for (const field of ["launchTokenBytes", "maxEnvelopeBytes", "timeoutMs"]) {
    assert(Number.isSafeInteger(value[field]), `${field} must be an integer`);
  }
  assert(value.scheme === "http", "Bootstrap scheme must be exact HTTP loopback");
  assert(value.host === "127.0.0.1", "Bootstrap host must be the IPv4 loopback literal");
  assert(value.launchPathPrefix === "/launch/", "Unexpected launch path prefix");
  assert(value.launchTokenBytes === 32, "Launch tokens must contain 32 random bytes");
  assert(value.maxEnvelopeBytes >= 512 && value.maxEnvelopeBytes <= 16_384, "Envelope size limit is invalid");
  assert(value.timeoutMs >= 1_000 && value.timeoutMs <= 60_000, "Bootstrap timeout is invalid");
  return Object.freeze({ ...value });
}

function launchTokenLength(bytes) {
  return Math.ceil((bytes * 8) / 6);
}

export function parseBootstrapEnvelope(text, contractValue) {
  const contract = parseBootstrapContract(contractValue);
  assert(typeof text === "string", "Bootstrap envelope must be text");
  assert(Buffer.byteLength(text, "utf8") <= contract.maxEnvelopeBytes, "Bootstrap envelope is too large");
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("Bootstrap envelope is invalid JSON");
  }
  exactKeys(value, ENVELOPE_KEYS, "Bootstrap envelope");
  assert(value.status === contract.status, "Bootstrap status is invalid");
  assert(value.authority === contract.authority, "Bootstrap authority is invalid");
  assert(value.network === contract.network, "Bootstrap network is invalid");
  assert(typeof value.url === "string" && value.url.trim() === value.url, "Bootstrap URL is invalid");
  assert(!/[\u0000-\u001f\u007f]/u.test(value.url), "Bootstrap URL contains control characters");

  let url;
  try {
    url = new URL(value.url);
  } catch {
    throw new Error("Bootstrap URL must be absolute");
  }
  const token = url.pathname.startsWith(contract.launchPathPrefix)
    ? url.pathname.slice(contract.launchPathPrefix.length)
    : "";
  assert(url.protocol === `${contract.scheme}:`, "Bootstrap URL scheme is invalid");
  assert(url.hostname === contract.host, "Bootstrap URL host is invalid");
  assert(Number(url.port) > 0, "Bootstrap URL requires an explicit non-default port");
  assert(url.href === value.url, "Bootstrap URL must use its canonical representation");
  assert(url.username === "" && url.password === "", "Bootstrap URL cannot contain credentials");
  assert(url.search === "" && url.hash === "", "Bootstrap URL cannot contain query or fragment data");
  assert(token.length === launchTokenLength(contract.launchTokenBytes), "Bootstrap launch token length is invalid");
  assert(/^[A-Za-z0-9_-]+$/u.test(token), "Bootstrap launch token encoding is invalid");
  return Object.freeze({ origin: url.origin, url: url.href });
}

export function hasExactBootstrapOrigin(candidate, expectedOrigin, contractValue) {
  const contract = parseBootstrapContract(contractValue);
  try {
    const url = new URL(candidate);
    return url.protocol === `${contract.scheme}:`
      && url.hostname === contract.host
      && Number(url.port) > 0
      && url.username === ""
      && url.password === ""
      && url.origin === expectedOrigin;
  } catch {
    return false;
  }
}
