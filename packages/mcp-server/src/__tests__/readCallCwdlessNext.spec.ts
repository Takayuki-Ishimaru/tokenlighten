import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { pooledSpawn } from "./helpers/serverPool.js";
import { TSX_NODE_ARGS } from "./helpers/tsxNode.js";
import { killServerGroup } from "./helpers/killServerGroup.js";
import { readCallExecutionKey, resolveReadCallContinuation } from "../state/readCallContinuationStore.js";
import { resolveReadCallCursorAlias } from "../state/readCallCursorAliases.js";
import { resetStateStoresForTests, stateStoreFor } from "../state/stateStore.js";
import { TWO_PAGE_DESK_QUERY, writeTwoPageDesk } from "./helpers/twoPageDesk.js";
import { OWED_ROWS_DESK_FILE, OWED_ROWS_DESK_QUERY, writeOwedRowsDesk } from "./helpers/owedRowsDesk.js";

// A compact short-alias next under the server's configured root carries no cwd:
// ingress resolves an omitted cwd to that root, so the long path only invited a
// mistyped copy (and an invalid-cwd round trip). Every test here runs the calls
// the server wrote, as written, through a spawned stdio server. "Twin" tests run
// one scenario on two identical cells, once sending the emitted calls verbatim
// and once with the old cwd added by the client, and require identical replies.
//
// 2026-10-23 (codex-copilot-proxy r18 T03): the vehicles are synthetic types under the Copilot
// CLI client. A map owes the members its first page does not hold as rows when those fit ONE
// continuation page, and the first reply is then a discover with ONE cursor-alias next whose
// continuation is the act.answer (helpers/owedRowsDesk.ts: the single-next tests). When they
// need two pages the published BATCH (two sibling cursors) is the shape (helpers/twoPageDesk.ts:
// the sibling tests). T03 itself owes its members whole under this client, in the batch of two
// sibling cursors it always published (t03OwedRows.spec.ts, copilotCompactWorkflow.spec.ts).
type Body = Record<string, any>;
type Form = "cwdless" | "cwd";
const roots: string[] = [];
const stops: Array<() => void> = [];
const bin = fileURLToPath(new URL("../bin.ts", import.meta.url));
const copilot = { TOKENLIGHTEN_CLIENT_ID: "copilot-cli" };
const query = OWED_ROWS_DESK_QUERY;
const orchestrator = OWED_ROWS_DESK_FILE;
const task = { epoch: "new", profile: "answer" };

/** A fresh two-page desk (helpers/twoPageDesk.ts) under HOME: the vehicle of the published batch. */
function deskCell(): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.homedir(), ".tl-cwdless-")));
  roots.push(root);
  writeTwoPageDesk(root);
  return root;
}

/** A fresh rows-fit desk (helpers/owedRowsDesk.ts) under HOME (the janitor removes it), as the other spawned-server specs build theirs: the vehicle of the single next. */
function cell(): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.homedir(), ".tl-cwdless-")));
  roots.push(root);
  writeOwedRowsDesk(root, 16);
  return root;
}

interface Session { call(name: string, args: Body): Promise<Body>; stop(): void }
/** A server pinned at `root`. `call` sends its arguments exactly as given: no cwd is added. */
async function start(root: string, overrides: Record<string, string> = {}): Promise<Session> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !key.startsWith("TL_") && !key.startsWith("TOKENLIGHTEN_")));
  const child = pooledSpawn(process.execPath, [...TSX_NODE_ARGS, bin, root, "--allow-write"], {
    cwd: root, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"], env: { ...env, ...overrides },
  });
  const stop = () => killServerGroup(child);
  stops.push(stop);
  let buffer = "", stderr = "", sequence = 0;
  const waiters = new Map<number, (body: Body) => void>();
  child.stdout!.on("data", (data: Buffer) => {
    buffer += data.toString();
    for (;;) {
      const end = buffer.indexOf("\n");
      if (end < 0) break;
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      let message: Body;
      try { message = JSON.parse(line); } catch { continue; }
      const done = waiters.get(message["id"]);
      if (done) { waiters.delete(message["id"]); done(message); }
    }
  });
  child.stderr!.on("data", (data: Buffer) => { stderr += data.toString(); });
  const rpc = (method: string, params: Body): Promise<Body> => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { waiters.delete(id); reject(new Error(method + " timed out\n" + stderr)); }, 30000);
    waiters.set(id, body => { clearTimeout(timer); resolve(body); });
    child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "vitest", version: "0" } });
  child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  return { stop, call: async (name, args) => JSON.parse((await rpc("tools/call", { name, arguments: args }))["result"].content[0].text) };
}

