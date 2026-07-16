import { CredentialImportError } from "./errors.js";
import type {
  CredentialEnvelopeFormat,
  CredentialImportSource,
  CredentialInputFormat,
  JsonObject,
  JsonValue
} from "./types.js";

export const VC_CONTEXT_URL = "https://www.w3.org/ns/credentials/v2";
export const OPEN_BADGES_CONTEXT_URL = "https://purl.imsglobal.org/spec/ob/v3p0/context-3.0.3.json";

const PNG_SIGNATURE = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
const FORBIDDEN_JSON_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const MEDIA_TYPES: Readonly<Record<CredentialInputFormat, string>> = {
  json: "application/json",
  "json-ld": "application/ld+json",
  "compact-jws": "application/jwt",
  "baked-png": "image/png",
  "baked-svg": "image/svg+xml"
};

export interface CredentialEnvelopeLimits {
  maxInputBytes: number;
  maxEmbeddedCredentialBytes: number;
  maxJsonDepth: number;
}

export interface ExtractedCredentialEnvelope {
  originalBytes: Uint8Array;
  sourceFormat: CredentialInputFormat;
  mediaType: string;
  envelopeFormat: CredentialEnvelopeFormat;
  serializedCredential: string;
}

class JsonSafetyScanner {
  private index = 0;
  private nodes = 0;

  public constructor(
    private readonly text: string,
    private readonly maxDepth: number
  ) {}

  public scan(): void {
    this.skipWhitespace();
    this.scanValue(0);
    this.skipWhitespace();
    if (this.index !== this.text.length) this.fail("json-trailing-content", "JSON contains trailing content");
  }

  private fail(code: string, message: string): never {
    throw new CredentialImportError(code, message);
  }

  private skipWhitespace(): void {
    while (this.index < this.text.length && /[\u0009\u000a\u000d\u0020]/u.test(this.text[this.index]!)) {
      this.index += 1;
    }
  }

  private scanValue(depth: number): void {
    if (depth > this.maxDepth) this.fail("json-depth-exceeded", "JSON nesting depth exceeds the configured limit");
    this.nodes += 1;
    if (this.nodes > 100_000) this.fail("json-node-limit-exceeded", "JSON node count exceeds the safety limit");
    this.skipWhitespace();
    const token = this.text[this.index];
    if (token === "{") {
      this.scanObject(depth);
      return;
    }
    if (token === "[") {
      this.scanArray(depth);
      return;
    }
    if (token === '"') {
      this.scanString();
      return;
    }
    if (token === "t") {
      this.scanLiteral("true");
      return;
    }
    if (token === "f") {
      this.scanLiteral("false");
      return;
    }
    if (token === "n") {
      this.scanLiteral("null");
      return;
    }
    this.scanNumber();
  }

  private scanObject(depth: number): void {
    this.index += 1;
    this.skipWhitespace();
    if (this.text[this.index] === "}") {
      this.index += 1;
      return;
    }
    const keys = new Set<string>();
    while (this.index < this.text.length) {
      this.skipWhitespace();
      if (this.text[this.index] !== '"') this.fail("json-object-key-invalid", "JSON object keys must be strings");
      const key = this.scanString();
      if (FORBIDDEN_JSON_KEYS.has(key)) this.fail("json-key-prohibited", `JSON key is prohibited: ${key}`);
      if (keys.has(key)) this.fail("json-duplicate-key", `JSON object contains a duplicate key: ${key}`);
      keys.add(key);
      this.skipWhitespace();
      if (this.text[this.index] !== ":") this.fail("json-colon-missing", "JSON object key is missing a colon");
      this.index += 1;
      this.scanValue(depth + 1);
      this.skipWhitespace();
      const separator = this.text[this.index];
      if (separator === "}") {
        this.index += 1;
        return;
      }
      if (separator !== ",") this.fail("json-object-separator-invalid", "JSON object separator is invalid");
      this.index += 1;
    }
    this.fail("json-object-unclosed", "JSON object is not closed");
  }

  private scanArray(depth: number): void {
    this.index += 1;
    this.skipWhitespace();
    if (this.text[this.index] === "]") {
      this.index += 1;
      return;
    }
    while (this.index < this.text.length) {
      this.scanValue(depth + 1);
      this.skipWhitespace();
      const separator = this.text[this.index];
      if (separator === "]") {
        this.index += 1;
        return;
      }
      if (separator !== ",") this.fail("json-array-separator-invalid", "JSON array separator is invalid");
      this.index += 1;
    }
    this.fail("json-array-unclosed", "JSON array is not closed");
  }

