import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  careerTwinFromImportPlan,
  createProfileImportPlan,
  parseProfileArtifact,
  validateProfileImportPlan
} from "../../src/import/profile-import.js";
import { ArtifactVault } from "../../src/storage/artifact-vault.js";

const NOW = new Date("2026-07-12T03:00:00.000Z");

async function pdfFixture(): Promise<Buffer> {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  const page = document.addPage([595, 842]);
  page.drawText("Clinical psychologist and responsible AI researcher", { x: 50, y: 780, size: 12, font });
  page.drawText("TypeScript and Python research systems", { x: 50, y: 750, size: 12, font });
  return Buffer.from(await document.save({ useObjectStreams: false }));
}

async function docxFixture(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`);
  zip.folder("_rels")?.file(".rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`);
  zip.folder("word")?.file("document.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t>Licensed clinical psychologist</w:t></w:r></w:p>
    <w:p><w:r><w:t>Researcher in evidence grounded AI systems</w:t></w:r></w:p>
  </w:body>
</w:document>`);
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

describe("bounded profile import planning", () => {
  let root: string;
  let vault: ArtifactVault;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "vocation-profile-import-"));
    vault = new ArtifactVault({ rootPath: path.join(root, "artifacts"), masterKey: Buffer.alloc(32, 0x51) });
  }, 30_000);

  afterEach(() => {
    vault.close();
    rmSync(root, { recursive: true, force: true });
  }, 30_000);

  it("parses UTF-8 markdown in an isolated child and creates review-only facts", async () => {
    const source = Buffer.from("# Profile\nLicensed clinical psychologist\nTypeScript research systems\n", "utf8");
    const manifest = vault.store(source).manifest;
    const extracted = await parseProfileArtifact(source, "markdown");
    const plan = createProfileImportPlan(manifest, extracted, NOW);
    const twin = careerTwinFromImportPlan(plan);

    expect(extracted).toMatchObject({ format: "markdown", pageCount: null });
    expect(plan.candidateCount).toBe(3);
    expect(validateProfileImportPlan(plan)).toEqual([]);
    expect(twin.profileScope).toBe("local-private");
    expect(twin.facts).toHaveLength(3);
    expect(twin.facts.every((fact) =>
      fact.evidenceStatus === "operator_supplied"
      && fact.confidence === "Low"
      && fact.allowedUses.length === 1
      && fact.allowedUses[0] === "analysis"
    )).toBe(true);
  });

  it("extracts text from generated PDF and DOCX binaries", async () => {
    const [pdf, docx] = await Promise.all([pdfFixture(), docxFixture()]);
    const [pdfResult, docxResult] = await Promise.all([
      parseProfileArtifact(pdf, "pdf"),
      parseProfileArtifact(docx, "docx")
    ]);

    expect(pdfResult.pageCount).toBe(1);
    expect(pdfResult.text).toContain("Clinical psychologist");
    expect(pdfResult.text).toContain("TypeScript and Python");
    expect(docxResult.pageCount).toBeNull();
    expect(docxResult.text).toContain("Licensed clinical psychologist");
    expect(docxResult.text).toContain("evidence grounded AI systems");
  }, 30_000);

  it("detects plan tampering and rejects malformed UTF-8", async () => {
    const source = Buffer.from("Researcher\n", "utf8");
    const plan = createProfileImportPlan(
      vault.store(source).manifest,
      await parseProfileArtifact(source, "text"),
      NOW
    );
    expect(validateProfileImportPlan({
      ...plan,
      candidates: plan.candidates.map((candidate) => ({ ...candidate, text: `${candidate.text} inflated` }))
    }).join(" ")).toContain("hash mismatch");
    await expect(parseProfileArtifact(Buffer.from([0xc3, 0x28]), "text")).rejects.toThrow("not valid UTF-8");
  });

  it("does not expose parser diagnostics or source content for malformed documents", async () => {
    const privateMarker = "PRIVATE-PROFILE-CONTENT-MUST-NOT-LEAK";
    let message = "";
    try {
      await parseProfileArtifact(Buffer.from(`${privateMarker} invalid pdf`, "utf8"), "pdf");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toBe("PDF structure is invalid");
    expect(message).not.toContain(privateMarker);
  });

  it("rejects a high compression ratio DOCX before Mammoth receives it", async () => {
    const zip = await JSZip.loadAsync(await docxFixture());
    zip.file("word/media/resource-bomb.bin", "A".repeat(2 * 1024 * 1024));
    const bomb = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
    await expect(parseProfileArtifact(bomb, "docx")).rejects.toThrow("resource limits");
  }, 30_000);
});
