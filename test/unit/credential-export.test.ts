import { describe, expect, it } from "vitest";
import {
  OPEN_BADGES_CONTEXT_URL,
  VC_CONTEXT_URL,
  createCredentialPassportExport,
  importCredential,
  validateCredentialPassportExport
} from "../../src/credentials/index.js";

const NOW = new Date("2026-07-14T12:30:00.000Z");

async function passportFixture() {
  const content = Buffer.from(JSON.stringify({
    "@context": [VC_CONTEXT_URL, OPEN_BADGES_CONTEXT_URL],
    id: "https://issuer.example/credentials/export-1",
    type: ["VerifiableCredential", "OpenBadgeCredential"],
    issuer: { id: "https://issuer.example/profiles/issuer-1" },
    validFrom: "2026-07-14T10:00:00.000Z",
    credentialSubject: {
      id: "did:example:holder-1",
      achievement: {
        id: "https://issuer.example/achievements/export-1",
        name: "Career assurance evidence",
        criteria: { narrative: "Completed the stated criteria." }
      }
    }
  }), "utf8");
  const imported = await importCredential(
    { content, format: "json" },
    {},
    { now: NOW, expectedSubjectId: "did:example:holder-1" }
  );
  return { passport: imported.entry, original: imported.preservedOriginal.bytes };
}

describe("credential passport export", () => {
  it("packages and revalidates the original, receipt, mappings, and checksums", async () => {
    const fixture = await passportFixture();
    const exported = createCredentialPassportExport(fixture.passport, fixture.original, NOW);
    const parsed = JSON.parse(new TextDecoder().decode(exported.bytes)) as unknown;

    expect(validateCredentialPassportExport(parsed)).toEqual(exported.value);
    expect(exported.value.original.contentBase64).toBe(Buffer.from(fixture.original).toString("base64"));
    expect(exported.value.checksums.package).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("rejects an original that is not bound to the passport", async () => {
    const fixture = await passportFixture();
    const tampered = Uint8Array.from(fixture.original);
    tampered[0] = (tampered[0] ?? 0) ^ 1;

    expect(() => createCredentialPassportExport(fixture.passport, tampered, NOW))
      .toThrow("does not match the passport artifact binding");
  });

  it("rejects post-export tampering even when the outer JSON remains valid", async () => {
    const fixture = await passportFixture();
    const exported = createCredentialPassportExport(fixture.passport, fixture.original, NOW);
    const tampered = JSON.parse(new TextDecoder().decode(exported.bytes)) as {
      original: { contentBase64: string };
    };
    const bytes = Buffer.from(tampered.original.contentBase64, "base64");
    bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 1;
    tampered.original.contentBase64 = bytes.toString("base64");

    expect(() => validateCredentialPassportExport(tampered)).toThrow("checksum is invalid");
  });
});

