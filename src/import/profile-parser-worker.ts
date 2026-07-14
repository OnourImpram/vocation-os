import dgram from "node:dgram";
import dns from "node:dns";
import http from "node:http";
import http2 from "node:http2";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { syncBuiltinESMExports } from "node:module";
import { inflateRawSync } from "node:zlib";

export const PROFILE_IMPORT_FORMATS = ["pdf", "docx", "markdown", "text"] as const;
export type ProfileImportFormat = (typeof PROFILE_IMPORT_FORMATS)[number];

export interface ProfileParserRequest {
  type: "parse-profile";
  format: ProfileImportFormat;
  data: Buffer;
}

export interface ExtractedProfileText {
  format: ProfileImportFormat;
  pageCount: number | null;
  text: string;
}

interface ProfileParserSuccess {
  type: "profile-parsed";
  result: ExtractedProfileText;
}

interface ProfileParserFailure {
  type: "profile-parse-failed";
  error: string;
}

export type ProfileParserResponse = ProfileParserSuccess | ProfileParserFailure;

export const PROFILE_IMPORT_LIMITS = {
  maxPdfBytes: 25 * 1024 * 1024,
  maxDocxBytes: 25 * 1024 * 1024,
  maxTextBytes: 4 * 1024 * 1024,
  maxPages: 200,
  maxTextCharacters: 1_000_000,
  maxPdfObjects: 50_000,
  maxPdfStreams: 20_000,
  maxPdfNames: 200_000,
  maxPdfDeclaredStreamBytes: 16 * 1024 * 1024,
  maxPdfTextItemsPerPage: 20_000,
  maxPdfTextItems: 100_000,
  maxZipEntries: 2_048,
  maxZipCentralDirectoryBytes: 2 * 1024 * 1024,
  maxZipEntryCompressedBytes: 16 * 1024 * 1024,
  maxZipEntryUncompressedBytes: 16 * 1024 * 1024,
  maxZipTotalUncompressedBytes: 64 * 1024 * 1024,
  maxZipCompressionRatio: 100
} as const;

const SAFE_PARSER_MESSAGES = new Set([
  "DOCX archive is malformed",
  "DOCX archive exceeds resource limits",
  "DOCX active content is not accepted",
  "DOCX parser reported an extraction error",
  "PDF structure is invalid",
  "PDF exceeds resource limits",
  "PDF active content is not accepted",
  "PDF encrypted content is not accepted",
  "Text profile source is not valid UTF-8",
  "Profile source exceeds the accepted size limit",
  "Unsupported profile import format",
  "Profile parser request is invalid"
]);

const ZIP_END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const ZIP_CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const ZIP_LOCAL_FILE_SIGNATURE = 0x04034b50;
const ZIP64_EXTRA_FIELD_ID = 0x0001;
const ZIP_ALLOWED_FLAGS = (1 << 1) | (1 << 2) | (1 << 3) | (1 << 11);
const ZIP_REQUIRED_PARTS = new Set(["[Content_Types].xml", "_rels/.rels", "word/document.xml"]);
const ZIP_PROHIBITED_PARTS = ["word/vbaproject.bin", "word/activex/", "word/embeddings/"];
const PDF_FORBIDDEN_ACTIVE_NAMES = new Set([
  "AA",
  "EmbeddedFile",
  "Filespec",
  "ImportData",
  "JavaScript",
  "JS",
  "Launch",
  "OpenAction",
  "RichMedia",
  "SubmitForm",
  "XFA"
]);
const PDF_EOF_MARKER = Buffer.from("%%EOF", "ascii");

interface DocxZipEntry {
  name: string;
  flags: number;
  compressionMethod: 0 | 8;
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
  dataOffset: number;
}

interface DocxPreflightResult {
  entries: DocxZipEntry[];
  totalCompressedSize: number;
  totalUncompressedSize: number;
}

function parserSafetyError(message: string): Error {
  return new Error(message);
}

export function publicParserError(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (SAFE_PARSER_MESSAGES.has(message)) return message;
  if (/^PDF exceeds \d+ pages$/u.test(message)) return message;
  if (/^Extracted profile text exceeds \d+ characters$/u.test(message)) return message;
  return "Profile parser rejected the supplied document";
}

