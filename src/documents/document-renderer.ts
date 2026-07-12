import fontkit from "@pdf-lib/fontkit";
import {
  Document as DocxDocument,
  HeadingLevel,
  Packer,
  Paragraph,
  TextRun
} from "docx";
import { PDFDocument as PdfDocument, type PDFFont, type PDFPage } from "pdf-lib";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { PACKAGE_ROOT } from "../paths.js";
import { sha256 } from "../hash.js";
import type { ClaimGraph } from "../types.js";
import { parseProfileArtifact } from "../import/profile-import.js";
import {
  documentTextSegments,
  localizedDocumentTitle,
  localizedSectionLabel,
  localizedStructureText,
  validateDocumentAstV2,
  type DocumentAstV2,
  type DocumentLocale,
  type DocumentNodeV2
} from "./document-ast-v2.js";

export interface DocumentFormatVerification {
  valid: boolean;
  segmentCount: number;
  verifiedSegments: number;
  missingSegments: string[];
  extractedTextHash: string;
}

export interface DocumentRenderVerification {
  valid: boolean;
  traceCoverage: number;
  pdf: DocumentFormatVerification;
  docx: DocumentFormatVerification;
}

export interface RenderedDocumentBundle {
  pdf: Buffer;
  docx: Buffer;
  verification: DocumentRenderVerification;
}

export interface WrittenDocumentBundle {
  documentId: string;
  pdfPath: string;
  docxPath: string;
  pdfHash: string;
  docxHash: string;
  verification: DocumentRenderVerification;
}

const FONT_ROOT = path.join(PACKAGE_ROOT, "assets", "fonts");
const REGULAR_FONT_PATH = path.join(FONT_ROOT, "NotoSans-Regular.ttf");
const BOLD_FONT_PATH = path.join(FONT_ROOT, "NotoSans-Bold.ttf");
const PAGE_SIZES = {
  A4: [595.28, 841.89] as const,
  LETTER: [612, 792] as const
};

function normalizeForVerification(value: string): string {
  return value.normalize("NFC").replace(/\u2022/gu, " ").replace(/\s+/g, " ").trim();
}

function verifyExtractedText(expectedSegments: string[], extractedText: string): DocumentFormatVerification {
  const normalizedExtracted = normalizeForVerification(extractedText);
  const normalizedExpected = expectedSegments.map(normalizeForVerification).filter(Boolean).join(" ");
  const valid = normalizedExtracted === normalizedExpected;
  const missingSegments = valid ? [] : ["rendered text does not exactly match the ordered document AST"];
  return {
    valid,
    segmentCount: expectedSegments.length,
    verifiedSegments: valid ? expectedSegments.length : 0,
    missingSegments,
    extractedTextHash: sha256(extractedText)
  };
}

function wrapText(text: string, font: PDFFont, fontSize: number, width: number): string[] {
  const words = text.trim().split(/\s+/);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, fontSize) <= width) {
      current = candidate;
      continue;
    }
    if (current) lines.push(current);
    if (font.widthOfTextAtSize(word, fontSize) <= width) {
      current = word;
      continue;
    }
    let fragment = "";
    for (const character of word) {
      const next = `${fragment}${character}`;
      if (font.widthOfTextAtSize(next, fontSize) > width && fragment) {
        lines.push(fragment);
        fragment = character;
      } else {
        fragment = next;
      }
    }
    current = fragment;
  }
  if (current) lines.push(current);
  return lines.length > 0 ? lines : [""];
}

interface PdfCursor {
  page: PDFPage;
  y: number;
}

