import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const reads = vi.hoisted(() => ({ count: 0 }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readFileSync: (...args: Parameters<typeof actual.readFileSync>) => {
      reads.count += 1;
      return actual.readFileSync(...args);
    },
  };
});

const fs = await import("node:fs");
const { readFileForRequest } = await import("../util/requestFileCache.js");
const { runWithRequestSignal } = await import("../util/requestCancellation.js");

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "tl-request-file-cache-"));
  file = path.join(dir, "a.ts");
  fs.writeFileSync(file, "export const a = 1;\n");
  reads.count = 0;
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const inRequest = <T>(fn: () => T): T => runWithRequestSignal(new AbortController().signal, fn);

describe("readFileForRequest", () => {
  it("reads through on every call outside a request", () => {
    readFileForRequest(file);
    readFileForRequest(file);
    expect(reads.count).toBe(2);
  });

  it("reads an unchanged file once per request, and again in the next request", () => {
    inRequest(() => {
      expect(readFileForRequest(file).toString()).toBe("export const a = 1;\n");
      expect(readFileForRequest(file).toString()).toBe("export const a = 1;\n");
    });
    expect(reads.count).toBe(1);
    inRequest(() => readFileForRequest(file));
    expect(reads.count).toBe(2);
  });

  it("reads a file again when a write in the same request changed it, same size included", () => {
    inRequest(() => {
      readFileForRequest(file);
      fs.writeFileSync(file, "export const a = 22;\n");
      expect(readFileForRequest(file).toString()).toBe("export const a = 22;\n");
      // Two same-size writes inside one clock tick leave the identity alike, the limit the module states.
      const before = fs.statSync(file, { bigint: true }).mtimeNs;
      do fs.writeFileSync(file, "export const b = 22;\n");
      while (fs.statSync(file, { bigint: true }).mtimeNs === before);
      expect(readFileForRequest(file).toString()).toBe("export const b = 22;\n");
      expect(readFileForRequest(file).toString()).toBe("export const b = 22;\n");
    });
    expect(reads.count).toBe(3);
  });

  it("hands each caller its own copy", () => {
    inRequest(() => {
      const first = readFileForRequest(file);
      first.fill(0);
      expect(readFileForRequest(file).toString()).toBe("export const a = 1;\n");
      const second = readFileForRequest(file);
      second.fill(0);
      expect(readFileForRequest(file).toString()).toBe("export const a = 1;\n");
    });
  });

  it("fails as readFileSync does for a missing file or a directory", () => {
    inRequest(() => {
      expect(() => readFileForRequest(path.join(dir, "missing.ts"))).toThrow(expect.objectContaining({ code: "ENOENT" }));
      expect(() => readFileForRequest(dir)).toThrow(expect.objectContaining({ code: "EISDIR" }));
    });
  });

  it("does not share bytes between two requests running at the same time", async () => {
    const other = path.join(dir, "b.ts");
    fs.writeFileSync(other, "b\n");
    await Promise.all([
      runWithRequestSignal(new AbortController().signal, async () => {
        readFileForRequest(file);
        await new Promise((resolve) => setTimeout(resolve, 5));
        readFileForRequest(file);
      }),
      runWithRequestSignal(new AbortController().signal, async () => {
        readFileForRequest(file);
        await new Promise((resolve) => setTimeout(resolve, 5));
        readFileForRequest(other);
      }),
    ]);
    expect(reads.count).toBe(3);
  });
});
