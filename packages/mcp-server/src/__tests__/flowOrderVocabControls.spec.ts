import { afterEach, describe, expect, it, vi } from "vitest";
import { extractFacetRequirements } from "../features/task-pack/requestFacets.js";

const flow = (query: string) => extractFacetRequirements(query).filter((f) => f.facet === "flow");
afterEach(() => vi.unstubAllEnvs());

describe("call-order vocabulary controls and subject extraction", () => {
  it.each([
    "Give me a quick overview of Pipeline and the order it calls payment / inventory / shipping in.",
    "Pipeline が payment / inventory / shipping を呼ぶ順番をざっと説明して。",
  ])("can disable the additional detector independently of maps: %s", (query) => {
    vi.stubEnv("TL_EFF_STRUCTURE_MAP", "0");
    vi.stubEnv("TL_EFF_FLOW_ORDER_VOCAB", "1");
    expect(flow(query).length).toBeGreaterThan(0);
    vi.stubEnv("TL_EFF_FLOW_ORDER_VOCAB", "0");
    expect(flow(query)).toEqual([]);
  });

  it("keeps the legacy flow contract when the extension is off", () => {
    const query = "Trace the request path through Pipeline.";
    vi.stubEnv("TL_EFF_FLOW_ORDER_VOCAB", "1");
    const enabled = extractFacetRequirements(query);
    vi.stubEnv("TL_EFF_FLOW_ORDER_VOCAB", "0");
    expect(extractFacetRequirements(query)).toEqual(enabled);
  });

  it.each([
    "What happens when the webhook gets called twice?",
    "I want to know when flush gets called.",
    "Which agent is called first when a customer dials in?",
    "Does the hook order matter for correctness?",
    "Keep the call order the same when you refactor.",
    "呼び出し順を確認するテストはどこ？",
    "どのテストより先に実行してください。",
    "どのファイルでも先に呼んでから保存して。",
    "何を先に実行してもエラーになる。",
    "どんな順番でもいいので処理して。",
    "どんな順番で来ても処理できるようにしたい。",
  ])("does not turn timing, telephone or instruction prose into flow: %s", (query) => {
    expect(flow(query)).toEqual([]);
  });

  it("drops answer scaffolding without losing the named concerns", () => {
    const requirements = flow("Give me a quick overview of Pipeline and the order it calls payment / inventory / shipping in.");
    const terms = requirements.flatMap((f) => f.subjectTerms);
    expect(terms).toEqual(expect.arrayContaining(["payment", "inventory", "shipping"]));
    expect(terms.filter((term) => ["give", "quick", "overview", "call", "calls", "get", "run"].includes(term))).toEqual([]);
  });

  it("preserves explicitly named callables and ordinary pipeline operators", () => {
    const named = flow("In which order does Pipeline call get() / run() / map()?");
    expect(named.flatMap((f) => f.subjectCallables ?? [])).toEqual(expect.arrayContaining(["get", "run", "map"]));
    const operators = flow("How Pipeline sequences map / filter / reduce?");
    expect(operators.flatMap((f) => f.subjectTerms)).toEqual(expect.arrayContaining(["map", "filter", "reduce"]));
    const answerWordNames = flow("What order does Pipeline call summary / outline / overview in?");
    expect(answerWordNames.flatMap((f) => f.subjectTerms)).toEqual(expect.arrayContaining(["summary", "outline", "overview"]));
    const bare = flow("What order does Pipeline call get / run / map in?");
    expect(bare.flatMap((f) => f.subjectTerms)).toEqual(expect.arrayContaining(["get", "run", "map"]));
  });
});