function isAsciiWhitespace(byte: number): boolean {
  return byte === 0x00 || byte === 0x09 || byte === 0x0a || byte === 0x0c || byte === 0x0d || byte === 0x20;
}

function boundedSource(data: Buffer, maximum: number): void {
  if (data.length === 0 || data.length > maximum) {
    throw parserSafetyError("Profile source exceeds the accepted size limit");
  }
}

function decodeZipName(bytes: Buffer, utf8: boolean): string {
  if (!utf8 && bytes.some((byte) => byte > 0x7f)) {
    throw parserSafetyError("DOCX archive is malformed");
  }
  try {
    return utf8
      ? new TextDecoder("utf-8", { fatal: true }).decode(bytes)
      : bytes.toString("ascii");
  } catch {
    throw parserSafetyError("DOCX archive is malformed");
  }
}

function assertSafeZipName(name: string): void {
  if (name.length === 0 || name.length > 512 || name.includes("\0") || name.includes("\\") || name.startsWith("/")) {
    throw parserSafetyError("DOCX archive is malformed");
  }
  const pathValue = name.endsWith("/") ? name.slice(0, -1) : name;
  const segments = pathValue.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === ".." || segment.includes(":"))) {
    throw parserSafetyError("DOCX archive is malformed");
  }
}

function hasZip64ExtraField(data: Buffer, offset: number, length: number): boolean {
  const end = offset + length;
  let cursor = offset;
  while (cursor < end) {
    if (cursor + 4 > end) throw parserSafetyError("DOCX archive is malformed");
    const fieldId = data.readUInt16LE(cursor);
    const fieldLength = data.readUInt16LE(cursor + 2);
    cursor += 4;
    if (cursor + fieldLength > end) throw parserSafetyError("DOCX archive is malformed");
    if (fieldId === ZIP64_EXTRA_FIELD_ID) return true;
    cursor += fieldLength;
  }
  return false;
}

function findZipEndRecord(data: Buffer): number {
  const minimumOffset = Math.max(0, data.length - 22 - 0xffff);
  for (let offset = data.length - 22; offset >= minimumOffset; offset -= 1) {
    if (data.readUInt32LE(offset) !== ZIP_END_OF_CENTRAL_DIRECTORY_SIGNATURE) continue;
    const commentLength = data.readUInt16LE(offset + 20);
    if (offset + 22 + commentLength === data.length) return offset;
  }
  throw parserSafetyError("DOCX archive is malformed");
}