/** A reply with what each cell mints set aside: its path, task ids, cursors, replay refs, certificates and handles. */
const norm = (value: unknown, root: string): string => JSON.stringify(value)
  .split(root).join("$WS")
  .replace(/tlc_s1_[A-Za-z0-9_-]{12}_[A-Za-z0-9_-]{22}/g, "tlc_*")
  .replace(/tlh_[A-Za-z0-9_-]+/g, "tlh_*")
  .replace(/q-[0-9a-f]{16}/g, "q-*")
  .replace(/ready-[0-9a-f]{16}(?:-[0-9a-f]{16})?/g, "ready-*")
  .replace(/"h[0-9a-z]{10}"/g, '"h*"')
  // …and the handle a `prior` row names in its prose ("hkyczhk1ex9 — already served this session …").
  .replace(/\bh[0-9a-z]{10}\b(?= — | only if)/g, "h*");

interface Vehicle { cell: () => string; query: string }
const single: Vehicle = { cell: () => cell(), query };
const desk: Vehicle = { cell: () => deskCell(), query: TWO_PAGE_DESK_QUERY };
interface Run {
  form: Form; root: string; query: string;
  call(name: string, args: Body): Promise<Body>;
  /** An emitted call's arguments as this form's client sends them: verbatim, or with the old cwd added. */
  send(args: Body): Body;
  /** A real process restart on the same cell; `between` runs while no server is up. */
  restart(between?: () => void): Promise<void>;
}
/** Runs `scenario` on two identical cells; the cwd-less side sends the server's calls as written. */
async function twin(overrides: Record<string, string>, scenario: (run: Run) => Promise<Body[]>, vehicle: Vehicle = single) {
  const run = async (form: Form) => {
    const root = vehicle.cell();
    let session = await start(root, overrides);
    const steps = await scenario({
      form, root, query: vehicle.query, call: (name, args) => session.call(name, args),
      send: args => form === "cwdless" ? args : { cwd: root, ...args },
      restart: async between => { session.stop(); between?.(); session = await start(root, overrides); },
    });
    return norm(steps, root);
  };
  const [cwdless, withCwd] = await Promise.all([run("cwdless"), run("cwd")]);
  return { cwdless, withCwd };
}
const sameAsCwdForm = async (overrides: Record<string, string>, scenario: (run: Run) => Promise<Body[]>, vehicle: Vehicle = single) => {
  const { cwdless, withCwd } = await twin(overrides, scenario, vehicle);
  expect(cwdless).toBe(withCwd);
};
const first = (run: Run, extra: Body = {}) => run.call("tl_read_file", { cwd: run.root, query: run.query, task, ...extra });

/**
 * The once-only execution marker of a server-issued cursor, read from the cell's
 * durable store: "pending" until some call claims the plan. (Any call in a lane,
 * refused or not, also ends the immediate-use lease, so a later use recovers the
 * plan's exact windows rather than rebuilding the semantic pack; the claim is
 * what a refusal must leave alone.)
 */
