import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { stripDelegationActorSpans } from "../features/task-pack/requestItems.js";
import { locateTaskContext } from "../features/locator/locateTaskContext.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

describe("delegation actor retrieval projection", () => {
  it.each([
    ["src/cache.ts を確認し、Vegaサブエージェントに簡単な作業を任せてください。", "Vegaサブエージェント"],
    ["Ask Vega subagent to review src/cache.ts for cancellation bugs.", "Vega subagent"],
    ["Don't skip src/cache.ts. Ask Vega subagent to review.", "Vega subagent"],
    ["Review the worker's cancellation logic. Ask Vega subagent to check src/cache.ts.", "Vega subagent"],
    ["Use the Rigel sub-agent to check src/cache.ts.", "Rigel sub-agent"],
    ["Review src/cache.ts; delegate simple checks to the Vega subagent.", "Vega subagent"],
    ["Assign src/cache.ts to Vega subagent.", "Vega subagent"],
    ["lunaサブエージェントに簡易な作業を任せながら並列して進めてください。", "lunaサブエージェント"],
    ["必要であればAstraサブエージェントに非常に高度な分析も任せてみてください", "Astraサブエージェント"],
  ])("masks the actor and preserves the actual work: %s", (query, actor) => {
    const start = query.indexOf(actor);
    const expected = query.slice(0, start) + " ".repeat(actor.length) + query.slice(start + actor.length);
    const result = stripDelegationActorSpans(query);
    expect(result).toBe(expected);
    expect(result.length).toBe(query.length);
    expect(stripDelegationActorSpans(result)).toBe(result);
  });

  it.each([
    'Search for "delegate work to luna subagent" in src/help.ts.',
    "Search for \"don't. Ask Vega subagent to help.\" in src/help.ts.",
    "Search for \"before \\\" marker. Ask Vega subagent to help.\" in src/help.ts.",
    "Search `\"don't. Ask Vega subagent to help.\"` in src/help.ts.",
    "Search for \"Ask Vega subagent to help.",
    "Search for ‘Ask Vega subagent to help’ in src/help.ts.",
    "Search for “Ask Vega subagent to help” in src/help.ts.",
    "Search for 「Vegaサブエージェントに任せてください」 in src/help.ts.",
    "Explain `lunaSubagent` and `LUNA_AGENT` in src/agents.ts.",
    "lunaサブエージェントの実装と委任処理を説明してください。",
    "Explain how the Vega subagent delegates work.",
    "Ask Vega agent to review src/cache.ts.",
    "Search this sample:\n```text\nAsk Vega subagent to help.\n```",
    "Search this sample:\n~~~text\nAsk Vega subagent to help.\n~~~",
  ])("preserves source literals and descriptive agent subjects: %s", (query) => {
    expect(stripDelegationActorSpans(query)).toBe(query);
  });

  it("keeps a quoted actor literal while removing a separate assignment", () => {
    const query = 'Find the literal "luna" in src/config.ts. Ask Astra subagent to help.';
    const result = stripDelegationActorSpans(query);
    expect(result).toContain('"luna"');
    expect(result).toContain("src/config.ts");
    expect(result).not.toContain("Astra subagent");
  });

  it("does not let a delegate's directory name change the direct locator's targets", async () => {
    const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.homedir(), ".tl-delegation-audit-")));
    dirs.push(workspace);
    for (const [rel, body] of [
      ["src/cache.ts", "export function cancelPendingRequests() { return 'cancellation'; }\n"],
      ["archive/vega/decoy.ts", "export function oldReport() { return 'unrelated historic report'; }\n"],
      ["archive/rigel/decoy.ts", "export function oldResults() { return 'unrelated historic results'; }\n"],
    ]) {
      const file = path.join(workspace, rel!);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, body!);
    }
    const input = { action: "locate" as const, query: "Explain cancellation handling. Ask Vega subagent to run simple checks.", limit: 3 };
    const delegated = await locateTaskContext(workspace, input);
    const projected = await locateTaskContext(workspace, { ...input, query: stripDelegationActorSpans(input.query) });
    expect(delegated).toEqual(projected);
    expect(JSON.stringify(delegated)).toContain("src/cache.ts");
    expect(JSON.stringify(delegated)).not.toContain("archive/vega");
  });
});
