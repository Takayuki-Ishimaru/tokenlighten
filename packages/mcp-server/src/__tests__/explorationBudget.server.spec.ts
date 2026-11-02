/**
 * explorationBudget.server.spec.ts — 2026-10-29 first-hop field report, replayed
 * against the REAL spawned stdio server.
 *
 * express's "How does res.redirect work?", followed `next` verbatim for ten
 * hops, returned 129 KB by paging the 3,928-line History.md to its end and
 * never served res.redirect. The fixture is the same shape: lib/response.js
 * (`res.redirect = function redirect(url) {...}`), a README, and a 3,000-line
 * History.md that mentions redirect on a third of its lines.
 *
 * The bound must hold whether or not the first pack already serves res.redirect
 * (that is the anchor-closure producer's job, a separate change): at most six
 * follow-up calls, at most 40 KiB of responses, and History.md never appears
 * with a body. A request that NAMES History.md must still be able to read it.
 */
import { afterAll, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { shortTmpDir } from "./helpers/shortTmpDir.js";
import { rmDirWithRetry } from "./helpers/rmDirWithRetry.js";
import {
  finalDecisionKind,
  followNextToEnd,
  startDevServer,
  type Hop,
  type ServerHandle,
} from "./helpers/qualityFirstScenarios.js";
import {
  TASK_EXPLORATION_MAX_BYTES,
  TASK_EXPLORATION_MAX_HOPS,
} from "../util/continuation.js";

const HOME = process.env["HOME"] ?? process.env["USERPROFILE"] ?? os.homedir();
const QUERY = "How does res.redirect work?";
const HISTORY_LINES = 3000;

const RESPONSE_JS = `'use strict'

var encodeUrl = require('encodeurl')
var escapeHtml = require('escape-html')
var statuses = require('statuses')

var res = Object.create(http.ServerResponse.prototype)

module.exports = res

/**
 * Set status \`code\`.
 */
res.status = function status(code) {
  this.statusCode = code
  return this
}

/**
 * Send a response.
 */
res.send = function send(body) {
  var chunk = body
  this.end(chunk, 'utf8')
  return this
}

/**
 * Set the location header to \`url\`.
 */
res.location = function location(url) {
  return this.set('Location', encodeUrl(url))
}

/**
 * Redirect to the given \`url\` with optional response \`status\`
 * defaulting to 302.
 *
 * The resulting \`url\` is determined by \`res.location()\`, so
 * it will play nicely with mounted apps, relative paths,
 * \`"back"\` etc.
 */
res.redirect = function redirect(url) {
  var address = url
  var body
  var status = 302

  if (arguments.length === 2) {
    status = arguments[0]
    address = arguments[1]
  }

  // Set location header
  address = this.location(address).get('Location')

  // Support text/{plain,html} by default
  this.format({
    text: function () {
      body = statuses.message[status] + '. Redirecting to ' + address
    },
    html: function () {
      var u = escapeHtml(address)
      body = '<p>' + statuses.message[status] + '. Redirecting to <a href="' + u + '">' + u + '</a></p>'
    },
    default: function () {
      body = ''
    }
  })

  // Respond
  this.statusCode = status
  this.set('Content-Length', Buffer.byteLength(body))

  if (this.req.method === 'HEAD') {
    this.end()
  } else {
    this.end(body)
  }
}
`;

function historyFile(): string {
  const lines: string[] = ["5.0.0 / unreleased", "=================="];
  for (let i = 0; lines.length < HISTORY_LINES; i += 1) {
    if (i % 12 === 0) {
      lines.push("", `4.${Math.floor(i / 12)}.0 / 2020-01-01`, "==================", "");
    }
    lines.push(i % 3 === 0
      ? `  * Fix \`res.redirect()\` to handle redirect status ${300 + (i % 8)} for item ${i}`
      : `  * Update dependency note ${i} for the router and the request object`);
  }
  return `${lines.slice(0, HISTORY_LINES).join("\n")}\n`;
}

function longReadmeFile(): string {
  const lines = ["# mini-express", ""];
  for (let i = 0; lines.length < 1600; i += 1) {
    lines.push(`## Installation step ${i}`, "", `Run installer stage ${i}, then verify the installation of component ${i} before continuing.`, "");
  }
  return `${lines.join("\n")}\n`;
}

function buildWorkspace(withDefinition = true, longReadme = false): string {
  const ws = fs.realpathSync(shortTmpDir(HOME, ".tl-explbudget-"));
  const write = (rel: string, content: string): void => {
    const abs = path.join(ws, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, "utf8");
  };
  write("package.json", JSON.stringify({ name: "mini-express", version: "5.0.0", main: "index.js" }, null, 2) + "\n");
  write("index.js", "module.exports = require('./lib/application')\n");
  if (withDefinition) write("lib/response.js", RESPONSE_JS);
  write("lib/application.js", "var app = exports = module.exports = {}\napp.handle = function handle(req, res) {\n  res.status(200).send('ok')\n}\n");
  write("lib/request.js", "var req = Object.create(http.IncomingMessage.prototype)\nmodule.exports = req\nreq.get = function get(name) {\n  return this.headers[name.toLowerCase()]\n}\n");
  write("README.md", "# mini-express\n\nA tiny web framework.\n\n## Usage\n\n```js\napp.get('/', (req, res) => res.redirect('/home'))\n```\n\nSee History.md for release notes.\n");
  write("History.md", historyFile());
  if (longReadme) write("README.md", longReadmeFile());
  return ws;
}

const servers: ServerHandle[] = [];
const dirs: string[] = [];
afterAll(async () => {
  for (const server of servers.splice(0)) await server.kill();
  for (const dir of dirs.splice(0)) {
    try {
      await rmDirWithRetry(dir);
    } catch {
      /* best-effort */
    }
  }
});

async function start(withDefinition = true, longReadme = false): Promise<{ ws: string; server: ServerHandle }> {
  const ws = buildWorkspace(withDefinition, longReadme);
  dirs.push(ws);
  const server = startDevServer(ws, "default");
  servers.push(server);
  await server.initialize();
  return { ws, server };
}

/** Evidence rows of one response that carry a body for `file` (any wire shape). */
function bodiesOf(response: any, file: string): string[] {
  const rows: any[] = [
    ...(Array.isArray(response?.evidence) ? response.evidence : []),
    ...(Array.isArray(response?.entries) ? response.entries : []),
  ];
  return rows
    .filter((row) => typeof row?.path === "string" && row.path.endsWith(file))
    .map((row) => (typeof row.body === "string" ? row.body : typeof row.content === "string" ? row.content : ""))
    .filter((body) => body !== "");
}

function summary(hops: readonly Hop[]): string {
  return JSON.stringify(hops.map((hop) => ({
    call: hop.call.arguments,
    bytes: hop.textBytes,
    kind: hop.response?.kind,
    decision: hop.response?.decision?.kind,
    next: hop.nextSource,
    paths: (hop.response?.evidence ?? []).map((row: any) => `${row?.path}${row?.remaining ? `+${JSON.stringify(row.remaining)}` : ""}`),
  })), null, 1);
}

const SMALL_FILES = ["README.md", "index.js", "lib/application.js", "lib/request.js", "package.json", "README.md"];

async function followFromQuery(server: ServerHandle, ws: string, query: string, hopCap = 12): Promise<ReturnType<typeof followNextToEnd>> {
  return followNextToEnd(
    server,
    { tool: "tl_read_file", arguments: { cwd: ws, query, task: { epoch: "new" } } },
    { cwd: ws, hopCap, maxQrefRepacks: 0 },
  );
}

describe("following next verbatim on a behaviour question does not walk a changelog", () => {
  it("res.redirect: at most six follow-ups, at most 40 KiB, History.md never served with a body", async () => {
    const { ws, server } = await start();
    const chain = await followFromQuery(server, ws, QUERY);
    const diagnostic = summary(chain.hops);

    expect(chain.hops.length - 1, "follow-up calls\n" + diagnostic).toBeLessThanOrEqual(TASK_EXPLORATION_MAX_HOPS);
    const total = chain.hops.reduce((sum, hop) => sum + hop.textBytes, 0);
    expect(total, "cumulative bytes\n" + diagnostic).toBeLessThanOrEqual(TASK_EXPLORATION_MAX_BYTES);
    for (const hop of chain.hops) {
      expect(bodiesOf(hop.response, "History.md"), "History.md body in hop " + hop.hopIndex + "\n" + diagnostic).toEqual([]);
    }
    expect(chain.capped, "chain was cut by the test's own hop cap\n" + diagnostic).toBe(false);
  }, 120_000);

  it("res.redirect defined nowhere: the changelog is the only lexical match, its head is served once and it is not walked", async () => {
    const { ws, server } = await start(false);
    const chain = await followFromQuery(server, ws, QUERY);
    const diagnostic = summary(chain.hops);

    expect(chain.hops.length - 1, "follow-up calls\n" + diagnostic).toBeLessThanOrEqual(TASK_EXPLORATION_MAX_HOPS);
    const total = chain.hops.reduce((sum, hop) => sum + hop.textBytes, 0);
    expect(total, "cumulative bytes\n" + diagnostic).toBeLessThanOrEqual(TASK_EXPLORATION_MAX_BYTES);
    // The first pack may carry the changelog's head (it is the only match); no hop pages further into it.
    expect(chain.hops.filter((hop) => bodiesOf(hop.response, "History.md").length > 0).length, diagnostic).toBeLessThanOrEqual(1);
    expect(chain.capped, diagnostic).toBe(false);
    // The stop is disclosed, not silent: a decision that names what is unresolved.
    expect(finalDecisionKind(chain), diagnostic).toBe("await_input");
  }, 120_000);

  it("a long README is still paged, up to the budget; then the stop is disclosed with an unresolved row", async () => {
    const { ws, server } = await start(true, true);
    const chain = await followFromQuery(server, ws, "Explain the installation steps described in the README", 14);
    const diagnostic = summary(chain.hops);
    const readmePages = chain.hops.filter((hop) => bodiesOf(hop.response, "README.md").length > 0);
    // Not low-value, not named-less: an ordinary document is paged while the budget lasts…
    expect(readmePages.length, diagnostic).toBeGreaterThanOrEqual(2);
    // …and the walk ends by itself, inside the budget's neighbourhood.
    expect(chain.hops.length - 1, diagnostic).toBeLessThanOrEqual(TASK_EXPLORATION_MAX_HOPS);
    expect(chain.capped, diagnostic).toBe(false);
    const final = chain.final;
    expect(final?.decision?.kind, diagnostic).toBeDefined();
    if (final?.decision?.kind === "await_input") {
      const kinds = (final.decision.unresolved ?? []).map((row: any) => row.kind);
      expect(kinds, diagnostic).toContain("exploration-budget-exhausted");
    }
  }, 180_000);

  it("an exhausted budget stops proposing even an ordinary document's next page", async () => {
    const { ws, server } = await start(true, true);
    const first = await server.callTool("tl_read_file", { cwd: ws, query: "Explain the installation steps described in the README", task: { epoch: "new" } });
    // Control: with budget to spare the README's remainder IS what the first pack proposes.
    const firstNext = first.body?.decision?.next;
    expect(firstNext?.arguments?.cursor ?? firstNext?.arguments?.range, JSON.stringify(first.body?.decision).slice(0, 800)).toBeDefined();
    for (let i = 0; i < TASK_EXPLORATION_MAX_HOPS; i += 1) {
      await server.callTool("tl_read_file", { cwd: ws, targets: [{ path: SMALL_FILES[i]! }] });
    }
    // A different question of the same task (shared tokens keep the epoch), built fresh.
    const spent = await server.callTool("tl_read_file", { cwd: ws, query: "Which installation steps in the README verify component 7 before continuing?" });
    const detail = JSON.stringify(spent.body).slice(0, 2500);
    expect(spent.body?.kind, detail).toBe("read.task_pack");
    const decision = spent.body?.decision;
    // No further README page is proposed: not a cursor, not a {handle, range} zoom.
    expect(decision?.next?.arguments?.cursor, detail).toBeUndefined();
    expect(decision?.next?.arguments?.range, detail).toBeUndefined();
    expect(JSON.stringify(decision?.next?.arguments?.targets ?? []), detail).not.toContain("range");
    if (decision?.kind === "await_input") {
      expect((decision.unresolved ?? []).map((row: any) => row.kind), detail).toContain("exploration-budget-exhausted");
    }
  }, 180_000);

  it("an exhausted budget ends an in-flight changelog page chain at a resume page, rows and remaining intact", async () => {
    const { ws, server } = await start();
    await server.callTool("tl_read_file", { cwd: ws, query: QUERY, task: { epoch: "new" } });
    // Spend the hop budget on small reads of the task's own files.
    for (let i = 0; i < TASK_EXPLORATION_MAX_HOPS; i += 1) {
      await server.callTool("tl_read_file", { cwd: ws, targets: [{ path: SMALL_FILES[i]! }] });
    }
    // An explicit read of the (unnamed) changelog, then its own continuations, verbatim.
    let page = await server.callTool("tl_read_file", { cwd: ws, targets: [{ path: "History.md" }], budget: { bytes: 9000 } });
    const pages = [page.body];
    for (let i = 0; i < 8; i += 1) {
      const next = page.body?.limit?.next ?? page.body?.next;
      if (next === undefined) break;
      page = await server.callTool(next.tool, next.arguments);
      pages.push(page.body);
    }
    const last = pages[pages.length - 1];
    const detail = JSON.stringify(pages.map((body) => ({
      kind: body?.kind,
      limit: body?.limit?.cause,
      rows: (body?.evidence ?? []).map((row: any) => [row.range, row.remaining]),
    })));
    // 3,000 lines at a 9,000 B budget is a dozen pages. The call that opened the request and its first
    // continuation keep their next; the first RESUME page (a cursor) does not.
    expect(pages.length, detail).toBeLessThanOrEqual(4);
    expect(last?.next, detail).toBeUndefined();
    expect(last?.limit?.next, detail).toBeUndefined();
    expect(bodiesOf(last, "History.md").length, detail).toBeGreaterThan(0);
    const remaining = (last?.evidence ?? []).flatMap((row: any) => row?.remaining ?? []);
    expect(remaining.length, detail).toBeGreaterThan(0);
  }, 180_000);

  it("control: with budget to spare, an explicit read of the same changelog keeps its continuations", async () => {
    const { ws, server } = await start();
    await server.callTool("tl_read_file", { cwd: ws, query: QUERY, task: { epoch: "new" } });
    let page = await server.callTool("tl_read_file", { cwd: ws, targets: [{ path: "History.md" }], budget: { bytes: 9000 } });
    let count = 1;
    for (let i = 0; i < 4; i += 1) {
      const next = page.body?.limit?.next ?? page.body?.next;
      if (next === undefined) break;
      page = await server.callTool(next.tool, next.arguments);
      count += 1;
    }
    expect(count, JSON.stringify(page.body).slice(0, 800)).toBe(5);
  }, 180_000);

  it("a request that names History.md is served History.md", async () => {
    const { ws, server } = await start();
    const chain = await followFromQuery(server, ws, "what changed in History.md about redirect statuses", 8);
    const diagnostic = summary(chain.hops);
    expect(chain.hops.some((hop) => bodiesOf(hop.response, "History.md").length > 0), diagnostic).toBe(true);
  }, 120_000);
});