function planOf(root: string, lane: string, cursor: string) {
  resetStateStoresForTests(); // the server process wrote since this observer last opened the store
  const alias = resolveReadCallCursorAlias({ workspaceRoot: root, lane, cursor });
  const plan = resolveReadCallContinuation({ workspaceRoot: root, lane, cursor: alias.kind === "canonical" ? alias.cursor : cursor });
  if (plan.kind !== "read-call") throw new Error("missing read-call plan: " + JSON.stringify(plan).slice(0, 200));
  return {
    status: stateStoreFor(root)!.get(readCallExecutionKey(plan.state))?.data["status"],
    windows: (plan.input["targets"] as Body[]).flatMap(target => target["ranges"] ?? [target["range"]]).sort(),
  };
}
const claimStatus = (root: string, lane: string, cursor: string) => planOf(root, lane, cursor).status;
/** The line windows a reply served, whichever representation (pack evidence or batch entries) carried them. */
const served = (reply: Body): string[] => [...(reply["evidence"] ?? []), ...(reply["entries"] ?? [])].map((row: Body) => row["range"]).sort();

afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("a compact next under the configured root carries no cwd and runs as written", () => {
  it.each(["", "agent-a"])("single next, lane %j: the cursor alone (plus lane), served the same as the cwd form", async lane => {
    const lanePart = lane ? { lane } : {};
    const { cwdless, withCwd } = await twin(copilot, async run => {
      const opened = await first(run, lanePart);
      expect(opened.decision.kind).toBe("discover");
      const next = opened.decision.next;
      expect(next.tool).toBe("tl_read_file");
      expect(Object.keys(next.arguments).sort(), JSON.stringify(next)).toEqual(["cursor", ...(lane ? ["lane"] : [])].sort());
      expect(next.arguments.cursor).toMatch(/^tlc_s1_/);
      const served = await run.call(next.tool, run.send(next.arguments));
      expect(served.kind, JSON.stringify(served).slice(0, 300)).toBe("read.task_pack");
      expect(served.decision.kind).toBe("act.answer");
      return [opened, served];
    });
    expect(cwdless).toBe(withCwd);
  }, 120000);

  describe("read-only answer batch (next[] siblings, the sibling-reuse path)", () => {
    it.each([false, true])("runs both siblings without cwd in issue order or reversed (reverse=%s)", async reverse => {
      await sameAsCwdForm(copilot, async run => {
        const opened = await first(run);
        const published: Body[] = opened.decision.next;
        expect(published).toHaveLength(2);
        for (const next of published) expect(Object.keys(next.arguments), JSON.stringify(next)).toEqual(["cursor"]);
        const order = reverse ? [...published].reverse() : published;
        const middle = await run.call(order[0]!.tool, run.send(order[0]!.arguments));
        expect(middle.decision?.kind, JSON.stringify(middle).slice(0, 300)).toBe("discover");
        // The intermediate result restates the other pending sibling, itself cwd-less.
        expect(middle.decision.next).toEqual(order[1]);
        expect(Object.keys(middle.decision.next.arguments)).toEqual(["cursor"]);
        const last = await run.call(order[1]!.tool, run.send(order[1]!.arguments));
        expect(last.decision?.kind).toBe("act.answer");
        return [opened, middle, last];
      }, desk);
    }, 120000);

    it("runs the siblings in parallel, each without cwd", async () => {
      await sameAsCwdForm(copilot, async run => {
        const opened = await first(run);
        const calls: Body[] = opened.decision.next;
        for (const next of calls) expect(Object.keys(next.arguments), JSON.stringify(next)).toEqual(["cursor"]);
        const replies = await Promise.all(calls.map(next => run.call(next.tool, run.send(next.arguments))));
        for (const reply of replies) expect(reply.kind, JSON.stringify(reply).slice(0, 300)).not.toBe("refusal");
        expect(replies.map(reply => reply.decision?.kind).sort()).toEqual(["act.answer", "discover"]);
        return [opened, ...replies];
      }, desk);
    }, 120000);
  });

  describe("a mistyped cwd is still refused, and the refusal consumes nothing", () => {
    it.each([
      ["a batch sibling", {}, desk],
      ["a single next", { budget: { bytes: 40000 } }, single],
    ] as Array<[string, Body, Vehicle]>)("invalid-cwd on %s leaves its once-only claim for the correct, cwd-less call", async (_name, extra, vehicle) => {
      const root = vehicle.cell(), session = await start(root, copilot);
      const opened = await session.call("tl_read_file", { cwd: root, query: vehicle.query, task, ...extra });
      const next = Array.isArray(opened.decision.next) ? opened.decision.next[0] : opened.decision.next;
      expect(Object.keys(next.arguments)).toEqual(["cursor"]);
      expect(claimStatus(root, "", next.arguments.cursor)).toBe("pending");
      const wrong = path.join(path.dirname(root), "extra-" + path.basename(root));
      const refused = await session.call(next.tool, { ...next.arguments, cwd: wrong });
      expect(refused.kind, JSON.stringify(refused).slice(0, 300)).toBe("refusal");
      expect(refused.code).toBe("invalid-cwd");
      expect(refused.field).toBe("cwd");
      expect(claimStatus(root, "", next.arguments.cursor), "the refusal claimed nothing").toBe("pending");
      const planned = planOf(root, "", next.arguments.cursor).windows;
      const recovered = await session.call(next.tool, next.arguments);
      expect(recovered.kind, JSON.stringify(recovered).slice(0, 300)).not.toBe("refusal");
      expect(claimStatus(root, "", next.arguments.cursor)).toBe("claimed");
      // Served as the plan's first use: its own windows (all that fit one reply), with bodies. The typo cost its own round trip only.
      expect(served(recovered).length).toBeGreaterThan(0);
      expect(served(recovered).every(window => planned.includes(window)), `${served(recovered)} within ${planned}`).toBe(true);
    }, 120000);
  });
});

