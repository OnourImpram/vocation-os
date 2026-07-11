import { StringDecoder } from "node:string_decoder";

export async function readMaskedSecret(prompt: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY || typeof process.stdin.setRawMode !== "function") {
    throw new Error("Secret input requires an interactive terminal");
  }
  process.stdout.write(prompt);
  const stdin = process.stdin;
  const previousRaw = stdin.isRaw;
  stdin.setRawMode(true);
  stdin.resume();
  return new Promise((resolve, reject) => {
    let value = "";
    const decoder = new StringDecoder("utf8");
    const cleanup = (): void => {
      stdin.off("data", onData);
      stdin.setRawMode(previousRaw);
      process.stdout.write("\n");
    };
    const onData = (chunk: Buffer): void => {
      for (const character of decoder.write(chunk)) {
        if (character === "\u0003") {
          cleanup();
          reject(new Error("Secret input cancelled"));
          return;
        }
        if (character === "\r" || character === "\n") {
          cleanup();
          resolve(value);
          return;
        }
        if (character === "\b" || character === "\u007f") {
          value = [...value].slice(0, -1).join("");
          continue;
        }
        const codePoint = character.codePointAt(0) ?? 0;
        if (codePoint >= 32 && codePoint !== 127) value += character;
      }
    };
    stdin.on("data", onData);
  });
}