function inspectDocxCentralDirectory(data: Buffer): DocxPreflightResult {
  boundedSource(data, PROFILE_IMPORT_LIMITS.maxDocxBytes);
  if (data.length < 22) throw parserSafetyError("DOCX archive is malformed");
  const endOffset = findZipEndRecord(data);
  const diskNumber = data.readUInt16LE(endOffset + 4);
  const centralDirectoryDisk = data.readUInt16LE(endOffset + 6);
  const entriesOnDisk = data.readUInt16LE(endOffset + 8);
  const totalEntries = data.readUInt16LE(endOffset + 10);
  const centralDirectorySize = data.readUInt32LE(endOffset + 12);
  const centralDirectoryOffset = data.readUInt32LE(endOffset + 16);
  if (
    diskNumber !== 0
    || centralDirectoryDisk !== 0
    || entriesOnDisk !== totalEntries
    || totalEntries === 0
    || totalEntries === 0xffff
    || centralDirectorySize === 0xffffffff
    || centralDirectoryOffset === 0xffffffff
  ) {
    throw parserSafetyError("DOCX archive is malformed");
  }
  if (
    totalEntries > PROFILE_IMPORT_LIMITS.maxZipEntries
    || centralDirectorySize > PROFILE_IMPORT_LIMITS.maxZipCentralDirectoryBytes
  ) {
    throw parserSafetyError("DOCX archive exceeds resource limits");
  }
  if (centralDirectoryOffset + centralDirectorySize !== endOffset) {
    throw parserSafetyError("DOCX archive is malformed");
  }

  const entries: DocxZipEntry[] = [];
  const names = new Set<string>();
  const requiredParts = new Set(ZIP_REQUIRED_PARTS);
  let totalCompressedSize = 0;
  let totalUncompressedSize = 0;
  let cursor = centralDirectoryOffset;
  for (let index = 0; index < totalEntries; index += 1) {
    if (cursor + 46 > endOffset || data.readUInt32LE(cursor) !== ZIP_CENTRAL_DIRECTORY_SIGNATURE) {
      throw parserSafetyError("DOCX archive is malformed");
    }
    const flags = data.readUInt16LE(cursor + 8);
    const compressionMethod = data.readUInt16LE(cursor + 10);
    const crc32 = data.readUInt32LE(cursor + 16);
    const compressedSize = data.readUInt32LE(cursor + 20);
    const uncompressedSize = data.readUInt32LE(cursor + 24);
    const nameLength = data.readUInt16LE(cursor + 28);
    const extraLength = data.readUInt16LE(cursor + 30);
    const commentLength = data.readUInt16LE(cursor + 32);
    const startingDisk = data.readUInt16LE(cursor + 34);
    const localHeaderOffset = data.readUInt32LE(cursor + 42);
    const recordEnd = cursor + 46 + nameLength + extraLength + commentLength;
    if (recordEnd > endOffset || nameLength === 0 || startingDisk !== 0) {
      throw parserSafetyError("DOCX archive is malformed");
    }
    if (
      compressedSize === 0xffffffff
      || uncompressedSize === 0xffffffff
      || localHeaderOffset === 0xffffffff
      || hasZip64ExtraField(data, cursor + 46 + nameLength, extraLength)
    ) {
      throw parserSafetyError("DOCX archive is malformed");
    }
    if ((flags & 0x0001) !== 0 || (flags & 0x0040) !== 0 || (flags & ~ZIP_ALLOWED_FLAGS) !== 0) {
      throw parserSafetyError("DOCX archive is malformed");
    }
    if (compressionMethod !== 0 && compressionMethod !== 8) {
      throw parserSafetyError("DOCX archive is malformed");
    }
    if (
      compressedSize > PROFILE_IMPORT_LIMITS.maxZipEntryCompressedBytes
      || uncompressedSize > PROFILE_IMPORT_LIMITS.maxZipEntryUncompressedBytes
    ) {
      throw parserSafetyError("DOCX archive exceeds resource limits");
    }
    if (
      uncompressedSize > 64 * 1024
      && uncompressedSize / Math.max(1, compressedSize) > PROFILE_IMPORT_LIMITS.maxZipCompressionRatio
    ) {
      throw parserSafetyError("DOCX archive exceeds resource limits");
    }

    const name = decodeZipName(data.subarray(cursor + 46, cursor + 46 + nameLength), (flags & 0x0800) !== 0);
    assertSafeZipName(name);
    const canonicalName = name.toLocaleLowerCase("en-US");
    if (names.has(canonicalName)) throw parserSafetyError("DOCX archive is malformed");
    names.add(canonicalName);
    requiredParts.delete(name);
    if (ZIP_PROHIBITED_PARTS.some((part) => canonicalName === part || canonicalName.startsWith(part))) {
      throw parserSafetyError("DOCX active content is not accepted");
    }

    totalCompressedSize += compressedSize;
    totalUncompressedSize += uncompressedSize;
    if (
      totalCompressedSize > PROFILE_IMPORT_LIMITS.maxDocxBytes
      || totalUncompressedSize > PROFILE_IMPORT_LIMITS.maxZipTotalUncompressedBytes
    ) {
      throw parserSafetyError("DOCX archive exceeds resource limits");
    }
    entries.push({
      name,
      flags,
      compressionMethod,
      crc32,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
      dataOffset: 0
    });
    cursor = recordEnd;
  }
  if (cursor !== endOffset || requiredParts.size > 0) throw parserSafetyError("DOCX archive is malformed");
  if (
    totalUncompressedSize > 1024 * 1024
    && totalUncompressedSize / Math.max(1, totalCompressedSize) > PROFILE_IMPORT_LIMITS.maxZipCompressionRatio
  ) {
    throw parserSafetyError("DOCX archive exceeds resource limits");
  }

  const ranges: Array<{ start: number; end: number }> = [];
  for (const entry of entries) {
    const localOffset = entry.localHeaderOffset;
    if (localOffset + 30 > centralDirectoryOffset || data.readUInt32LE(localOffset) !== ZIP_LOCAL_FILE_SIGNATURE) {
      throw parserSafetyError("DOCX archive is malformed");
    }
    const localFlags = data.readUInt16LE(localOffset + 6);
    const localMethod = data.readUInt16LE(localOffset + 8);
    const localCrc32 = data.readUInt32LE(localOffset + 14);
    const localCompressedSize = data.readUInt32LE(localOffset + 18);
    const localUncompressedSize = data.readUInt32LE(localOffset + 22);
    const localNameLength = data.readUInt16LE(localOffset + 26);
    const localExtraLength = data.readUInt16LE(localOffset + 28);
    const localHeaderEnd = localOffset + 30 + localNameLength + localExtraLength;
    if (localHeaderEnd > centralDirectoryOffset || localFlags !== entry.flags || localMethod !== entry.compressionMethod) {
      throw parserSafetyError("DOCX archive is malformed");
    }
    const localName = decodeZipName(
      data.subarray(localOffset + 30, localOffset + 30 + localNameLength),
      (localFlags & 0x0800) !== 0
    );
    if (localName !== entry.name || hasZip64ExtraField(data, localOffset + 30 + localNameLength, localExtraLength)) {
      throw parserSafetyError("DOCX archive is malformed");
    }
    const usesDataDescriptor = (localFlags & 0x0008) !== 0;
    if (
      (!usesDataDescriptor && (
        localCrc32 !== entry.crc32
        || localCompressedSize !== entry.compressedSize
        || localUncompressedSize !== entry.uncompressedSize
      ))
      || (usesDataDescriptor && (
        (localCrc32 !== 0 && localCrc32 !== entry.crc32)
        || (localCompressedSize !== 0 && localCompressedSize !== entry.compressedSize)
        || (localUncompressedSize !== 0 && localUncompressedSize !== entry.uncompressedSize)
      ))
    ) {
      throw parserSafetyError("DOCX archive is malformed");
    }
    const dataEnd = localHeaderEnd + entry.compressedSize;
    if (dataEnd > centralDirectoryOffset) throw parserSafetyError("DOCX archive is malformed");
    entry.dataOffset = localHeaderEnd;
    ranges.push({ start: localOffset, end: dataEnd });
  }
  ranges.sort((left, right) => left.start - right.start);
  for (let index = 1; index < ranges.length; index += 1) {
    const previous = ranges[index - 1];
    const current = ranges[index];
    if (!previous || !current || previous.end > current.start) {
      throw parserSafetyError("DOCX archive is malformed");
    }
  }
  return { entries, totalCompressedSize, totalUncompressedSize };
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(data: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of data) {
    value = CRC32_TABLE[(value ^ byte) & 0xff]! ^ (value >>> 8);
  }
  return (value ^ 0xffffffff) >>> 0;
}