// 2026-10-23 (independent review of T03 A/B, F1): where no cursor can be issued -- the state store off --
// the pack's own `next` ships, the request restated with every owed window listed, and under the configured
// root it carries no cwd either, like every read next (readCallContinuation.ts omitConfiguredRootCwdOnNext): the call a size preview counts (taskPackSizePreview.ts).
// It runs as written, and as the same call with the old cwd added.
describe("where no cursor can be issued the restated next carries no cwd and runs as written", () => {
  it("state store off: the restated next, as written or with the cwd added, serves the same continuation", async () => {
    const { cwdless, withCwd } = await twin({ ...copilot, TOKENLIGHTEN_STATE_STORE: "off" }, async run => {
      const replies: Body[] = [await first(run)];
      for (let hop = 0; hop < 4 && replies.at(-1)!.decision?.kind === "discover"; hop++) {
        const next = replies.at(-1)!.decision.next;
        expect(Array.isArray(next), "one restated call, no sibling cursors").toBe(false);
        expect(next.tool).toBe("tl_read_file");
        expect(Object.keys(next.arguments), JSON.stringify(next).slice(0, 300)).toEqual(expect.arrayContaining(["query", "targets"]));
        expect(next.arguments).not.toHaveProperty("cwd");
        expect(next.arguments).not.toHaveProperty("cursor");
        replies.push(await run.call(next.tool, run.send(next.arguments)));
      }
      expect(replies.length, "a discover, then the call it restates").toBeGreaterThan(1);
      expect(replies.at(-1)!.kind, JSON.stringify(replies.at(-1)).slice(0, 300)).toBe("read.task_pack");
      expect(replies.at(-1)!.decision.kind).toBe("act.answer");
      return replies;
    });
    expect(cwdless).toBe(withCwd);
  }, 180000);

  it("a state store that works keeps the cursor call, as before", async () => {
    const root = cell(), session = await start(root, copilot);
    const opened = await session.call("tl_read_file", { cwd: root, query, task });
    expect(Object.keys(opened.decision.next.arguments)).toEqual(["cursor"]);
  }, 120000);
});

