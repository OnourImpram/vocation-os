#!/usr/bin/env node
import { VocationClient, type VocationTransport } from "@vocation-os/sdk";
import { VocationSdkBackend } from "./backend.js";
import {
  VocationCliReadTransport,
  loadVocationTransportModule
} from "./cli-transport.js";
import { McpToolExecutor, SIDE_EFFECT_TOOLS } from "./index.js";
import { McpProtocolServer } from "./server.js";
import {
  DEFAULT_MAX_REQUEST_BYTES,
  HARD_MAX_REQUEST_BYTES,
  runMcpStdio
} from "./stdio.js";

interface CliOptions {
  capabilities: string[];
  cliPath?: string;
  enableSideEffects: boolean;
  help: boolean;
  maxRequestBytes: number;
  transportModule?: string;
}

const CAPABILITY_PATTERN = /^[a-z][a-z0-9.-]{0,127}$/u;
const KNOWN_CAPABILITIES = new Set(
  SIDE_EFFECT_TOOLS.flatMap((tool) => tool.security.requiredCapability ? [tool.security.requiredCapability] : [])
);

function valueAfter(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function integerFlag(value: string, flag: string): number {
  if (!/^\d+$/u.test(value)) throw new Error(`${flag} requires an integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${flag} is outside the safe integer range`);
  return parsed;
}

function parseCliOptions(argv: readonly string[]): CliOptions {
  const options: CliOptions = {
    capabilities: [],
    enableSideEffects: false,
    help: false,
    maxRequestBytes: DEFAULT_MAX_REQUEST_BYTES
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      options.help = true;
    } else if (argument === "--enable-side-effects") {
      options.enableSideEffects = true;
    } else if (argument === "--capability") {
      options.capabilities.push(valueAfter(argv, index, argument));
      index += 1;
    } else if (argument?.startsWith("--capability=")) {
      options.capabilities.push(argument.slice("--capability=".length));
    } else if (argument === "--sdk-transport-module") {
      options.transportModule = valueAfter(argv, index, argument);
      index += 1;
    } else if (argument?.startsWith("--sdk-transport-module=")) {
      options.transportModule = argument.slice("--sdk-transport-module=".length);
    } else if (argument === "--vocation-cli") {
      options.cliPath = valueAfter(argv, index, argument);
      index += 1;
    } else if (argument?.startsWith("--vocation-cli=")) {
      options.cliPath = argument.slice("--vocation-cli=".length);
    } else if (argument === "--max-request-bytes") {
      options.maxRequestBytes = integerFlag(valueAfter(argv, index, argument), argument);
      index += 1;
    } else if (argument?.startsWith("--max-request-bytes=")) {
      options.maxRequestBytes = integerFlag(
        argument.slice("--max-request-bytes=".length),
        "--max-request-bytes"
      );
    } else {
      throw new Error(`Unknown option: ${argument ?? ""}`);
    }
  }

  options.capabilities = [...new Set(options.capabilities)];
  for (const capability of options.capabilities) {
    if (!CAPABILITY_PATTERN.test(capability) || !KNOWN_CAPABILITIES.has(capability)) {
      throw new Error(`Unsupported MCP capability: ${capability}`);
    }
  }
  if (
    options.maxRequestBytes < 1_024
    || options.maxRequestBytes > HARD_MAX_REQUEST_BYTES
  ) {
    throw new Error("--max-request-bytes must be between 1024 and 1048576");
  }
  if (options.cliPath && options.transportModule) {
    throw new Error("--vocation-cli and --sdk-transport-module are mutually exclusive");
  }
  if (!options.enableSideEffects && options.capabilities.length > 0) {
    throw new Error("--capability requires --enable-side-effects");
  }
  if (options.enableSideEffects && options.capabilities.length === 0) {
    throw new Error("--enable-side-effects requires at least one --capability");
  }
  if (options.enableSideEffects && !options.transportModule) {
    throw new Error("Side effects require an explicit --sdk-transport-module");
  }
  return options;
}

function helpText(): string {
  return [
    "VocationOS MCP stdio server",
    "",
    "Usage: vocation-mcp [options]",
    "",
    "  --vocation-cli <path>          Read-only VocationOS CLI path",
    "  --sdk-transport-module <path>  Module exporting createVocationTransport()",
    "  --max-request-bytes <bytes>    Request limit, 1024 to 1048576",
    "  --enable-side-effects          Expose side-effect tools",
    "  --capability <scope>           Grant one declared side-effect capability",
    "  --help                         Show this message on stderr"
  ].join("\n");
}

async function transportFor(options: CliOptions): Promise<VocationTransport> {
  if (options.transportModule) return loadVocationTransportModule(options.transportModule);
  return new VocationCliReadTransport({ ...(options.cliPath ? { cliPath: options.cliPath } : {}) });
}

export async function runVocationMcp(
  argv: readonly string[] = process.argv.slice(2)
): Promise<void> {
  const options = parseCliOptions(argv);
  if (options.help) {
    process.stderr.write(`${helpText()}\n`);
    return;
  }
  const diagnostic = (message: string): void => {
    process.stderr.write(`[vocation-mcp] ${message}\n`);
  };
  const transport = await transportFor(options);
  const backend = new VocationSdkBackend(new VocationClient(transport));
  const executor = new McpToolExecutor({
    backend,
    enableSideEffects: options.enableSideEffects
  });
  const server = new McpProtocolServer({
    executor,
    capabilities: options.capabilities,
    diagnostic
  });
  diagnostic(options.enableSideEffects
    ? `started with ${options.capabilities.length} mutation capability grant(s)`
    : "started in read-only mode");
  await runMcpStdio(server, { maxRequestBytes: options.maxRequestBytes });
}

try {
  await runVocationMcp();
} catch (error) {
  process.stderr.write(`[vocation-mcp] ${error instanceof Error ? error.message : "fatal startup failure"}\n`);
  process.exitCode = 1;
}