  private scanString(): string {
    const start = this.index;
    this.index += 1;
    while (this.index < this.text.length) {
      const character = this.text[this.index]!;
      if (character === '"') {
        this.index += 1;
        const raw = this.text.slice(start, this.index);
        try {
          return JSON.parse(raw) as string;
        } catch {
          this.fail("json-string-invalid", "JSON string is invalid");
        }
      }
      if (character === "\\") {
        this.index += 1;
        const escape = this.text[this.index];
        if (escape === undefined) this.fail("json-string-invalid", "JSON string ends after an escape character");
        if (escape === "u") {
          const codePoint = this.text.slice(this.index + 1, this.index + 5);
          if (!/^[0-9a-fA-F]{4}$/u.test(codePoint)) this.fail("json-string-invalid", "JSON unicode escape is invalid");
          this.index += 5;
          continue;
        }
        if (!/["\\/bfnrt]/u.test(escape)) this.fail("json-string-invalid", "JSON string escape is invalid");
        this.index += 1;
        continue;
      }
      if (character.codePointAt(0)! <= 0x1f) this.fail("json-string-invalid", "JSON string contains a control character");
      this.index += 1;
    }
    this.fail("json-string-unclosed", "JSON string is not closed");
  }

  private scanLiteral(literal: string): void {
    if (this.text.slice(this.index, this.index + literal.length) !== literal) {
      this.fail("json-literal-invalid", "JSON literal is invalid");
    }
    this.index += literal.length;
  }

  private scanNumber(): void {
    const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/u.exec(this.text.slice(this.index));
    if (!match) this.fail("json-token-invalid", "JSON contains an invalid token");
    this.index += match[0].length;
  }
}

function isJsonObject(value: JsonValue): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertJsonNumbersFinite(value: JsonValue): void {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new CredentialImportError("json-number-out-of-range", "JSON number is outside the finite number range");
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) assertJsonNumbersFinite(item);
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) assertJsonNumbersFinite(item);
  }
}

export function parseJsonObjectStrict(text: string, maxDepth: number): JsonObject {
  new JsonSafetyScanner(text, maxDepth).scan();
  let parsed: JsonValue;
  try {
    parsed = JSON.parse(text) as JsonValue;
  } catch {
    throw new CredentialImportError("json-invalid", "Credential JSON is invalid");
  }
  assertJsonNumbersFinite(parsed);
  if (!isJsonObject(parsed)) throw new CredentialImportError("json-root-invalid", "Credential JSON root must be an object");
  return parsed;
}

function decodeUtf8(bytes: Uint8Array, code: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new CredentialImportError(code, "Credential content is not valid UTF-8");
  }
}

function startsWithBytes(bytes: Uint8Array, prefix: Uint8Array): boolean {
  return prefix.every((value, index) => bytes[index] === value);
}

function credentialFormatFromText(text: string): CredentialInputFormat {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) return "json";
  if (/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(trimmed)) return "compact-jws";
  if (/^(?:<\?xml\s[^>]*>\s*)?<svg\b/iu.test(trimmed)) return "baked-svg";
  throw new CredentialImportError("credential-format-unsupported", "Credential input format could not be detected");
}

function normalizeMediaType(mediaType: string | undefined, format: CredentialInputFormat): string {
  if (mediaType === undefined) return MEDIA_TYPES[format];
  const normalized = mediaType.trim().toLowerCase();
  if (normalized.length === 0 || normalized.length > 200 || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new CredentialImportError("credential-media-type-invalid", "Credential media type is invalid");
  }
  return normalized;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) === 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function readNullTerminated(data: Uint8Array, offset: number, code: string): number {
  const end = data.indexOf(0, offset);
  if (end < 0) throw new CredentialImportError(code, "PNG iTXt field is not null terminated");
  return end;
}

function parseCredentialITXt(data: Uint8Array): string | null {
  const keywordEnd = readNullTerminated(data, 0, "png-itxt-keyword-invalid");
  const keyword = Buffer.from(data.subarray(0, keywordEnd)).toString("latin1");
  if (keyword !== "openbadgecredential") return null;
  let offset = keywordEnd + 1;
  if (offset + 2 > data.length) throw new CredentialImportError("png-itxt-invalid", "PNG credential iTXt is truncated");
  const compressionFlag = data[offset]!;
  const compressionMethod = data[offset + 1]!;
  offset += 2;
  if (compressionFlag !== 0 || compressionMethod !== 0) {
    throw new CredentialImportError("png-credential-compressed", "Compressed Open Badges PNG credentials are prohibited");
  }
  const languageEnd = readNullTerminated(data, offset, "png-itxt-language-invalid");
  offset = languageEnd + 1;
  const translatedKeywordEnd = readNullTerminated(data, offset, "png-itxt-translation-invalid");
  offset = translatedKeywordEnd + 1;
  return decodeUtf8(data.subarray(offset), "png-credential-utf8-invalid");
}

