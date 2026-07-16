import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import {
  hasExactBootstrapOrigin,
  parseBootstrapContract,
  parseBootstrapEnvelope
} from "../scripts/bootstrap-contract.mjs";

const contract = parseBootstrapContract(JSON.parse(
  await readFile(resolve(import.meta.dirname, "..", "bootstrap-contract.json"), "utf8")
));
const token = "A".repeat(43);

function envelope(url, overrides = {}) {
  return JSON.stringify({
    status: "running",
    url,
    authority: "vocationd",
    network: "127.0.0.1-only",
    ...overrides
  });
}

test("accepts only the exact loopback launch envelope", () => {
  const parsed = parseBootstrapEnvelope(
    envelope(`http://127.0.0.1:43117/launch/${token}`),
    contract
  );
  assert.equal(parsed.origin, "http://127.0.0.1:43117");
});

test("rejects non-loopback, ambiguous, or weak launch targets", () => {
  for (const url of [
    `https://127.0.0.1:43117/launch/${token}`,
    `http://localhost:43117/launch/${token}`,
    `http://127.0.0.1/launch/${token}`,
    `http://127.0.0.1:0/launch/${token}`,
    `http://2130706433:43117/launch/${token}`,
    `http://user@127.0.0.1:43117/launch/${token}`,
    `http://127.0.0.1:43117/launch/${token}?debug=1`,
    `http://127.0.0.1:43117/launch/${token}#fragment`,
    "http://127.0.0.1:43117/launch/short",
    `http://127.0.0.1:43117/launch/${"!".repeat(43)}`
  ]) {
    assert.throws(() => parseBootstrapEnvelope(envelope(url), contract));
  }
});

test("rejects envelope drift and oversized output", () => {
  assert.throws(() => parseBootstrapEnvelope(envelope(
    `http://127.0.0.1:43117/launch/${token}`,
    { authority: "other" }
  ), contract));
  assert.throws(() => parseBootstrapEnvelope(JSON.stringify({
    status: "running",
    url: `http://127.0.0.1:43117/launch/${token}`,
    authority: "vocationd",
    network: "127.0.0.1-only",
    extra: "x"
  }), contract));
  assert.throws(() => parseBootstrapEnvelope(" ".repeat(contract.maxEnvelopeBytes + 1), contract));
});

test("matches navigation by the full validated origin", () => {
  const origin = "http://127.0.0.1:43117";
  assert.equal(hasExactBootstrapOrigin(`${origin}/today`, origin, contract), true);
  assert.equal(hasExactBootstrapOrigin("http://127.0.0.1:43118/today", origin, contract), false);
  assert.equal(hasExactBootstrapOrigin("http://localhost:43117/today", origin, contract), false);
  assert.equal(hasExactBootstrapOrigin("https://127.0.0.1:43117/today", origin, contract), false);
});
