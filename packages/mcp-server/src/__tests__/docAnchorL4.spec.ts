import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { candidateToSurface } from "../features/task-pack/readCodeTaskPack.js";
import { planDocSliver } from "../features/task-pack/docSliver.js";
import { handleTable } from "../util/handles.js";

const dirs: string[] = [];

function workspace(tag: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `tl-l4-doc-anchor-${tag}-`));
  dirs.push(dir);
  return dir;
}

function write(dir: string, rel: string, body: string): void {
  const file = path.join(dir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, "utf8");
}

function linesIn(range: string): number {
  const [start, end] = range.split("-").map(Number);
  return end! - start! + 1;
}

afterEach(() => {
  handleTable.reset();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("W14 L4 Markdown anchor windows", () => {
  it("widens a short matching section to at least a ±20-line context window", async () => {
    const ws = workspace("window");
    const doc: string[] = ["# Contract", ""];
    for (let i = doc.length; i < 70; i++) doc.push(`Intro rule ${i} ${"x".repeat(100)}`);
    doc.push("## Motor ordering", "FR/BL/FL/BR are the required order.", "## Tail");
    for (let i = doc.length; i < 220; i++) doc.push(`Tail rule ${i} ${"y".repeat(100)}`);
    write(ws, "CONTRACT.md", doc.join("\n") + "\n");

    const surface = await candidateToSurface(
      {
        path: "CONTRACT.md",
        line: 70,
        range: "70-70",
        surface: "doc",
        why: "doc-contract-match",
        confidence: 1,
      } as never,
      ws,
      ["doc"],
      "motor ordering",
    );

    expect(linesIn(surface.range)).toBeGreaterThanOrEqual(21);
    expect(surface.code).toContain("FR/BL/FL/BR");
    expect(surface.remaining_ranges?.length).toBeGreaterThan(0);
  });

  it("inlines a small file complement when the whole Markdown surface fits", async () => {
    const ws = workspace("inline");
    const doc: string[] = ["# Contract", ""];
    for (let i = doc.length; i < 69; i++) doc.push(`Preamble ${i} ${"p".repeat(105)}`);
    doc.push("## Motor ordering", "FR/BL/FL/BR are the required order.", "## Tail");
    for (let i = doc.length; i < 80; i++) doc.push(`Tail ${i} ${"t".repeat(105)}`);
    write(ws, "CONTRACT.md", doc.join("\n") + "\n");

    const surface = await candidateToSurface(
      {
        path: "CONTRACT.md",
        line: 70,
        range: "70-70",
        surface: "doc",
        why: "doc-contract-match",
        confidence: 1,
      } as never,
      ws,
      ["doc"],
      "motor ordering",
    );

    expect(surface.range).toBe("1-80");
    expect(surface.remaining_ranges).toBeUndefined();
    expect(surface.code).toContain("FR/BL/FL/BR");
  });

  it("keeps the doc-sliver next call at the same minimum focus", () => {
    const ws = workspace("sliver");
    const doc: string[] = ["# Contract", ""];
    for (let i = doc.length; i < 199; i++) doc.push(`Background ${i}`);
    doc.push("## Motor ordering", "FR/BL/FL/BR are the required order.", "## Tail");
    for (let i = doc.length; i < 260; i++) doc.push(`Tail ${i}`);
    const content = doc.join("\n") + "\n";
    write(ws, "CONTRACT.md", content);

    const plan = planDocSliver(
      {
        role: "doc",
        path: "CONTRACT.md",
        handle: "hcontract",
        range: "260-260",
        code: "Tail 260",
        remaining_ranges: ["1-259"],
      },
      content,
      "motor ordering",
    );

    expect(plan).toBeDefined();
    expect(linesIn(String(plan!.nextCall.arguments.range))).toBeGreaterThanOrEqual(21);
  });

  it("keeps a common query token from pulling the anchor to a distant section", async () => {
    const ws = workspace("locality");
    const doc: string[] = ["# Contract", "", "## Contract overview"];
    for (let i = doc.length; i < 190; i++) {
      doc.push(`This contract background rule ${i} ${"c".repeat(100)}`);
    }
    doc.push("## Motor ordering", "FR/BL/FL/BR are the required order.", "## Tail");
    for (let i = doc.length; i < 240; i++) doc.push(`Tail rule ${i} ${"t".repeat(100)}`);
    write(ws, "CONTRACT.md", doc.join("\n") + "\n");

    const surface = await candidateToSurface(
      {
        path: "CONTRACT.md",
        line: 191,
        range: "191-191",
        surface: "doc",
        why: "doc-contract-match",
        confidence: 1,
      } as never,
      ws,
      ["doc"],
      "contract",
    );

    const [start, end] = surface.range.split("-").map(Number);
    expect(start).toBeGreaterThan(100);
    expect(end! - start! + 1).toBeLessThanOrEqual(150);
    expect(surface.code).toContain("FR/BL/FL/BR");
  });
});