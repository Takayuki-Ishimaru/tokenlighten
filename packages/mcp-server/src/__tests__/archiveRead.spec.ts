import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { gzipSync } from "node:zlib";
import { callTool } from "../server.js";
import { handleTable } from "../util/handles.js";
import { resetAll as resetAllSessions } from "../util/session.js";
import {
  resetPackDedupeCache,
  resetRoleInventoryCache,
} from "../tools/readCodeTaskPack.js";
import {
  resetRootResolverCache,
  setActiveRootWorkspace,
} from "../tools/locateTaskContext.js";

const EVIDENCE = [
  "export const ZIP_BOMB_MAX_UNCOMPRESSED_BYTES = 104857600;",
  "export const OFFICE_FORMATS = ['docx', 'xlsx', 'pptx'];",
  "",
].join("\n");

const SEVEN_ZIP_BASE64 =
  "N3q8ryccAANBxn2IPAAAAAAAAABCAAAAAAAAAIPbi2MgICAgICAgICAgICAgICAgICAgICAgICAgIGZpbGUgMSBjb250ZW50cwpoZWxsbwpoZWxsbwpoZWxsbwoBBAYAAQk8AAcLAQABAQAMPAAICgGqHd4PAAAFARENAGYAaQBsAGUAMQAAABQKAQCA1kAAqLKdARUGAQAgAAAAAAA=";
const RAR_BASE64 =
  "UmFyIRoHAM+QcwAADQAAAAAAAACEUnQgkDIAFAAAABQAAAADQqLIvrd22j4UMAgApIEAAHRlc3QudHh0gAi3dto+t3baPnRlc3QgdGV4dCBkb2N1bWVudA0KnS90IJAyAAgAAAAIAAAAA3tEybbRTNg+FDAIAP+hAAB0ZXN0bGlua8AI0UzYPlBf2j50ZXN0LnR4dM3gdCCQOgAUAAAAFAAAAANCosi+Y3faPhQwEACkgQAAdGVzdGRpclx0ZXN0LnR4dMDMY3faPmN32j50ZXN0IHRleHQgZG9jdW1lbnQNCqHIdOCQMQAAAAAAAAAAAAMAAAAAY3faPhQwBwDtQQAAdGVzdGRpcsDMY3faPmR32j7m53TgkDYAAAAAAAAAAAADAAAAAJ2r1T4UMAwA7UEAAHRlc3RlbXB0eWRpcoDMnavVPsVd2j7EPXsAQAcA";
const ENCRYPTED_ZIP_BASE64 =
  "UEsDBBQACQAIAMo0EEVH/dikHQAAAO8BAAAHABwAYmFyLnR4dFVUCQADzH3uU9J97lN1eAsAAQT1AQAABBQAAACld2smnTEmC09x+bqahRXm+dDTscRjvYrb4NIfr1BLBwhH/dikHQAAAO8BAABQSwMEFAAJAAgA2DQQRevHk7QdAAAA7wEAAAcAHABmb28udHh0VVQJAAPofe5T6H3uU3V4CwABBPUBAAAEFAAAADvBwm4NuqnahQR3IuYt+0XuZd8/kBdUdfMECWs8UEsHCOvHk7QdAAAA7wEAAFBLAQIeAxQACQAIAMo0EEVH/dikHQAAAO8BAAAHABgAAAAAAAEAAACkgQAAAABiYXIudHh0VVQFAAPMfe5TdXgLAAEE9QEAAAQUAAAAUEsBAh4DFAAJAAgA2DQQRevHk7QdAAAA7wEAAAcAGAAAAAAAAQAAAKSBbgAAAGZvby50eHRVVAUAA+h97lN1eAsAAQT1AQAABBQAAABQSwUGAAAAAAIAAgCaAAAA3AAAAAAA";

type TestZip = {
  file(name: string, data: string): void;
  generateAsync(options: {
    type: "nodebuffer";
    compression: "DEFLATE";
  }): Promise<Buffer>;
};

let workspace = "";