function inspectInflatedXml(entry: DocxZipEntry, value: Buffer): void {
  if (!entry.name.endsWith(".xml") && !entry.name.endsWith(".rels")) return;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(value);
  } catch {
    throw parserSafetyError("DOCX archive is malformed");
  }
  const upper = text.toUpperCase();
  if (upper.includes("<!DOCTYPE") || upper.includes("<!ENTITY")) {
    throw parserSafetyError("DOCX active content is not accepted");
  }
}

function verifyDocxCompressedData(data: Buffer): void {
  const preflight = inspectDocxCentralDirectory(data);
  for (const entry of preflight.entries) {
    const compressed = data.subarray(entry.dataOffset, entry.dataOffset + entry.compressedSize);
    let inflated: Buffer | null = null;
    try {
      const value = entry.compressionMethod === 0
        ? compressed
        : inflateRawSync(compressed, { maxOutputLength: entry.uncompressedSize + 1 });
      if (value.length !== entry.uncompressedSize || crc32(value) !== entry.crc32) {
        throw parserSafetyError("DOCX archive is malformed");
      }
      inspectInflatedXml(entry, value);
      if (entry.compressionMethod === 8) inflated = value;
    } catch (error) {
      if (error instanceof Error && SAFE_PARSER_MESSAGES.has(error.message)) throw error;
      throw parserSafetyError("DOCX archive exceeds resource limits");
    } finally {
      inflated?.fill(0);
    }
  }
}

