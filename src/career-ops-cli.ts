import {
  getShippedCareerExecutionAdapter,
  listShippedCareerExecutionAdapters
} from "./career-ops/execution-adapter.js";
import { runCareerOpsAlphaDemo } from "./career-ops/demo.js";

export type CareerOpsCliWriter = (value: string) => void;

function writeJson(write: CareerOpsCliWriter, value: unknown): void {
  write(`${JSON.stringify(value, null, 2)}\n`);
}

function parseDemoTime(args: readonly string[]): Date {
  if (args.length === 0) return new Date();
  if (args.length !== 2 || args[0] !== "--at" || !args[1]) {
    throw new Error("career operations demo accepts only --at <ISO-date-time>");
  }
  const parsed = new Date(args[1]);
  if (!Number.isFinite(parsed.getTime())) {
    throw new Error("career operations demo --at value must be a valid date-time");
  }
  return parsed;
}

export async function runCareerOpsCli(
  args: readonly string[],
  write: CareerOpsCliWriter = (value) => process.stdout.write(value)
): Promise<number> {
  const command = args[0] ?? "help";

  try {
    switch (command) {
    case "help":
      write([
        "VocationOS career operations alpha commands:",
        "  adapters                 List shipped career execution adapters",
        "  demo [--at <ISO-time>]   Run the synthetic verified execution journey"
      ].join("\n") + "\n");
      return 0;
    case "adapters": {
      if (args.length !== 1) throw new Error("career operations adapters accepts no additional arguments");
      const adapters = listShippedCareerExecutionAdapters().map((adapterId) => {
        const adapter = getShippedCareerExecutionAdapter(adapterId);
        if (!adapter) throw new Error(`shipped career execution adapter is unavailable: ${adapterId}`);
        return adapter.manifest();
      });
      writeJson(write, { adapters });
      return 0;
    }
    case "demo": {
      const now = parseDemoTime(args.slice(1));
      writeJson(write, await runCareerOpsAlphaDemo(now));
      return 0;
    }
    default:
      write(`Unknown career operations command: ${command}\n`);
      return 2;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    write(`Career operations command failed: ${message}\n`);
    return 2;
  }
}