function tarWithMember(member: string, content: string): Buffer {
  const data = Buffer.from(content, "utf8");
  const header = Buffer.alloc(512);
  header.write(member, 0, Math.min(100, Buffer.byteLength(member)), "utf8");
  header.write("0000644\0", 100, 8, "ascii");
  header.write("0000000\0", 108, 8, "ascii");
  header.write("0000000\0", 116, 8, "ascii");
  header.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124, 12, "ascii");
  header.write("00000000000\0", 136, 12, "ascii");
  header.fill(0x20, 148, 156);
  header.write("0", 156, 1, "ascii");
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  const padding = Buffer.alloc((512 - (data.length % 512)) % 512);
  return Buffer.concat([header, data, padding, Buffer.alloc(1024)]);
}

async function invoke(
  tool: "read_file" | "search_files" | "edit_file",
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await callTool(tool, args);
  const first = response.content[0];
  const text = first?.type === "text" ? first.text : "{}";
  return JSON.parse(text) as Record<string, unknown>;
}

beforeAll(async () => {
  const repoRoot = path.resolve(__dirname, "../../../..");
  workspace = fs.realpathSync(
    fs.mkdtempSync(path.join(repoRoot, ".tl-archive-read-")),
  );
  fs.writeFileSync(
    path.join(workspace, ".tokenlightenignore"),
    "ignored.txt\n",
    "utf8",
  );

  const JSZipModule = (await import("jszip")) as unknown as {
    default: new () => TestZip;
  };
  const zip = new JSZipModule.default();
  zip.file("src/policy.ts", EVIDENCE);
  zip.file("notes.txt", "unrelated release note\n");
  zip.file("ignored.txt", "must not be surfaced\n");
  fs.writeFileSync(
    path.join(workspace, "sample.zip"),
    await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }),
  );

  const bomb = new JSZipModule.default();
  bomb.file("bomb.txt", "A".repeat(2_000_000));
  fs.writeFileSync(
    path.join(workspace, "bomb.zip"),
    await bomb.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }),
  );

  const tar = tarWithMember("src/policy.ts", EVIDENCE);
  fs.writeFileSync(path.join(workspace, "sample.tar"), tar);
  fs.writeFileSync(path.join(workspace, "sample.tar.gz"), gzipSync(tar));
  fs.writeFileSync(
    path.join(workspace, "sample.7z"),
    Buffer.from(SEVEN_ZIP_BASE64, "base64"),
  );
  fs.writeFileSync(
    path.join(workspace, "sample.rar"),
    Buffer.from(RAR_BASE64, "base64"),
  );
  fs.writeFileSync(
    path.join(workspace, "encrypted.zip"),
    Buffer.from(ENCRYPTED_ZIP_BASE64, "base64"),
  );
  fs.writeFileSync(
    path.join(workspace, "unsafe.tar"),
    tarWithMember("../escape.ts", "unsafe\n"),
  );
}, 60_000);

afterAll(() => {
  if (workspace) fs.rmSync(workspace, { recursive: true, force: true });
});

beforeEach(() => {
  handleTable.reset();
  resetAllSessions();
  resetPackDedupeCache();
  resetRoleInventoryCache();
  resetRootResolverCache();
  setActiveRootWorkspace(workspace);
});