function decodePdfName(value: string): string {
  if (/#(?![0-9a-fA-F]{2})/u.test(value)) throw parserSafetyError("PDF structure is invalid");
  return value.replace(/#([0-9a-fA-F]{2})/gu, (_match, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
}

function countPdfPattern(source: string, pattern: RegExp, maximum: number): number {
  let count = 0;
  pattern.lastIndex = 0;
  while (pattern.exec(source) !== null) {
    count += 1;
    if (count > maximum) throw parserSafetyError("PDF exceeds resource limits");
  }
  return count;
}

function pdfStructureWithoutStreamBodies(source: string): string {
  const fragments: string[] = [];
  const streamPattern = /(?:^|\r|\n)stream(?:\r\n|\r|\n)/gu;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = streamPattern.exec(source)) !== null) {
    fragments.push(source.slice(cursor, match.index), "\nstream\n");
    const endStream = source.indexOf("endstream", streamPattern.lastIndex);
    if (endStream < 0) throw parserSafetyError("PDF structure is invalid");
    cursor = endStream + "endstream".length;
    streamPattern.lastIndex = cursor;
  }
  fragments.push(source.slice(cursor));
  return fragments.join("");
}

function inspectPdfStructure(data: Buffer): void {
  boundedSource(data, PROFILE_IMPORT_LIMITS.maxPdfBytes);
  if (data.length < 16 || !data.subarray(0, 8).toString("ascii").match(/^%PDF-1\.[0-7]/u)) {
    throw parserSafetyError("PDF structure is invalid");
  }
  let contentEnd = data.length;
  while (contentEnd > 0 && isAsciiWhitespace(data[contentEnd - 1]!)) contentEnd -= 1;
  const eofOffset = data.lastIndexOf(PDF_EOF_MARKER, contentEnd - PDF_EOF_MARKER.length);
  if (eofOffset < 0 || eofOffset + PDF_EOF_MARKER.length !== contentEnd) {
    throw parserSafetyError("PDF structure is invalid");
  }
  const trailerStart = Math.max(0, eofOffset - 4_096);
  const trailer = data.subarray(trailerStart, eofOffset).toString("latin1");
  const startXrefMatch = /startxref[\x00\x09\x0a\x0c\x0d\x20]+(\d+)[\x00\x09\x0a\x0c\x0d\x20]*$/u.exec(trailer);
  if (!startXrefMatch?.[1]) throw parserSafetyError("PDF structure is invalid");
  const startXref = Number.parseInt(startXrefMatch[1], 10);
  if (!Number.isSafeInteger(startXref) || startXref < 0 || startXref >= eofOffset) {
    throw parserSafetyError("PDF structure is invalid");
  }
  const xrefTarget = data.subarray(startXref, Math.min(startXref + 96, eofOffset)).toString("latin1");
  if (!xrefTarget.startsWith("xref") && !/^\d+[\x09\x20]+\d+[\x09\x20]+obj\b/u.test(xrefTarget)) {
    throw parserSafetyError("PDF structure is invalid");
  }

  const source = data.toString("latin1");
  countPdfPattern(source, /\b\d+[\x09\x20\r\n]+\d+[\x09\x20\r\n]+obj\b/gu, PROFILE_IMPORT_LIMITS.maxPdfObjects);
  countPdfPattern(source, /(?:^|\r|\n)stream(?:\r\n|\r|\n)/gu, PROFILE_IMPORT_LIMITS.maxPdfStreams);
  const lengthPattern = /\/Length[\x09\x20\r\n]+(\d+)/gu;
  let lengthMatch: RegExpExecArray | null;
  while ((lengthMatch = lengthPattern.exec(source)) !== null) {
    const declaredLength = Number.parseInt(lengthMatch[1] ?? "", 10);
    if (!Number.isSafeInteger(declaredLength) || declaredLength > PROFILE_IMPORT_LIMITS.maxPdfDeclaredStreamBytes) {
      throw parserSafetyError("PDF exceeds resource limits");
    }
  }
  const structuralSource = pdfStructureWithoutStreamBodies(source);
  if (/\/Type[\x09\x20\r\n]+\/ObjStm\b/u.test(structuralSource)) {
    throw parserSafetyError("PDF structure is invalid");
  }
  const namePattern = /\/([^\x00-\x20()<>\[\]{}/%]+)/gu;
  let nameCount = 0;
  let nameMatch: RegExpExecArray | null;
  while ((nameMatch = namePattern.exec(structuralSource)) !== null) {
    nameCount += 1;
    if (nameCount > PROFILE_IMPORT_LIMITS.maxPdfNames) throw parserSafetyError("PDF exceeds resource limits");
    const name = decodePdfName(nameMatch[1] ?? "");
    if (name === "Encrypt") throw parserSafetyError("PDF encrypted content is not accepted");
    if (PDF_FORBIDDEN_ACTIVE_NAMES.has(name)) throw parserSafetyError("PDF active content is not accepted");
  }
}