async function renderPdf(document: DocumentAstV2): Promise<Buffer> {
  const pdf = await PdfDocument.create();
  pdf.registerFontkit(fontkit);
  const regularBytes = readFileSync(REGULAR_FONT_PATH);
  const boldBytes = readFileSync(BOLD_FONT_PATH);
  const regular = await pdf.embedFont(regularBytes, { subset: true });
  const bold = await pdf.embedFont(boldBytes, { subset: true });
  const size = PAGE_SIZES[document.layout.pageSize];
  const margin = document.layout.marginPoints;
  const width = size[0] - margin * 2;
  const createdAt = new Date(document.generatedAt);
  const documentTitle = localizedDocumentTitle(document);
  pdf.setTitle(documentTitle);
  pdf.setAuthor("VocationOS");
  pdf.setCreator("VocationOS claim bound document engine");
  pdf.setCreationDate(createdAt);
  pdf.setModificationDate(createdAt);

  const newPage = (): PdfCursor => ({ page: pdf.addPage([...size]), y: size[1] - margin });
  let cursor = newPage();
  const draw = (text: string, font: PDFFont, fontSize: number, indent = 0, spacingAfter = 4): void => {
    const lineHeight = fontSize * 1.35;
    for (const line of wrapText(text, font, fontSize, width - indent)) {
      if (cursor.y - lineHeight < margin) cursor = newPage();
      cursor.page.drawText(line, { x: margin + indent, y: cursor.y - fontSize, size: fontSize, font });
      cursor.y -= lineHeight;
    }
    cursor.y -= spacingAfter;
  };

  draw(documentTitle, bold, document.layout.bodyFontSize + 5, 0, 10);
  for (const section of document.sections) {
    draw(localizedSectionLabel(document.locale, section.labelKey), bold, document.layout.bodyFontSize + 2, 0, 6);
    for (const node of section.nodes) {
      if (node.type === "heading") {
        draw(localizedStructureText(document.locale, node.textKey), bold, document.layout.bodyFontSize + Math.max(0, 2 - node.level), 0, 4);
      } else {
        draw(node.type === "bullet" ? `• ${node.text}` : node.text, regular, document.layout.bodyFontSize, node.type === "bullet" ? 12 : 0, 4);
      }
    }
    cursor.y -= 4;
  }
  return Buffer.from(await pdf.save({ useObjectStreams: false }));
}

function paragraphForNode(node: DocumentNodeV2, locale: DocumentLocale, bodyFontSize: number): Paragraph {
  if (node.type === "heading") {
    const heading = node.level === 1 ? HeadingLevel.HEADING_1 : node.level === 2 ? HeadingLevel.HEADING_2 : HeadingLevel.HEADING_3;
    const headingText = localizedStructureText(locale, node.textKey);
    return new Paragraph({ heading, children: [new TextRun({ text: headingText, font: "Noto Sans" })] });
  }
  return new Paragraph({
    ...(node.type === "bullet" ? { bullet: { level: 0 } } : {}),
    children: [new TextRun({ text: node.text, font: "Noto Sans", size: Math.round(bodyFontSize * 2) })]
  });
}

async function renderDocx(document: DocumentAstV2): Promise<Buffer> {
  const children: Paragraph[] = [
    new Paragraph({
      heading: HeadingLevel.TITLE,
      children: [new TextRun({ text: localizedDocumentTitle(document), bold: true, font: "Noto Sans" })]
    })
  ];
  for (const section of document.sections) {
    children.push(new Paragraph({
      heading: HeadingLevel.HEADING_1,
      children: [new TextRun({ text: localizedSectionLabel(document.locale, section.labelKey), bold: true, font: "Noto Sans" })]
    }));
    children.push(...section.nodes.map((node) => paragraphForNode(node, document.locale, document.layout.bodyFontSize)));
  }
  const marginTwips = Math.round(document.layout.marginPoints * 20);
  const page = document.layout.pageSize === "A4"
    ? { width: 11_906, height: 16_838 }
    : { width: 12_240, height: 15_840 };
  const output = new DocxDocument({
    creator: "VocationOS",
    title: localizedDocumentTitle(document),
    description: "Claim bound career document",
    sections: [{
      properties: {
        page: {
          size: page,
          margin: { top: marginTwips, right: marginTwips, bottom: marginTwips, left: marginTwips }
        }
      },
      children
    }]
  });
  return Packer.toBuffer(output);
}