describe("read-only archive containers", () => {
  it.each([
    ["sample.zip", "zip", "src/policy.ts", "ZIP_BOMB_MAX"],
    ["sample.tar", "tar", "src/policy.ts", "ZIP_BOMB_MAX"],
    ["sample.tar.gz", "tar.gz", "src/policy.ts", "ZIP_BOMB_MAX"],
    ["sample.7z", "7z", "file1", "file 1 contents"],
    ["sample.rar", "rar", "test.txt", "test text document"],
  ])(
    "lists and reads a real %s archive",
    async (archivePath, format, member, expectedText) => {
      const manifest = await invoke("read_file", {
        cwd: workspace,
        mode: "archive",
        archive: { path: archivePath },
      });
      // A.5.5 + Rule K (A.9.2 row 7, C2-3): the container tag is now
      // `content.form`, and `mode` is gone — `kind` is the sole discriminator
      // (D4). The archive payload nests under `content`.
      expect(manifest).toMatchObject({
        kind: "read.artifact",
        path: archivePath,
        content: { form: "archive", format, read_only: true },
      });
      expect(manifest).not.toHaveProperty("mode");
      const content = manifest["content"] as Record<string, unknown>;
      const entries = content["entries"] as Array<Record<string, unknown>>;
      expect(entries.length).toBeGreaterThan(0);
      expect(entries.some((entry) => entry["member"] === "ignored.txt")).toBe(false);

      const read = await invoke("read_file", {
        cwd: workspace,
        mode: "auto",
        archive: { path: archivePath, member },
      });
      // A.5.2: a member BODY serve is `read.text`; its addressing and bytes ride
      // `evidence[0]` (§3.3's triple), and `archive` stays as the provenance
      // that marks the handle virtual.
      const served = (read["evidence"] as Array<Record<string, unknown>>)[0]!;
      expect(served["path"]).toBe(`${archivePath}!/${member}`);
      expect(served["body"]).toContain(expectedText);
      expect(read["archive"]).toMatchObject({
        path: archivePath,
        member,
        format,
        read_only: true,
      });
    },
    30_000,
  );

  it("closes a ZIP task in one exact read_file call shape", async () => {
    const result = await invoke("read_file", {
      cwd: workspace,
      mode: "task_pack",
      taskProfile: "answer",
      query:
        "ZIP_BOMB_MAX_UNCOMPRESSED_BYTES と OFFICE_FORMATS を根拠付きで説明してください",
      archive: { path: "sample.zip" },
    });
    // A.5.1 (C2-3): an archive pack IS a task pack, so it now carries the
    // member's required set — `task`, `profile`, `evidence` — instead of
    // `mode` + `coverage` + `surfaces[]`. `coverage` moved onto `task`.
    expect(result["kind"]).toBe("read.task_pack");
    expect(result).not.toHaveProperty("mode");
    expect((result["task"] as Record<string, unknown>)["coverage"]).toBe("complete");
    expect(result["profile"]).toBe("answer");
    const surfaces = result["evidence"] as Array<Record<string, unknown>>;
    expect(surfaces).toHaveLength(1);
    expect(surfaces[0]?.["path"]).toBe("sample.zip!/src/policy.ts");
    expect(surfaces[0]?.["body"]).toContain(
      "ZIP_BOMB_MAX_UNCOMPRESSED_BYTES",
    );
    // §2.2: `execution_contract` dissolved into `decision` + `plan`; an archive
    // pack carries a typestate-less contract, so it projects no decision at all
    // rather than a fabricated one. What must hold is that the container is
    // gone from the wire, not that a phase re-encoding survived.
    expect(result).not.toHaveProperty("execution_contract");
    // P0a §6.1: archive packs are built outside the code task-pack pipeline
    // (own route union, no typestate), so the canonical oracle cannot read
    // them. They obey the same one-decision rule through their own compact
    // oracle instead of an unchecked exemption.
    // protocol v1 §3.4 E4 row 1: `route` is deleted from the WIRE, so the
    // compact archive oracle — which reads `pack.route` — can no longer be
    // driven from a wire body. It still runs in-process on the pack the
    // archive builder produces (`tools/archive.ts`), which is where the
    // one-decision rule is enforced; what this spec can still assert, and now
    // does, is that the deleted re-encoding really is gone from the response.
    expect(result).not.toHaveProperty("route");
    expect(result).not.toHaveProperty("required_action");
    // S2b closes C2-3's recorded handoff ("it emits no `decision` yet"). §4.3
    // requires the field on every `read.task_pack`, so the archive family
    // projects its own — from the SAME `prepared` boolean `route` and
    // `execution_contract` were projected from (`archiveTaskDecision`).
    //
    // This pack is prepared: the required member window is served and complete.
    // The mainline pack's verdict for that exact state — evidence served, no
    // certificate, no grounded next call — is `grantServedTerminal`, whose
    // A.7.2 code is `act-on-served-evidence`. An `act.answer` here would need a
    // `CertificateRef` this wire-only path never issues, which is the
    // fabrication C2-3 refused to ship; this says the true thing instead.
    expect(result["decision"]).toEqual({
      kind: "await_input",
      code: "act-on-served-evidence",
    });
  }, 30_000);

  it("an archive pack that closes nothing decides `discover`, with an executable next", async () => {
    // The other arm of the same projection. No member of sample.zip carries
    // this query, so `surfaces` is empty, the contract is `discovery`, and the
    // route asks the caller to narrow with `archive.prefix`/`member` — which it
    // cannot do without knowing what members exist. §2.1's `discover` is
    // unrepresentable without a `next`, and F5 requires that call to be
    // executable NOW: the manifest read is, with arguments this pack holds.
    const result = await invoke("read_file", {
      cwd: workspace,
      mode: "task_pack",
      taskProfile: "answer",
      query: "TOKEN_THAT_APPEARS_IN_NO_ARCHIVE_MEMBER",
      archive: { path: "sample.zip" },
    });
    expect(result["kind"]).toBe("read.task_pack");
    expect(result["decision"]).toEqual({
      kind: "discover",
      next: {
        tool: "read_file",
        arguments: { mode: "archive", archive: { path: "sample.zip" } },
      },
    });
  }, 30_000);

  it("searches and inventories inside ZIP without native extraction", async () => {
    const found = await invoke("search_files", {
      cwd: workspace,
      action: "find",
      query: "OFFICE_FORMATS",
      archive: { path: "sample.zip" },
    });
    // A.5.8 / Rule K (C2-4): a find's fields live under `matches:{form:"find"}`.
    const foundMatches = found["matches"] as Record<string, unknown>;
    expect(found["kind"]).toBe("search.matches");
    expect(foundMatches["form"]).toBe("find");
    expect(foundMatches["total_files"]).toBe(1);
    expect(
      (foundMatches["files"] as Array<Record<string, unknown>>)[0]?.["path"],
    ).toBe("sample.zip!/src/policy.ts");
    // The archive-scoped find's provenance, mirrored onto A.5.10's `archive`
    // shape (C2-4's disclosed accommodation — A.5.8 has no archive home).
    const archiveScope = foundMatches["archive"] as Record<string, unknown>;
    expect(archiveScope?.["format"]).toBe("zip");
    expect(typeof archiveScope?.["scanned_entries"]).toBe("number");
    expect(found["archive_scope"]).toBeUndefined();

    const absent = await invoke("search_files", {
      cwd: workspace,
      action: "find",
      query: "TOKEN_THAT_IS_NOT_PRESENT",
      archive: { path: "sample.zip" },
    });
    expect((absent["matches"] as Record<string, unknown>)["absence"]).toBeDefined();

    const tree = await invoke("search_files", {
      cwd: workspace,
      action: "tree",
      archive: { path: "sample.zip" },
    });
    // A.5.10 (C2-4): `mode:"tree"` is deleted (D4) and the archive-scoped
    // variant nests total_entries/format/warnings under `archive`.
    expect(tree["kind"]).toBe("search.tree");
    expect(tree["mode"]).toBeUndefined();
    expect(String(tree["tree"])).toContain("src/policy.ts");
    expect((tree["archive"] as Record<string, unknown>)?.["format"]).toBe("zip");
  }, 30_000);

  it("refuses every archive edit even when the member path is explicit", async () => {
    const result = await invoke("edit_file", {
      cwd: workspace,
      path: "sample.zip!/src/policy.ts",
      search: "ZIP_BOMB_MAX_UNCOMPRESSED_BYTES",
      replace: "UNSAFE_EDIT",
    });
    expect(result).toMatchObject({
      kind: "refusal",
      code: "archive-member-read-only",
    });
    const reread = await invoke("read_file", {
      cwd: workspace,
      archive: { path: "sample.zip", member: "src/policy.ts" },
    });
    expect((reread["evidence"] as Array<Record<string, unknown>>)[0]!["body"])
      .toContain("ZIP_BOMB_MAX_UNCOMPRESSED_BYTES");
  });

  it("rejects encrypted, path-traversing, and over-ratio archives", async () => {
    // A.5.15 (S2b): all three are REFUSALS, and the assertion says so.
    //
    // They used to ship as `read.artifact` — `mode=archive` declared that member
    // before `buildArchiveManifest` was asked whether it had a manifest at all,
    // and `kindForCall` honours a declaration over every derivation including
    // the refusal test. The bodies then carried a `code` (which is why this test
    // passed) inside a member whose required set they satisfied none of: no
    // `handle`, no `sha`, no `content`, no `warnings`, and a bare-string `next`
    // where §2.6 requires an executable `ToolCall`. The failure branch no longer
    // declares a kind, so each one leaves through `buildRefusal`.
    //
    // `retry:"call"` on all three is `retryOf`'s default and the value every
    // other archive refusal on this wire already carries (`archive-not-found`,
    // `archive-member-read-only` below): §2.6's `call` is "fix the named
    // argument and re-issue", and for these three the argument is real —
    // `credentialRef` for the encrypted ZIP, `archive.path` for a container this
    // server will not expand. It is deliberately NOT `none`: that value means
    // "no transition on this CALL SHAPE is sanctioned", and the call shape is
    // fine here — the target is not.
    for (const [archivePath, code, isCredential] of [
      ["encrypted.zip", "archive-encrypted", true],
      ["unsafe.tar", "archive-unsafe-path", false],
      ["bomb.zip", "archive-bomb", false],
    ] as const) {
      const raw = await callTool("read_file", {
        cwd: workspace,
        mode: "archive",
        archive: { path: archivePath },
      });
      // A.8 E-3: a refusal sets the transport flag.
      expect(raw.isError, archivePath).toBe(true);
      const body = JSON.parse(raw.content[0]!.text) as Record<string, unknown>;
      expect(body, archivePath).toMatchObject({
        kind: "refusal",
        for: "read_file",
        code,
        retry: "call",
      });
      expect(body["field"], archivePath).toBe(isCredential ? "credentialRef" : "archive.path");
      // A.5.5's keys are absent because this is not that member — the point of
      // the fix is that it no longer CLAIMS to be. No derived follow-up is
      // emitted here because no explicit producer guidance was supplied.
      expect(body, archivePath).not.toHaveProperty("content");
      expect(body["next"], archivePath).toBeUndefined();
      expect(body["next_call"], archivePath).toBeUndefined();
    }
  }, 30_000);

  it("reads a password-protected ZIP through credentialRef and rejects a wrong password", async () => {
    process.env["TOKENLIGHTEN_PASSWORD_ARCHIVE_OK"] = "12345678";
    process.env["TOKENLIGHTEN_PASSWORD_ARCHIVE_WRONG"] = "wrong-password";
    try {
      const manifest = await invoke("read_file", {
        cwd: workspace,
        mode: "archive",
        credentialRef: "archive-ok",
        archive: { path: "encrypted.zip" },
      });
      expect(manifest).toMatchObject({
        kind: "read.artifact",
        content: { form: "archive", format: "zip", read_only: true },
      });

      const read = await invoke("read_file", {
        cwd: workspace,
        mode: "auto",
        credentialRef: "archive-ok",
        archive: { path: "encrypted.zip", member: "foo.txt" },
      });
      const decrypted = (read["evidence"] as Array<Record<string, unknown>>)[0]!;
      expect(decrypted, JSON.stringify(read)).toMatchObject({ body: expect.any(String) });
      expect(String(decrypted["body"]).length).toBeGreaterThan(0);
      expect(JSON.stringify(read)).not.toContain("12345678");

      const wrong = await invoke("read_file", {
        cwd: workspace,
        mode: "auto",
        credentialRef: "archive-wrong",
        archive: { path: "encrypted.zip", member: "foo.txt" },
      });
      expect(wrong["code"]).toBe("archive-password-invalid");
      expect(wrong["field"]).toBe("credentialRef");
      expect(wrong["next"]).toBeUndefined();
      expect(wrong["next_call"]).toBeUndefined();
      expect(JSON.stringify(wrong)).not.toContain("wrong-password");
    } finally {
      delete process.env["TOKENLIGHTEN_PASSWORD_ARCHIVE_OK"];
      delete process.env["TOKENLIGHTEN_PASSWORD_ARCHIVE_WRONG"];
    }
  }, 30_000);
});