export function preflightProfileArtifact(data: Buffer, format: ProfileImportFormat): void {
  if (!Buffer.isBuffer(data)) throw parserSafetyError("Profile parser request is invalid");
  if (format === "docx") {
    inspectDocxCentralDirectory(data);
    return;
  }
  if (format === "pdf") {
    inspectPdfStructure(data);
    return;
  }
  if (format === "markdown" || format === "text") {
    boundedSource(data, PROFILE_IMPORT_LIMITS.maxTextBytes);
    return;
  }
  throw parserSafetyError("Unsupported profile import format");
}

function boundedText(value: string): string {
  const normalized = value.normalize("NFC").replace(/\u0000/g, "").replace(/\r\n?/g, "\n");
  if (normalized.length > PROFILE_IMPORT_LIMITS.maxTextCharacters) {
    throw new Error(`Extracted profile text exceeds ${PROFILE_IMPORT_LIMITS.maxTextCharacters} characters`);
  }
  return normalized;
}

function hasActions(value: object | null): boolean {
  return value !== null && Object.keys(value).length > 0;
}

async function parsePdf(data: Buffer): Promise<ExtractedProfileText> {
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const loadingTask = getDocument({
    data: new Uint8Array(data),
    useSystemFonts: false,
    disableFontFace: true,
    useWorkerFetch: false,
    useWasm: false,
    stopAtErrors: true,
    enableXfa: false,
    disableRange: true,
    disableStream: true,
    disableAutoFetch: true,
    maxImageSize: 1_000_000,
    isOffscreenCanvasSupported: false,
    isImageDecoderSupported: false,
    canvasMaxAreaInBytes: 4 * 1024 * 1024
  });
  let document: Awaited<typeof loadingTask.promise> | null = null;
  try {
    document = await loadingTask.promise;
    if (document.numPages > PROFILE_IMPORT_LIMITS.maxPages) {
      throw new Error(`PDF exceeds ${PROFILE_IMPORT_LIMITS.maxPages} pages`);
    }
    const [attachments, documentActions, openAction] = await Promise.all([
      document.getAttachments(),
      document.getJSActions(),
      document.getOpenAction()
    ]);
    if (document.isPureXfa || (attachments?.size ?? 0) > 0 || hasActions(documentActions) || openAction !== null) {
      throw parserSafetyError("PDF active content is not accepted");
    }

    const pages: string[] = [];
    let totalTextItems = 0;
    let totalCharacters = 0;
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      try {
        const pageActions = await page.getJSActions();
        if (hasActions(pageActions)) throw parserSafetyError("PDF active content is not accepted");
        const content = await page.getTextContent();
        if (content.items.length > PROFILE_IMPORT_LIMITS.maxPdfTextItemsPerPage) {
          throw parserSafetyError("PDF exceeds resource limits");
        }
        totalTextItems += content.items.length;
        if (totalTextItems > PROFILE_IMPORT_LIMITS.maxPdfTextItems) {
          throw parserSafetyError("PDF exceeds resource limits");
        }
        const parts: string[] = [];
        for (const item of content.items) {
          if (!("str" in item) || typeof item.str !== "string") continue;
          totalCharacters += item.str.length + 1;
          if (totalCharacters > PROFILE_IMPORT_LIMITS.maxTextCharacters) {
            throw new Error(`Extracted profile text exceeds ${PROFILE_IMPORT_LIMITS.maxTextCharacters} characters`);
          }
          parts.push(item.str, "hasEOL" in item && item.hasEOL ? "\n" : " ");
        }
        pages.push(parts.join("").replace(/[ \t]+\n/g, "\n").trim());
      } finally {
        page.cleanup();
      }
    }
    return { format: "pdf", pageCount: document.numPages, text: boundedText(pages.join("\n\n")) };
  } finally {
    if (document) await document.cleanup();
    await loadingTask.destroy();
  }
}

