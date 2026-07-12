import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { computeClaimTextHash } from "../../src/hash.js";
import { renderDocumentBundle, writeDocumentBundle } from "../../src/documents/document-renderer.js";
import { validateDocumentAstV2, type DocumentAstV2 } from "../../src/documents/document-ast-v2.js";
import type { ClaimGraph } from "../../src/types.js";

const CLAIM_TEXT = "Klinik psikoloji ve sorumlu yapay zekâ alanlarında araştırma yürüttü.";
const NOW = new Date("2026-07-12T04:00:00.000Z");

function graph(): ClaimGraph {
  return {
    profileId: "DEMO-DOCUMENT-001",
    profileScope: "synthetic",
    generatedAt: NOW.toISOString(),
    graphVersion: "0.5.0",
    claims: [{
      claimId: "CLM-DOCUMENT-001",
      text: CLAIM_TEXT,
      canonicalTextHash: computeClaimTextHash(CLAIM_TEXT),
      claimType: "project",
      evidenceStatus: "verified",
      sourceType: "operator-supplied",
      sourcePointer: "fixture:document-renderer",
      verifiedDate: "2026-07-12",
      recencyRequired: false,
      publiclyAssertable: true,
      allowedInCv: true,
      allowedInOutreach: true,
      allowedInAutoApply: false
    }],
    validationSummary: { verifiedClaims: 1, unverifiedClaims: 0, privateClaims: 0 }
  };
}

function document(): DocumentAstV2 {
  return {
    schemaVersion: 2,
    documentId: "DOC-RENDER-001",
    kind: "cv",
    profileId: graph().profileId,
    opportunityId: null,
    titleKey: "cv",
    locale: "tr-TR",
    generatedAt: NOW.toISOString(),
    layout: { pageSize: "A4", marginPoints: 48, bodyFontSize: 10.5 },
    sections: [{
      sectionId: "SEC-EXPERIENCE-001",
      labelKey: "experience",
      nodes: [{
        nodeId: "NODE-CLAIM-001",
        type: "bullet",
        bindingMode: "verbatim-claim",
        text: CLAIM_TEXT,
        claimIds: ["CLM-DOCUMENT-001"],
        textHash: computeClaimTextHash(CLAIM_TEXT)
      }]
    }]
  };
}

describe("claim bound PDF and DOCX renderer", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "vocation-document-renderer-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("renders Turkish text and passes PDF and DOCX parse back verification", async () => {
    const bundle = await renderDocumentBundle(document(), graph(), NOW);
    try {
      expect(bundle.pdf.subarray(0, 5).toString("ascii")).toBe("%PDF-");
      expect(bundle.docx.subarray(0, 2).toString("ascii")).toBe("PK");
      expect(bundle.verification).toMatchObject({
        valid: true,
        traceCoverage: 1,
        pdf: { valid: true, verifiedSegments: 3 },
        docx: { valid: true, verifiedSegments: 3 }
      });
    } finally {
      bundle.pdf.fill(0);
      bundle.docx.fill(0);
    }
  }, 30_000);

  it("writes both verified formats atomically and refuses overwrite", async () => {
    const output = await writeDocumentBundle(document(), graph(), root, NOW);

    expect(existsSync(output.pdfPath)).toBe(true);
    expect(existsSync(output.docxPath)).toBe(true);
    expect(output.pdfHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(output.docxHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(readdirSync(root)).toEqual(["DOC-RENDER-001"]);
    await expect(writeDocumentBundle(document(), graph(), root, NOW)).rejects.toThrow("already exists");
  }, 30_000);

  it("blocks altered claim text before creating any output", async () => {
    const altered = document();
    const node = altered.sections[0]?.nodes[0];
    if (!node || node.type === "heading") throw new Error("Document fixture is invalid");
    node.text = `${node.text} Additional unsupported claim.`;

    expect(validateDocumentAstV2(altered, graph(), NOW).valid).toBe(false);
    await expect(writeDocumentBundle(altered, graph(), root, NOW)).rejects.toThrow("validation failed");
    expect(existsSync(path.join(root, "DOC-RENDER-001"))).toBe(false);
  });

  it("rejects free form structural text that could carry an unverified claim", () => {
    const injected = { ...document(), title: "Licensed clinical psychologist" } as unknown as DocumentAstV2;
    expect(() => validateDocumentAstV2(injected, graph(), NOW)).toThrow("additional properties");
  });

  it("rejects a symlinked output root before rendering plaintext", async () => {
    const realRoot = path.join(root, "real");
    const linkedRoot = path.join(root, "linked");
    mkdirSync(realRoot);
    symlinkSync(realRoot, linkedRoot, process.platform === "win32" ? "junction" : "dir");

    await expect(writeDocumentBundle(document(), graph(), linkedRoot, NOW)).rejects.toThrow("symbolic links");
    expect(readdirSync(realRoot)).toEqual([]);
  });

  it("recovers only stale document-specific staging directories", async () => {
    const stale = path.join(root, ".DOC-RENDER-001.crashed.staging");
    const unrelated = path.join(root, ".DOC-OTHER-001.crashed.staging");
    mkdirSync(stale);
    mkdirSync(unrelated);
    const old = new Date(NOW.getTime() - 2 * 60 * 60 * 1_000);
    utimesSync(stale, old, old);
    utimesSync(unrelated, old, old);

    await writeDocumentBundle(document(), graph(), root, NOW);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(unrelated)).toBe(true);
  }, 30_000);

  it("rejects a heading-only document instead of treating empty content as fully traced", async () => {
    const headingOnly: DocumentAstV2 = {
      ...document(),
      sections: [{
        sectionId: "SEC-EMPTY-001",
        labelKey: "summary",
        nodes: [{
          nodeId: "NODE-HEADING-ONLY",
          type: "heading",
          level: 2,
          textKey: "summary",
          claimIds: []
        }]
      }]
    };

    const validation = validateDocumentAstV2(headingOnly, graph(), NOW);
    expect(validation.reasons).toContain("document-content-node-missing");
    await expect(writeDocumentBundle(headingOnly, graph(), root, NOW)).rejects.toThrow(
      "document-content-node-missing"
    );
  });
});