function extractPngCredential(bytes: Uint8Array): string {
  if (!startsWithBytes(bytes, PNG_SIGNATURE)) {
    throw new CredentialImportError("png-signature-invalid", "Baked PNG signature is invalid");
  }
  let offset = PNG_SIGNATURE.length;
  let seenHeader = false;
  let seenEnd = false;
  let embedded: string | null = null;
  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) throw new CredentialImportError("png-chunk-truncated", "PNG chunk is truncated");
    const view = Buffer.from(bytes.buffer, bytes.byteOffset + offset, bytes.length - offset);
    const length = view.readUInt32BE(0);
    const chunkEnd = offset + 12 + length;
    if (chunkEnd > bytes.length) throw new CredentialImportError("png-chunk-length-invalid", "PNG chunk length exceeds input");
    const typeBytes = bytes.subarray(offset + 4, offset + 8);
    const type = Buffer.from(typeBytes).toString("ascii");
    if (!/^[A-Za-z]{4}$/u.test(type)) throw new CredentialImportError("png-chunk-type-invalid", "PNG chunk type is invalid");
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    const storedCrc = Buffer.from(bytes.buffer, bytes.byteOffset + offset + 8 + length, 4).readUInt32BE(0);
    const actualCrc = crc32(bytes.subarray(offset + 4, offset + 8 + length));
    if (storedCrc !== actualCrc) throw new CredentialImportError("png-crc-invalid", `PNG chunk CRC is invalid: ${type}`);

    if (!seenHeader) {
      if (type !== "IHDR" || length !== 13) throw new CredentialImportError("png-header-invalid", "PNG IHDR must be first");
      seenHeader = true;
    }
    if (type === "iTXt") {
      const candidate = parseCredentialITXt(data);
      if (candidate !== null) {
        if (embedded !== null) {
          throw new CredentialImportError("png-credential-duplicate", "PNG contains multiple Open Badges credentials");
        }
        embedded = candidate;
      }
    }
    offset = chunkEnd;
    if (type === "IEND") {
      if (length !== 0) throw new CredentialImportError("png-end-invalid", "PNG IEND chunk must be empty");
      seenEnd = true;
      break;
    }
  }
  if (!seenEnd || offset !== bytes.length) {
    throw new CredentialImportError("png-trailing-or-missing-end", "PNG has trailing data or no IEND chunk");
  }
  if (embedded === null) throw new CredentialImportError("png-credential-missing", "PNG has no Open Badges credential iTXt");
  return embedded;
}