describe("a next outside the configured root keeps its cwd", () => {
  const exercise = async (overrides: Record<string, string>, workspace: string, root: string, label: string) => {
    const session = await start(root, { ...copilot, ...overrides });
    const opened = await session.call("tl_read_file", { cwd: workspace, query, task });
    const next = opened.decision.next;
    expect(next.arguments.cwd, `${label}: ${JSON.stringify(next)}`).toBe(workspace);
    expect(Object.keys(next.arguments).sort()).toEqual(["cursor", "cwd"]);
    const served = await session.call(next.tool, next.arguments);
    expect(served.kind, JSON.stringify(served).slice(0, 300)).toBe("read.task_pack");
    expect(served.decision.kind).toBe("act.answer");
    return session;
  };

  it("a subtree of the root", async () => {
    const root = cell();
    await exercise({}, path.join(root, "src"), root, "subtree");
  }, 120000);

  it("VS Code turn economy keeps the subtree cwd on the first next and serves it from that subtree", async () => {
    const root = cell(), workspace = path.join(root, "src");
    const session = await start(root, {TOKENLIGHTEN_CLIENT: "vscode", TOKENLIGHTEN_CLIENT_ID: "vscode", TL_TURN_ECONOMY: "1"});
    const opened = await session.call("tl_read_file", {cwd: workspace, query, task});
    let reply = opened;
    for (let hop = 0; hop < 8 && reply.decision?.kind === "discover"; hop += 1) {
      const next = reply.decision.next;
      expect(next.arguments.cwd, JSON.stringify(next)).toBe(workspace);
      reply = await session.call(next.tool, next.arguments);
      expect(reply.kind, JSON.stringify(reply).slice(0, 300)).toBe("read.task_pack");
    }
    expect(reply.decision.kind, JSON.stringify(reply).slice(0, 300)).toBe("act.answer");
  }, 120000);

  it("a child of an --allowed-parent, while the root itself still omits cwd", async () => {
    const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.homedir(), ".tl-cwdless-parent-")));
    roots.push(parent);
    const root = cell(), child = path.join(parent, "worktree-b");
    fs.cpSync(root, child, { recursive: true });
    const session = await exercise({ TOKENLIGHTEN_ALLOWED_PARENTS: parent }, child, root, "allowed parent");
    const atRoot = await session.call("tl_read_file", { cwd: root, query: query + "\n(configured root)", task });
    expect(Object.keys(atRoot.decision.next.arguments), JSON.stringify(atRoot.decision.next)).toEqual(["cursor"]);
  }, 120000);

  it("a worktree registered by the root's repository", async () => {
    const root = cell();
    const git = (...args: string[]) => execFileSync("git", ["-C", root, "-c", "user.email=t@t", "-c", "user.name=t", ...args], { stdio: "pipe" });
    git("init", "-q"); git("add", "-A"); git("commit", "-q", "-m", "fixture");
    const target = fs.mkdtempSync(path.join(os.tmpdir(), "tl-cwdless-wt-"));
    fs.rmSync(target, { recursive: true, force: true });
    git("worktree", "add", "-q", "-b", `tl-cwdless-${Date.now()}`, target);
    roots.push(target);
    await exercise({}, fs.realpathSync(target), root, "registered worktree");
  }, 120000);
});