export async function renderDocumentBundle(
  document: DocumentAstV2,
  graph: ClaimGraph,
  now = new Date()
): Promise<RenderedDocumentBundle> {
  const validation = validateDocumentAstV2(document, graph, now);
  if (!validation.valid) throw new Error(`Document AST v2 validation failed: ${validation.reasons.join(", ")}`);
  const [pdf, docx] = await Promise.all([renderPdf(document), renderDocx(document)]);
  try {
    const [pdfExtracted, docxExtracted] = await Promise.all([
      parseProfileArtifact(pdf, "pdf"),
      parseProfileArtifact(docx, "docx")
    ]);
    const expectedSegments = documentTextSegments(document);
    const pdfVerification = verifyExtractedText(expectedSegments, pdfExtracted.text);
    const docxVerification = verifyExtractedText(expectedSegments, docxExtracted.text);
    const verification: DocumentRenderVerification = {
      valid: pdfVerification.valid && docxVerification.valid && validation.traceCoverage === 1,
      traceCoverage: validation.traceCoverage,
      pdf: pdfVerification,
      docx: docxVerification
    };
    if (!verification.valid) {
      pdf.fill(0);
      docx.fill(0);
      throw new Error("Rendered document failed parse back verification");
    }
    return { pdf, docx, verification };
  } catch (error) {
    pdf.fill(0);
    docx.fill(0);
    throw error;
  }
}

function fsyncDirectory(directoryPath: string): void {
  let descriptor: number | null = null;
  try {
    descriptor = openSync(directoryPath, "r");
    fsyncSync(descriptor);
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error
      ? String((error as { code?: unknown }).code ?? "")
      : "";
    if (process.platform !== "win32" || !["EACCES", "EINVAL", "EPERM"].includes(code)) throw error;
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

function writeDurableFile(filePath: string, content: Buffer): void {
  let descriptor: number | null = null;
  try {
    descriptor = openSync(filePath, "wx", 0o600);
    writeFileSync(descriptor, content);
    fsyncSync(descriptor);
  } catch (error) {
    if (descriptor !== null) {
      closeSync(descriptor);
      descriptor = null;
    }
    rmSync(filePath, { force: true });
    throw error;
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

function canonicalOutputRoot(outputRoot: string): string {
  const resolved = path.resolve(outputRoot);
  if (!existsSync(resolved)) mkdirSync(resolved, { recursive: true, mode: 0o700 });
  const metadata = lstatSync(resolved);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error("Document output root must be a real directory without symbolic links");
  }
  return realpathSync(resolved);
}

function recoverAbandonedStages(root: string, documentId: string, now: Date): void {
  const prefix = `.${documentId}.`;
  const staleBefore = now.getTime() - 60 * 60 * 1_000;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.name.startsWith(prefix) || !entry.name.endsWith(".staging")) continue;
    const candidate = path.join(root, entry.name);
    const metadata = lstatSync(candidate);
    if (metadata.mtimeMs >= staleBefore) continue;
    rmSync(candidate, { recursive: metadata.isDirectory(), force: true });
  }
}

export async function writeDocumentBundle(
  document: DocumentAstV2,
  graph: ClaimGraph,
  outputRoot: string,
  now = new Date()
): Promise<WrittenDocumentBundle> {
  const resolvedRoot = canonicalOutputRoot(outputRoot);
  recoverAbandonedStages(resolvedRoot, document.documentId, now);
  const finalDirectory = path.join(resolvedRoot, document.documentId);
  if (existsSync(finalDirectory)) {
    throw new Error("Document output already exists. Use a new document id or output directory");
  }
  const bundle = await renderDocumentBundle(document, graph, now);
  const stagingDirectory = path.join(
    resolvedRoot,
    `.${document.documentId}.${process.pid}.${randomUUID()}.staging`
  );
  const pdfName = `${document.documentId}.pdf`;
  const docxName = `${document.documentId}.docx`;
  const pdfPath = path.join(finalDirectory, pdfName);
  const docxPath = path.join(finalDirectory, docxName);
  try {
    mkdirSync(stagingDirectory, { mode: 0o700 });
    writeDurableFile(path.join(stagingDirectory, pdfName), bundle.pdf);
    writeDurableFile(path.join(stagingDirectory, docxName), bundle.docx);
    fsyncDirectory(stagingDirectory);
    renameSync(stagingDirectory, finalDirectory);
    fsyncDirectory(resolvedRoot);
    return {
      documentId: document.documentId,
      pdfPath,
      docxPath,
      pdfHash: sha256(bundle.pdf),
      docxHash: sha256(bundle.docx),
      verification: bundle.verification
    };
  } catch (error) {
    if (existsSync(stagingDirectory)) rmSync(stagingDirectory, { recursive: true, force: true });
    throw error;
  } finally {
    bundle.pdf.fill(0);
    bundle.docx.fill(0);
  }
}