async function parseDocx(data: Buffer): Promise<ExtractedProfileText> {
  verifyDocxCompressedData(data);
  const { default: mammoth } = await import("mammoth");
  const result = await mammoth.extractRawText({ buffer: data });
  if (result.messages.some((message) => message.type === "error")) {
    throw new Error("DOCX parser reported an extraction error");
  }
  return { format: "docx", pageCount: null, text: boundedText(result.value) };
}

function parseUtf8(data: Buffer, format: "markdown" | "text"): ExtractedProfileText {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    throw new Error("Text profile source is not valid UTF-8");
  }
  return { format, pageCount: null, text: boundedText(text) };
}

export async function parseProfileBuffer(request: ProfileParserRequest): Promise<ExtractedProfileText> {
  if (!Buffer.isBuffer(request.data)) throw new Error("Profile parser input must be a Buffer");
  preflightProfileArtifact(request.data, request.format);
  if (request.format === "pdf") return parsePdf(request.data);
  if (request.format === "docx") return parseDocx(request.data);
  if (request.format === "markdown" || request.format === "text") return parseUtf8(request.data, request.format);
  throw new Error("Unsupported profile import format");
}

function replaceCallable(target: object, property: string, replacement: (...arguments_: unknown[]) => never): void {
  try {
    Object.defineProperty(target, property, { configurable: true, writable: true, value: replacement });
  } catch {
    throw parserSafetyError("Profile parser request is invalid");
  }
}

function installNetworkDenyGuards(): void {
  const blocked = (): never => {
    throw new Error("Network access is disabled in the profile parser");
  };
  for (const [target, properties] of [
    [net, ["connect", "createConnection"]],
    [http, ["request", "get"]],
    [https, ["request", "get"]],
    [http2, ["connect"]],
    [tls, ["connect"]],
    [dgram, ["createSocket"]],
    [dns, ["lookup", "resolve", "resolve4", "resolve6", "resolveAny"]],
    [dns.promises, ["lookup", "resolve", "resolve4", "resolve6", "resolveAny"]]
  ] as const) {
    for (const property of properties) replaceCallable(target, property, blocked);
  }
  replaceCallable(net.Socket.prototype, "connect", blocked);
  replaceCallable(globalThis, "fetch", blocked);
  if ("WebSocket" in globalThis) replaceCallable(globalThis, "WebSocket", blocked);
  syncBuiltinESMExports();
}

if (process.env["VOCATION_PROFILE_PARSER_WORKER"] === "1" && typeof process.send === "function") {
  installNetworkDenyGuards();
  process.once("message", (message: unknown) => {
    void (async () => {
      let response: ProfileParserResponse;
      try {
        const request = message as Partial<ProfileParserRequest>;
        if (request.type !== "parse-profile" || !Buffer.isBuffer(request.data)) {
          throw new Error("Profile parser request is invalid");
        }
        response = { type: "profile-parsed", result: await parseProfileBuffer(request as ProfileParserRequest) };
      } catch (error) {
        response = {
          type: "profile-parse-failed",
          error: publicParserError(error)
        };
      }
      process.send?.(response, (error) => {
        if (error) process.exitCode = 1;
        if (process.connected) process.disconnect();
      });
    })();
  });
}