describe("the cwd-less call behaves exactly as the cwd form", () => {
  it("lane mismatch: another lane or none is refused, and the claim survives for the right call", async () => {
    await sameAsCwdForm(copilot, async run => {
      const opened = await first(run, { lane: "agent-a" });
      const next = opened.decision.next;
      const { lane: _lane, ...unlaned } = next.arguments;
      const none = await run.call(next.tool, run.send(unlaned));
      const other = await run.call(next.tool, run.send({ ...next.arguments, lane: "agent-b" }));
      for (const refused of [none, other]) {
        expect(refused.kind).toBe("refusal");
        expect(refused.code).toBe("cursor-invalid");
      }
      const served = await run.call(next.tool, run.send(next.arguments));
      expect(served.decision?.kind).toBe("act.answer");
      return [opened, none, other, served];
    });
  }, 120000);

  it("CAS: a wrong expected_state_version is a state-conflict that consumes nothing", async () => {
    await sameAsCwdForm(copilot, async run => {
      const opened = await first(run);
      const next = opened.decision.next;
      const conflict = await run.call(next.tool, run.send({ ...next.arguments, task: { expected_state_version: 0 } }));
      expect(conflict.code, JSON.stringify(conflict).slice(0, 300)).toBe("state-conflict");
      expect(claimStatus(run.root, "", next.arguments.cursor), "the conflict claimed nothing").toBe("pending");
      const recovered = await run.call(next.tool, run.send(next.arguments));
      expect(recovered.kind, JSON.stringify(recovered).slice(0, 300)).not.toBe("refusal");
      expect(claimStatus(run.root, "", next.arguments.cursor)).toBe("claimed");
      return [opened, conflict, recovered];
    });
  }, 120000);

  it("a changed source is cursor-stale, before anything is claimed", async () => {
    await sameAsCwdForm(copilot, async run => {
      const opened = await first(run);
      const next = opened.decision.next;
      fs.appendFileSync(path.join(run.root, orchestrator), "\n// changed after the first reply\n");
      const stale = await run.call(next.tool, run.send(next.arguments));
      expect(stale.code, JSON.stringify(stale).slice(0, 300)).toBe("cursor-stale");
      expect(stale.decision).toBeUndefined();
      expect(claimStatus(run.root, "", next.arguments.cursor), "a stale plan is refused unclaimed").toBe("pending");
      return [opened, stale];
    });
  }, 120000);

  it("replay of a claimed cursor, and task.force_serve, recover the same fixed windows", async () => {
    await sameAsCwdForm(copilot, async run => {
      const opened = await first(run);
      const next = opened.decision.next;
      const served = await run.call(next.tool, run.send(next.arguments));
      const replay = await run.call(next.tool, run.send(next.arguments));
      const forced = await run.call(next.tool, run.send({ ...next.arguments, task: { force_serve: true } }));
      expect(served.decision?.kind).toBe("act.answer");
      for (const reply of [replay, forced]) expect(reply.decision, JSON.stringify(reply).slice(0, 300)).toBeUndefined();
      return [opened, served, replay, forced];
    });
  }, 120000);

  it("a restarted server recovers only the fixed windows", async () => {
    await sameAsCwdForm(copilot, async run => {
      const opened = await first(run);
      const next = opened.decision.next;
      await run.restart();
      const recovered = await run.call(next.tool, run.send(next.arguments));
      expect(recovered.kind, JSON.stringify(recovered).slice(0, 300)).not.toBe("refusal");
      expect(recovered.decision).toBeUndefined();
      return [opened, recovered];
    });
  }, 120000);

  it("a changed state-store epoch makes the alias unusable, in both forms", async () => {
    await sameAsCwdForm(copilot, async run => {
      const opened = await first(run);
      const next = opened.decision.next;
      const meta = path.join(run.root, ".tokenlighten", "state", "meta.json");
      await run.restart(() => {
        const stored = JSON.parse(fs.readFileSync(meta, "utf8"));
        fs.writeFileSync(meta, JSON.stringify({ ...stored, epoch: stored.epoch === "deadbeef" ? "feedface" : "deadbeef" }));
      });
      const refused = await run.call(next.tool, run.send(next.arguments));
      expect(refused.kind, JSON.stringify(refused).slice(0, 300)).toBe("refusal");
      expect(refused.code).toBe("cursor-invalid");
      return [opened, refused];
    });
  }, 120000);

  it("an alias from another root is refused under this one, with or without cwd", async () => {
    const [rootA, rootB] = [cell(), cell()];
    const [a, b] = await Promise.all([start(rootA, copilot), start(rootB, copilot)]);
    const opened = await a.call("tl_read_file", { cwd: rootA, query, task });
    const cursor = opened.decision.next.arguments.cursor;
    const bare = await b.call("tl_read_file", { cursor });
    const typed = await b.call("tl_read_file", { cwd: rootB, cursor });
    expect(bare.kind).toBe("refusal");
    expect(bare.code).toBe("cursor-invalid");
    expect(norm(bare, rootB)).toBe(norm(typed, rootB));
    // The alias is still good under its own root.
    expect((await a.call("tl_read_file", { cursor })).decision?.kind).toBe("act.answer");
  }, 120000);
});