function extractSvgCredential(bytes: Uint8Array): string {
  const svg = decodeUtf8(bytes, "svg-utf8-invalid");
  if (/<!DOCTYPE|<!ENTITY/iu.test(svg)) {
    throw new CredentialImportError("svg-xml-entity-prohibited", "SVG DTD and entity declarations are prohibited");
  }
  if (/<!--|<\s*(?:script|style|foreignObject)\b/iu.test(svg)) {
    throw new CredentialImportError("svg-active-content-prohibited", "SVG comments and active content are prohibited");
  }
  const root = /^(?:\ufeff?\s*<\?xml\s[^>]*\?>)?\s*<svg\b([^>]*)>/iu.exec(svg);
  if (!root) throw new CredentialImportError("svg-root-invalid", "SVG root element is missing");
  if (!/<\/svg\s*>\s*$/iu.test(svg) || (svg.match(/<svg\b/giu) ?? []).length !== 1) {
    throw new CredentialImportError("svg-root-invalid", "SVG must contain exactly one complete root element");
  }
  const rootAttributes = root[1] ?? "";
  if (!/\bxmlns:openbadges\s*=\s*(["'])https:\/\/purl\.imsglobal\.org\/ob\/v3p0\1/iu.test(rootAttributes)) {
    throw new CredentialImportError("svg-openbadges-namespace-invalid", "SVG Open Badges namespace is missing or invalid");
  }
  const openings = svg.match(/<openbadges:credential\b/giu) ?? [];
  const closings = svg.match(/<\/openbadges:credential\s*>/giu) ?? [];
  const match = /<openbadges:credential\b([^>]*)>([\s\S]*?)<\/openbadges:credential\s*>/iu.exec(svg);
  if (openings.length !== 1 || closings.length !== 1 || !match) {
    throw new CredentialImportError("svg-credential-cardinality-invalid", "SVG must contain exactly one credential element");
  }
  const attributes = match[1] ?? "";
  const body = (match[2] ?? "").trim();
  const verifyMatch = /\bverify\s*=\s*(["'])([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\1/iu.exec(attributes);
  const remainingAttributes = attributes.replace(
    /\bverify\s*=\s*(["'])[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\1/giu,
    ""
  );
  if (remainingAttributes.trim().length > 0) {
    throw new CredentialImportError("svg-credential-attribute-invalid", "SVG credential element has unsupported attributes");
  }
  if (verifyMatch) {
    if (body.length > 0) throw new CredentialImportError("svg-credential-ambiguous", "SVG credential has both verify and body data");
    return verifyMatch[2]!;
  }
  if (!body.startsWith("<![CDATA[") || !body.endsWith("]]>") || body.slice(9, -3).includes("]]>") ) {
    throw new CredentialImportError("svg-credential-cdata-required", "SVG embedded credential must use one CDATA section");
  }
  return body.slice(9, -3).trim();
}

function inferEnvelopeFormat(serialized: string, maxJsonDepth: number): CredentialEnvelopeFormat {
  const trimmed = serialized.trim();
  if (/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(trimmed)) return "compact-jws";
  if (!trimmed.startsWith("{")) {
    throw new CredentialImportError("embedded-credential-format-invalid", "Embedded credential is neither JSON nor Compact JWS");
  }
  const parsed = parseJsonObjectStrict(trimmed, maxJsonDepth);
  return Object.prototype.hasOwnProperty.call(parsed, "@context") ? "json-ld" : "json";
}

function assertPositiveLimit(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new CredentialImportError("credential-limit-invalid", `${name} must be a positive safe integer`);
  }
}

export function extractCredentialEnvelope(
  source: CredentialImportSource,
  limits: CredentialEnvelopeLimits
): ExtractedCredentialEnvelope {
  assertPositiveLimit(limits.maxInputBytes, "maxInputBytes");
  assertPositiveLimit(limits.maxEmbeddedCredentialBytes, "maxEmbeddedCredentialBytes");
  assertPositiveLimit(limits.maxJsonDepth, "maxJsonDepth");
  const originalBytes =
    typeof source.content === "string"
      ? Uint8Array.from(Buffer.from(source.content, "utf8"))
      : Uint8Array.from(source.content);
  if (originalBytes.byteLength > limits.maxInputBytes) {
    throw new CredentialImportError(
      "credential-input-too-large",
      `Credential input exceeds ${limits.maxInputBytes} bytes`
    );
  }
  if (originalBytes.byteLength === 0) throw new CredentialImportError("credential-input-empty", "Credential input is empty");

  let sourceFormat = source.format;
  if (sourceFormat === undefined) {
    sourceFormat = startsWithBytes(originalBytes, PNG_SIGNATURE)
      ? "baked-png"
      : credentialFormatFromText(decodeUtf8(originalBytes, "credential-utf8-invalid"));
  }

  let serializedCredential: string;
  if (sourceFormat === "baked-png") {
    serializedCredential = extractPngCredential(originalBytes);
  } else if (sourceFormat === "baked-svg") {
    serializedCredential = extractSvgCredential(originalBytes);
  } else {
    if (startsWithBytes(originalBytes, PNG_SIGNATURE)) {
      throw new CredentialImportError("credential-format-mismatch", "Credential format hint does not match PNG input");
    }
    serializedCredential = decodeUtf8(originalBytes, "credential-utf8-invalid").trim();
  }

  const embeddedByteLength = Buffer.byteLength(serializedCredential, "utf8");
  if (embeddedByteLength > limits.maxEmbeddedCredentialBytes) {
    throw new CredentialImportError(
      "embedded-credential-too-large",
      `Embedded credential exceeds ${limits.maxEmbeddedCredentialBytes} bytes`
    );
  }
  const envelopeFormat = inferEnvelopeFormat(serializedCredential, limits.maxJsonDepth);
  if (sourceFormat === "compact-jws" && envelopeFormat !== "compact-jws") {
    throw new CredentialImportError("credential-format-mismatch", "Credential format hint does not match Compact JWS input");
  }
  if ((sourceFormat === "json" || sourceFormat === "json-ld") && envelopeFormat === "compact-jws") {
    throw new CredentialImportError("credential-format-mismatch", "Credential format hint does not match JSON input");
  }
  return {
    originalBytes,
    sourceFormat,
    mediaType: normalizeMediaType(source.mediaType, sourceFormat),
    envelopeFormat,
    serializedCredential: serializedCredential.trim()
  };
}
