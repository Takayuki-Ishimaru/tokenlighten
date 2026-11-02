import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The recorder boundary for the v0.16.4 baseline fix: a ranged or symbol read
 * must not be credited with the whole file, and its event must say so
 * (`baselineMethod: "range-bytes"`). Drives the real `callTool` in-process and
 * reads the NDJSON the recorder wrote. The log is parsed directly rather than
 * through `readUsageEvents` so this spec does not depend on a rebuilt
 * `@tokenlighten/usage` dist.
 */

const originalArgv = [...process.argv];
const originalNodeEnv = process.env["NODE_ENV"];
const originalLogHome = process.env["TOKENLIGHTEN_LOG_HOME"];
const originalHome = process.env["HOME"];
const originalUserProfile = process.env["USERPROFILE"];

afterEach(() => {
  process.argv.splice(0, process.argv.length, ...originalArgv);
  const restore = (name: string, value: string | undefined): void => {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  };
  restore("NODE_ENV", originalNodeEnv);
  restore("TOKENLIGHTEN_LOG_HOME", originalLogHome);
  restore("HOME", originalHome);
  restore("USERPROFILE", originalUserProfile);
  vi.resetModules();
});

interface RecordedEvent {
  outcome: string;
  responseBytes: number;
  estimatedResponseTokens: number;
  baselineTokens: number | null;
  estimatedSavedTokens: number | null;
  baselineMethod: string | null;
}

const LINES = 1500;
const fillerLine = (index: number): string =>
  `// filler ${String(index).padStart(4, "0")} ................................................\n`;

/** A ~100 KB TypeScript file with one function whose body is a small window. */
function bigSource(): { content: string; totalBytes: number; lineBytes: (a: number, b: number) => number } {
  const lines: string[] = [];
  for (let index = 1; index <= 700; index++) lines.push(fillerLine(index));
  lines.push(
    "export function targetFunction(input: number): number {\n",
    "  const doubled = input * 2;\n",
    "  return doubled + 1;\n",
    "}\n",
  );
  for (let index = 705; index <= LINES; index++) lines.push(fillerLine(index));
  const content = lines.join("");
  return {
    content,
    totalBytes: Buffer.byteLength(content),
    lineBytes: (a, b) => Buffer.byteLength(lines.slice(a - 1, b).join("")),
  };
}

async function harness(): Promise<{
  root: string;
  callTool: (name: string, args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;
  events: () => RecordedEvent[];
}> {
  const root = join(tmpdir(), `tokenlighten-baseline-${randomUUID()}`);
  const logs = join(root, "logs");
  const home = join(root, "home");
  mkdirSync(logs, { recursive: true });
  mkdirSync(home, { recursive: true });
  process.argv.push("--workspace", root);
  process.env["NODE_ENV"] = "development";
  process.env["TOKENLIGHTEN_LOG_HOME"] = logs;
  process.env["HOME"] = home;
  process.env["USERPROFILE"] = home;
  vi.resetModules();
  const server = await import("../server.js");
  return {
    root,
    callTool: server.callTool as never,
    events: () =>
      readdirSync(logs)
        .filter((name) => /^usage-.*\.ndjson$/.test(name))
        .flatMap((name) => readFileSync(join(logs, name), "utf8").split("\n"))
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line) as RecordedEvent),
  };
}

describe("usage recorder baseline for ranged reads", () => {
  it("credits a whole-file read the file size, and a repeat of it nothing", async () => {
    const { root, callTool, events } = await harness();
    const source = bigSource();
    writeFileSync(join(root, "big.ts"), source.content);

    await callTool("tl_read_file", { mode: "full", path: "big.ts", cwd: root });
    await callTool("tl_read_file", { mode: "full", path: "big.ts", cwd: root });

    const [first, second] = events();
    expect(first!.baselineMethod).toBe("file-bytes");
    expect(first!.baselineTokens).toBe(Math.ceil(source.totalBytes / 4));
    expect(second!.baselineMethod).toBe("file-bytes");
    expect(second!.baselineTokens).toBe(0);
  });

  it("credits a ranged read only the requested lines, labelled range-bytes", async () => {
    const { root, callTool, events } = await harness();
    const source = bigSource();
    writeFileSync(join(root, "big.ts"), source.content);

    const result = await callTool("tl_read_file", {
      cwd: root,
      targets: [{ path: "big.ts", range: "10-29" }],
    });
    expect(JSON.parse(result.content[0]!.text)).not.toMatchObject({ kind: "refusal" });

    const [event] = events();
    expect(event!.outcome).toBe("ok");
    expect(event!.baselineMethod).toBe("range-bytes");
    expect(event!.baselineTokens).toBe(Math.ceil(source.lineBytes(10, 29) / 4));
    // The old behaviour credited the whole ~100 KB file here.
    expect(event!.baselineTokens!).toBeLessThan(source.totalBytes / 4 / 20);
    // Net saving is about zero: never the tens of thousands of tokens a whole-file baseline claimed.
    expect(Math.abs(event!.estimatedSavedTokens!)).toBeLessThan(source.totalBytes / 4 / 10);
  });

  it("credits a multi-target batch each target's own range, not each file", async () => {
    const { root, callTool, events } = await harness();
    const source = bigSource();
    writeFileSync(join(root, "big.ts"), source.content);
    writeFileSync(join(root, "other.ts"), source.content);

    await callTool("tl_read_file", {
      cwd: root,
      targets: [
        { path: "big.ts", range: "1-10" },
        { path: "other.ts", range: "20-30" },
      ],
    });

    const [event] = events();
    expect(event!.baselineMethod).toBe("range-bytes");
    expect(event!.baselineTokens).toBe(
      Math.ceil((source.lineBytes(1, 10) + source.lineBytes(20, 30)) / 4),
    );
  });

  it("credits a symbol read the served symbol window, not the file", async () => {
    const { root, callTool, events } = await harness();
    const source = bigSource();
    writeFileSync(join(root, "big.ts"), source.content);

    const result = await callTool("tl_read_file", {
      cwd: root,
      targets: [{ path: "big.ts", symbol: "targetFunction" }],
    });
    const payload = JSON.parse(result.content[0]!.text) as Record<string, unknown>;
    expect(payload["kind"]).not.toBe("refusal");

    const [event] = events();
    expect(event!.outcome).toBe("ok");
    expect(event!.baselineMethod).toBe("range-bytes");
    expect(event!.baselineTokens!).toBeLessThan(source.totalBytes / 4 / 20);
    // The served symbol window is lines 701-704 of the file.
    expect(event!.baselineTokens).toBe(Math.ceil(source.lineBytes(701, 704) / 4));
  });

  it("records no baseline for a query-only task_pack", async () => {
    const { root, callTool, events } = await harness();
    writeFileSync(join(root, "big.ts"), bigSource().content);

    await callTool("tl_read_file", {
      cwd: root,
      mode: "task_pack",
      query: "Where is targetFunction defined and what does it return?",
    });

    const [event] = events();
    expect(event!.baselineTokens).toBeNull();
    expect(event!.baselineMethod).toBeNull();
  });
});
