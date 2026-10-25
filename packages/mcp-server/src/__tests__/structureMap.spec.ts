/**
 * structureMap.spec.ts — v0.16 decision window 6t-7, T03 (2026-10-20): the
 * STRUCTURE MAP selection wording and window planner
 * (features/task-pack/structureMap.ts), as pure units. The answer pack's
 * wiring (selection rule, facet plan, rendering, state types) is pinned end
 * to end by structureMapAnswer.spec.ts and by the replay corpus group v016sm
 * (the verbatim T03 first call).
 */
import { describe, expect, it } from "vitest";

import { collectSymbols } from "../symbols/collectSymbols.js";
import {
  STRUCTURE_MAP_COVER_MAX_MEMBERS,
  STRUCTURE_MAP_DOC_MAX_LINES,
  asksForStructureMap,
  collaboratorConcernMembers,
  collaboratorFields,
  concernCallMatches,
  concernCallsOnLine,
  concernHelperNames,
  concernMembers,
  coverMembers,
  directConcernMembers,
  headerTypeNames,
  identifierHasSegment,
  invokesConcern,
  memberMapWindows,
  mergeSpans,
  planStructureMap,
  structureMapCallTerms,
  structureMapTypeOf,
  type StructureMapMember,
  type StructureMapSymbol,
  type StructureMapType,
} from "../features/task-pack/structureMap.js";

const T03_QUERY = "[Slack風 新入りメンバーから] shopflow に最近入った OrderOrchestrator っていうデカいクラスがあるんだけど、注文ライフサイクル全体をどう面倒見てるのか分からない…。\nstate machine の transition table と、payment / inventory / shipping をどう順番に叩いてるかを中心に、何をしているクラスか短く説明してほしい (50行以内、構造の地図として見たい)。\nコード変更は不要。";

describe("asksForStructureMap — wording that asks for a short or map-shaped answer", () => {
  it.each([
    T03_QUERY,
    "Give me a brief overview of the OrderFlow class.",
    "Summarize what LedgerService does around posting and reversal.",
    "In under 40 lines, how does the Scheduler drive its jobs?",
    "A high-level map of the class would help: how does Router dispatch?",
    "Router が何をしているかざっくり教えて",
    "Billing クラスの概要を知りたい",
    "処理の流れを 30 行以内で",
  ])("map-shaped: %s", (query) => {
    expect(asksForStructureMap(query)).toBe(true);
  });

  it.each([
    "explain how OrderFlow sequences payment inventory shipping in its lifecycle",
    "Why does place() fail when the payment is declined?",
    "Where is the transition table defined?",
    "OrderOrchestrator の注文処理の流れを説明して",
    "What does retryDelay return for attempt 3?",
  ])("not map-shaped: %s", (query) => {
    expect(asksForStructureMap(query)).toBe(false);
  });
});

const owner = { name: "Ledger", startLine: 1, endLine: 100 };
function symbol(
  name: string,
  kind: string,
  startLine: number,
  endLine: number,
  signatureStartLine: number,
  signatureEndLine: number,
  enclosingSymbol?: StructureMapSymbol["enclosingSymbol"],
): StructureMapSymbol {
  return { name, kind, startLine, endLine, signatureStartLine, signatureEndLine, ...(enclosingSymbol ? { enclosingSymbol } : {}) };
}

describe("structureMapTypeOf — the type and its direct members", () => {
  const symbols: StructureMapSymbol[] = [
    symbol("Ledger", "class", 1, 100, 5, 5),
    symbol("Ledger", "method", 10, 15, 10, 11, owner),
    symbol("post", "method", 18, 40, 22, 22, owner),
    symbol("Entry", "class", 50, 60, 50, 52, owner),
    symbol("amount", "method", 55, 57, 55, 55, { name: "Entry", startLine: 50, endLine: 60 }),
    symbol("close", "method", 68, 90, 72, 73, owner),
    symbol("helper", "function", 200, 210, 200, 200),
  ];

  it("keeps the type's direct callables and nested types in source order, flags the constructor, and never a nested type's own members", () => {
    const type = structureMapTypeOf(symbols, "src/Ledger.java", "Ledger", 1, 100)!;
    expect(type).toMatchObject({ path: "src/Ledger.java", name: "Ledger", start: 1, end: 100, signatureStart: 5, signatureEnd: 5 });
    expect(type.members.map((member) => [member.name, member.signatureStart, member.signatureEnd, member.constructor, member.nestedType])).toEqual([
      ["Ledger", 10, 11, true, false],
      ["post", 22, 22, false, false],
      ["Entry", 50, 52, false, true],
      ["close", 72, 73, false, false],
    ]);
  });

  it("is undefined for a name that is no type, for a type outside the candidate range, and for a type with fewer than three members", () => {
    expect(structureMapTypeOf(symbols, "src/Ledger.java", "post", 1, 100)).toBeUndefined();
    expect(structureMapTypeOf(symbols, "src/Ledger.java", "Ledger", 150, 160)).toBeUndefined();
    const small = symbols.filter((entry) => entry.name !== "close" && entry.name !== "Entry");
    expect(structureMapTypeOf(small, "src/Ledger.java", "Ledger", 1, 100)).toBeUndefined();
  });
});

describe("structureMapCallTerms — the words whose call statements a map serves", () => {
  it("keeps identifier-shaped point words; drops the type's own name words, non-point words, short words and CJK runs", () => {
    expect(structureMapCallTerms(
      ["payment", "inventory", "shipping", "order", "orderorchestrator", "slack", "注文ライフサイクル", "ab", "shopflow", "payment"],
      "OrderOrchestrator",
      ["shopflow"],
    )).toEqual(["payment", "inventory", "shipping", "slack"]);
  });

  it("a concern the request lists by name stays one even when it is a word of the type's name (keepTypeWords)", () => {
    expect(structureMapCallTerms(["payment", "ledger"], "PaymentProcessor")).toEqual(["ledger"]);
    expect(structureMapCallTerms(["payment", "ledger"], "PaymentProcessor", [], true)).toEqual(["payment", "ledger"]);
  });
});

describe("identifierHasSegment / invokesConcern — a call that invokes a named concern", () => {
  it.each([
    ["paymentService", "payment", true],
    ["payment_gateway", "payment", true],
    ["PAYMENT_ID", "payment", true],
    ["ShippingClient", "shipping", true],
    ["HTTPShippingClient", "shipping", true],
    ["requoteShipping", "shipping", true],
    ["prepayment", "payment", false],
    ["paymentservice", "payment", false],
    ["callback", "call", false],
  ] as const)("identifierHasSegment(%s, %s) = %s", (identifier, term, expected) => {
    expect(identifierHasSegment(identifier, term)).toBe(expected);
  });

  it.each([
    ["            payment = paymentService.charge(payReq);", "payment", true],
    ["        BigDecimal shipping = pricingService.shipping(items, req.shipTo());", "shipping", true],
    ["        quote = Shipping::quote(order);", "shipping", true],
    ["        inventory_client->reserve(sku);", "inventory", true],
    ["        this.paymentService.refund(order.getPaymentId());", "payment", true],
    ["        order.setPaymentId(order.getPaymentId());", "payment", false],
    ["        order.setShippingFee(fee);", "shipping", false],
    ["        this.paymentService = paymentService;", "payment", false],
    ["        log.warn(\"paymentService.charge( failed\", id);", "payment", false],
  ] as const)("invokesConcern(%j, %s) = %s", (line, term, expected) => {
    expect(invokesConcern(line, term)).toBe(expected);
  });
});

describe("memberMapWindows — a member's signature and the statements that call its concerns", () => {
  const lines = [
    "class Desk {",
    "  @Transactional",
    "  public void place(Req req) {",
    "    // paymentService.charge(x) in a comment is no call",
    "    log.info(\"paymentService.charge( in a message\");",
    "    inventoryService.reserve(req.sku(),",
    "        req.quantity());",
    "    total = compute(req);",
    "    Charge c = new Charge(",
    "        req.total(), req.method().paymentKind());",
    "    order.setPaymentId(c.id());",
    "    releaseAll(req);",
    "    audit(req);",
    "    shippingService.requestLabel(req);",
    "  }",
    "}",
  ];
  const place: StructureMapMember = { name: "place", start: 2, end: 15, signatureStart: 2, signatureEnd: 3, nestedType: false, constructor: false };

  it("keeps the complete selected member including assignments and cleanup around concern calls", () => {
    const spans = memberMapWindows(place, lines, ["payment", "inventory", "shipping"], new Set(["releaseAll"]));
    expect(spans).toEqual([{ start: 2, end: 15 }]);
  });

  it("maps a nested type by its signature only, and a member with no terms by its signature only", () => {
    expect(memberMapWindows({ ...place, nestedType: true }, lines, ["payment"])).toEqual([{ start: 2, end: 3 }]);
    expect(memberMapWindows(place, lines, [])).toEqual([{ start: 2, end: 3 }]);
  });

  it("mergeSpans merges overlapping and touching spans, in order", () => {
    expect(mergeSpans([{ start: 9, end: 10 }, { start: 2, end: 3 }, { start: 4, end: 4 }, { start: 12, end: 12 }])).toEqual([
      { start: 2, end: 4 },
      { start: 9, end: 10 },
      { start: 12, end: 12 },
    ]);
  });
});

describe("memberMapWindows — whole bodies for a page, rows for what a map requires", () => {
  const braceSource = ["run(req) {", "if (!req.valid) return;", "try {",
    "for (const item of req.items) stock.reserve(item);", "const total = req.price * 2;",
    "state = PAID;", "save(state);", "} catch (error) {", "state = CANCELLED;",
    "throw error;", "} finally { cleanup(); }", "}"];
  const indentSource = ["def run(self, req):", "    if not req.valid:", "        return",
    "    try:", "        for item in req.items:", "            stock.reserve(item)",
    "        total = req.price * 2", "        self.state = PAID", "        save(self.state)",
    "    except Exception:", "        self.state = CANCELLED", "        raise",
    "    finally:", "        cleanup()"];
  const member = (source: readonly string[]): StructureMapMember => ({name: "run", start: 1, end: source.length,
    signatureStart: 1, signatureEnd: 1, nestedType: false, constructor: false});

  it.each([["brace controls", braceSource], ["indentation controls", indentSource]] as const)(
    "whole keeps the complete selected member, and so does the default: %s", (_label, source) => {
      expect(memberMapWindows(member(source), source, ["stock"])).toEqual([{start: 1, end: source.length}]);
      expect(memberMapWindows(member(source), source, ["stock"], new Set(), "whole")).toEqual([{start: 1, end: source.length}]);
    });

  it("rows keep the signature, the concern statement, the guard return, the save and the control lines around them, and the try's handlers whole: braces", () => {
    // 1 signature · 2 the guard (a return) · 3 the try the call is inside · 4 the loop it is in and the call itself ·
    // 7 the save · 8-11 the handlers of the try that calls a concern: the catch with its state write and its throw,
    // and the finally. The local assignments (5, 6) are not rows; neither is the closing brace (12).
    expect(memberMapWindows(member(braceSource), braceSource, ["stock"], new Set(), "rows"))
      .toEqual([{start: 1, end: 4}, {start: 7, end: 11}]);
  });

  it("rows keep the signature, the concern statement, the guard return, the state writes and the save, and the try's handlers whole: indentation", () => {
    // 8 and 9 are the state write and the save, 10-14 the except and the finally with their bodies; 7 is a local assignment.
    expect(memberMapWindows(member(indentSource), indentSource, ["stock"], new Set(), "rows"))
      .toEqual([{start: 1, end: 6}, {start: 8, end: 14}]);
  });

  it("rows of a member that calls no concern, of a nested type and with no terms are the signature", () => {
    expect(memberMapWindows(member(braceSource), braceSource, ["absent"], new Set(), "rows")).toEqual([{start: 1, end: 1}]);
    expect(memberMapWindows({...member(braceSource), nestedType: true}, braceSource, ["stock"], new Set(), "rows")).toEqual([{start: 1, end: 1}]);
    expect(memberMapWindows(member(braceSource), braceSource, [], new Set(), "rows")).toEqual([{start: 1, end: 1}]);
  });

  function rowLines(source: readonly string[], terms = ["shipping"], helpers = new Set<string>()): number[] {
    const before = [...source];
    const windows = memberMapWindows(member(source), source, terms, helpers, "rows");
    expect(source).toEqual(before);
    return windows.flatMap(span => Array.from({ length: span.end - span.start + 1 }, (_, i) => span.start + i));
  }

  it("separates the FULFILLED notification from the DELIVERED inventory release with the labels in front of each", () => {
    expect(rowLines(["run(state) {", "switch(state) {", "case FULFILLED:", "shipping.notify();", "break;", "case DELIVERED:", "inventory.release();", "break;", "default:", "return;", "}", "}"], ["shipping", "inventory"]))
      .toEqual([1, 2, 3, 4, 6, 7, 9, 10]);
  });

  it("does not attach an earlier closed switch or a switch-named identifier", () => {
    expect(rowLines(["run() {", "switch(state) {", "case READY:", "const w = other.work();", "break;", "}", "const switcher = {};", "shipping.notify();", "}"]))
      .toEqual([1, 8]);
  });

  it("does not attach a switch closed earlier on the selected call's line", () => {
    expect(rowLines(["run() {", "switch(state) {", "case READY:", "const w = other.work();", "} shipping.notify();", "}"])).toEqual([1, 5]);
  });

  it("retains both ancestor switches for a nested selected call", () => {
    expect(rowLines(["run() {", "switch(outer) {", "case ACTIVE:", "switch(inner) {", "case READY:", "shipping.notify();", "break;", "}", "break;", "}", "}"]))
      .toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("ignores fake controls and calls in multiline comments and strings", () => {
    expect(rowLines(['run() {', 'const fake="switch(state) { case FAKE:";', '/* switch(state) {', 'case COMMENT:', 'shipping.fake();', '} */', 'shipping.notify();', '}']))
      .toEqual([1, 7]);
    expect(rowLines(['run() {', 'const fake="shipping.notify()";', '/* shipping.fake(); */', 'other();', '}'])).toEqual([1]);
  });

  it("retains multiline selectors and Java arrow labels", () => {
    expect(rowLines(["run() {", "switch (", "state", ") {", "case READY -> {", "shipping.notify();", "}", "default -> {}", "}", "}"]))
      .toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("retains multiline labels, fallthrough, ternaries and default for helper calls", () => {
    expect(rowLines(["run() {", "switch(state) {", "case", "flag ? A : B:", "case C:", "cancel();", "break;", "default:", "cancel();", "}", "}"], ["inventory"], new Set(["cancel"])))
      .toEqual([1, 2, 3, 4, 5, 6, 8, 9]);
  });

  it.each(["opts?.state", "opts ?? fallback", "config\n.default", "{\nkey: value\n}"])("retains complete JS label expressions: %s", expression => {
    const labelLines = ("case " + expression + ":").split("\n");
    const source = ["run() {", "switch(state) {", ...labelLines, "shipping.notify();", "break;", "default:", "}", "}"];
    const seen = rowLines(source);
    for (let line = 3; line <= 3 + labelLines.length - 1; line++) expect(seen, "missing label " + line).toContain(line);
    expect(seen).toContain(3 + labelLines.length);
    expect(seen).not.toContain(3 + labelLines.length + 1);
  });

  it("preserves outer case context when its selector contains a switch expression", () => {
    const source = [
      "void run(int mode) {", "  switch (", "    switch (mode) {",
      "      case 0 -> 1;", "      default -> 2;", "    }", "  ) {",
      "    case 1:", "", "      shipping.notifyFulfilled();", "      break;",
      "", "    case 2:", "", "      inventory.release();", "      break;", "  }", "}",
    ];
    expect(rowLines(source, ["shipping", "inventory"])).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 10, 13, 15]);
  });

  it("keeps an unmatched member at its signature", () => {
    expect(rowLines(["run() {", "switch(state) {", "case READY:", "shipping.notify();", "}", "}"], ["absent"])).toEqual([1]);
  });
});

const DESK_SOURCE = [
  "package demo;",
  "",
  "/**",
  " * Coordinates fulfilment for one order at a time.",
  " */",
  "public class FulfillmentDesk {",
  "",
  "    private final BillingClient billingClient;",
  "    private final StockLedger stockLedger;",
  "    /**",
  "     * Every permitted move.",
  "     */",
  "    private static final Map<DeskState, Set<DeskState>> MOVES = new EnumMap<>(DeskState.class);",
  "",
  "    public FulfillmentDesk(BillingClient billingClient, StockLedger stockLedger) {",
  "        this.billingClient = billingClient;",
  "        this.stockLedger = stockLedger;",
  "    }",
  "",
  "    /** Places an order. */",
  "    public void place(Order order) {",
  "        validate(order);",
  "        stockLedger.reserve(order.sku());",
  "        billingClient.charge(order.total());",
  "        audit(order);",
  "    }",
  "",
  "    /** Cancels an order. */",
  "    public void cancel(Order order) {",
  "        Order current = load(order.id());",
  "        billingClient.refund(current.id());",
  "        undo(current);",
  "    }",
  "",
  "    private void undo(Order order) {",
  "        log(order.id());",
  "        stockLedger.release(order.sku());",
  "    }",
  "",
  "    private void audit(Order order) {",
  "        log(order.id());",
  "    }",
  "",
  "    public record Receipt(long id, long amount) {}",
  "}",
];

async function deskType(source: readonly string[]): Promise<StructureMapType> {
  const symbols = await collectSymbols(source.join("\n"), "java", {});
  const type = structureMapTypeOf(symbols, "src/FulfillmentDesk.java", "FulfillmentDesk", 1, source.length);
  expect(type, JSON.stringify(symbols.map((entry) => [entry.name, entry.kind, entry.startLine, entry.endLine]))).toBeDefined();
  return type!;
}

function windowText(lines: readonly string[], span: { start: number; end: number }): string {
  return lines.slice(span.start - 1, span.end).map((line) => line.trim()).join(" ").trim();
}

describe("planStructureMap — doc, header, every signature and the concern calls, the rest owed", () => {
  it("maps a parsed Java class: its doc, its header through the constructor, each member's signature, each concern call and each call of a concern helper", async () => {
    const type = await deskType(DESK_SOURCE);
    expect(concernHelperNames(type, DESK_SOURCE, ["billing", "stock"])).toEqual(new Set(["place", "cancel", "undo"]));
    const plan = planStructureMap(type, DESK_SOURCE, ["billing", "stock"]);
    expect(plan.windows.map((window) => [window.kind, window.member, windowText(DESK_SOURCE, window)])).toEqual([
      ["doc", "FulfillmentDesk", "/** * Coordinates fulfilment for one order at a time. */"],
      ["header", "FulfillmentDesk", windowText(DESK_SOURCE, { start: 6, end: 19 })],
      ["signature", "place", "public void place(Order order) {"],
      ["call", "place", "validate(order); stockLedger.reserve(order.sku()); billingClient.charge(order.total()); audit(order); }"],
      ["signature", "cancel", "public void cancel(Order order) {"],
      ["call", "cancel", "Order current = load(order.id()); billingClient.refund(current.id()); undo(current); }"],
      ["signature", "undo", "private void undo(Order order) {"],
      ["call", "undo", "log(order.id()); stockLedger.release(order.sku()); }"],
      ["signature", "audit", "private void audit(Order order) {"],
      ["signature", "Receipt", "public record Receipt(long id, long amount) {}"],
    ]);
  });

  it("owes every other line of the type exactly once, each owed window inside one member's lines (its doc comment or the rest of its body)", async () => {
    const type = await deskType(DESK_SOURCE);
    const plan = planStructureMap(type, DESK_SOURCE, ["billing", "stock"]);
    const count = new Map<number, number>();
    for (const span of [...plan.windows, ...plan.remaining]) {
      for (let line = span.start; line <= span.end; line += 1) count.set(line, (count.get(line) ?? 0) + 1);
    }
    for (let line = type.start; line <= type.end; line += 1) expect(count.get(line), `line ${line}`).toBe(1);
    const starts = type.members.map((member) => member.start);
    for (const span of plan.remaining) {
      expect(starts.some((start) => span.start < start && start <= span.end), `${span.start}-${span.end} crosses a member start`).toBe(false);
    }
    expect(plan.remaining.some(span => span.start <= 41 && span.end >= 42)).toBe(true);
  });

  it("with rows the call windows are the statements that call a concern or a helper of one, not the bodies, and every other line is still owed exactly once", async () => {
    const type = await deskType(DESK_SOURCE);
    const plan = planStructureMap(type, DESK_SOURCE, ["billing", "stock"], Number.MAX_SAFE_INTEGER, true, { bodies: "rows" });
    // …and the audit, an effect: the local load in `cancel` is neither a concern nor an effect. A call whose value is
    // thrown away runs for its effect (2026-10-24): `validate(order);` and `log(order.id());` are rows too.
    expect(plan.windows.filter(window => window.kind === "call").map(window => [window.member, windowText(DESK_SOURCE, window)])).toEqual([
      ["place", "validate(order); stockLedger.reserve(order.sku()); billingClient.charge(order.total()); audit(order);"],
      ["cancel", "billingClient.refund(current.id()); undo(current);"],
      ["undo", "log(order.id()); stockLedger.release(order.sku());"],
    ]);
    // The signatures, the doc and the header are what the whole mode serves too.
    const whole = planStructureMap(type, DESK_SOURCE, ["billing", "stock"], Number.MAX_SAFE_INTEGER, true);
    expect(plan.windows.filter(window => window.kind !== "call")).toEqual(whole.windows.filter(window => window.kind !== "call"));
    expect(plan.bytes).toBeLessThan(whole.bytes);
    const count = new Map<number, number>();
    for (const span of [...plan.windows, ...plan.remaining]) {
      for (let line = span.start; line <= span.end; line += 1) count.set(line, (count.get(line) ?? 0) + 1);
    }
    for (let line = type.start; line <= type.end; line += 1) expect(count.get(line), `line ${line}`).toBe(1);
  });

  it("rows serve the lines a caller anchors whole, and the default of the planner stays the whole body", async () => {
    const type = await deskType(DESK_SOURCE);
    const anchored = planStructureMap(type, DESK_SOURCE, ["billing", "stock"], Number.MAX_SAFE_INTEGER, true, { bodies: "rows", anchors: [{ start: 22, end: 23 }] });
    expect(anchored.windows.filter(window => window.kind === "call" && window.member === "place").map(window => windowText(DESK_SOURCE, window)))
      .toEqual(["validate(order); stockLedger.reserve(order.sku()); billingClient.charge(order.total()); audit(order);"]);
    expect(planStructureMap(type, DESK_SOURCE, ["billing", "stock"]).windows)
      .toEqual(planStructureMap(type, DESK_SOURCE, ["billing", "stock"], undefined, true, { bodies: "whole" }).windows);
  });

  it("under a byte budget the outline survives first: signatures are kept and call statements are dropped from the tail, which stay owed", async () => {
    const type = await deskType(DESK_SOURCE);
    const full = planStructureMap(type, DESK_SOURCE, ["billing", "stock"]);
    const callBytes = full.windows.filter((window) => window.kind === "call")
      .reduce((total, window) => total + Buffer.byteLength(DESK_SOURCE.slice(window.start - 1, window.end).join("\n"), "utf8") + 1, 0);
    const tight = planStructureMap(type, DESK_SOURCE, ["billing", "stock"], full.bytes - callBytes);
    expect(tight.windows.filter((window) => window.kind === "signature")).toHaveLength(5);
    expect(tight.windows.filter((window) => window.kind === "call")).toHaveLength(0);
    expect(tight.remaining.map((span) => windowText(DESK_SOURCE, span)).join(" | ")).toContain("billingClient.charge(order.total());");
  });

  it("a doc comment longer than STRUCTURE_MAP_DOC_MAX_LINES is not mapped; its lines stay owed", () => {
    const docLines = STRUCTURE_MAP_DOC_MAX_LINES + 5;
    const lines = ["/**", ...Array.from({ length: docLines - 2 }, (_, i) => ` * line ${i}`), " */", "class Big {", "  void a() {", "  }", "  void b() {", "  }", "  void c() {", "  }", "}"];
    const declaration = docLines + 1;
    const member = (name: string, line: number): StructureMapMember =>
      ({ name, start: line, end: line + 1, signatureStart: line, signatureEnd: line, nestedType: false, constructor: false });
    const type: StructureMapType = {
      path: "src/Big.java", name: "Big", start: 1, end: lines.length, signatureStart: declaration, signatureEnd: declaration,
      members: [member("a", declaration + 1), member("b", declaration + 3), member("c", declaration + 5)],
    };
    const plan = planStructureMap(type, lines, ["billing"]);
    expect(plan.windows.some((window) => window.kind === "doc")).toBe(false);
    expect(plan.remaining[0]).toEqual({ start: 1, end: docLines });
  });
});

describe("headerTypeNames — the types a header is declared in, most-named first", () => {
  it("counts capitalized identifiers on code lines, skipping comments, string literals, constants and the type's own name", () => {
    const names = headerTypeNames(DESK_SOURCE, { start: 6, end: 19 }, "FulfillmentDesk");
    expect(names.slice(0, 3)).toEqual(["DeskState", "BillingClient", "StockLedger"]);
    expect(names).not.toContain("FulfillmentDesk");
    expect(names).not.toContain("MOVES");
    expect(names).not.toContain("Every");
  });
});

describe("collaboratorFields — the fields a type receives its collaborators in", () => {
  const typeOf = async (lang: string, file: string, source: readonly string[]): Promise<StructureMapType> => {
    const symbols = await collectSymbols(source.join("\n"), lang, {});
    const type = structureMapTypeOf(symbols, `src/${file}`, "Desk", 1, source.length);
    expect(type, JSON.stringify(symbols.map((entry) => [entry.name, entry.kind, entry.startLine, entry.endLine]))).toBeDefined();
    return type!;
  };

  it("Java: the fields a constructor assigns from a parameter and the instance fields declared without an initializer; not statics, constants, built-in-place fields or values", async () => {
    const source = [
      "@Service",
      "public class Desk {",
      "    private static final Logger log = LoggerFactory.getLogger(Desk.class);",
      "    private static final int RETRIES = 3;",
      "    private final PaymentService paymentService;",
      "    private final OrderRepository orderRepository;",
      "    @Autowired private AuditLogger auditLogger;",
      "    private final ReentrantLock lock = new ReentrantLock();",
      "    private int counter;",
      "    private String label;",
      "    private final Map<String, Integer> seen;",
      "",
      "    public Desk(PaymentService paymentService, OrderRepository orderRepository, Map<String, Integer> seen) {",
      "        this.paymentService = paymentService;",
      "        this.orderRepository = orderRepository;",
      "        this.seen = seen;",
      "    }",
      "",
      "    public void a() {",
      "    }",
      "    public void b() {",
      "    }",
      "    public void c() {",
      "    }",
      "}",
    ];
    const fields = collaboratorFields(await typeOf("java", "Desk.java", source), source);
    expect([...fields].sort()).toEqual(["auditLogger", "orderRepository", "paymentService", "seen"]);
  });

  it("TypeScript: parameter properties and declared fields; not a number, a string or a flag", async () => {
    const source = [
      "export class Desk {",
      "  private readonly payments: PaymentService;",
      "  private count: number;",
      "  private name?: string;",
      "  constructor(private readonly billing: BillingClient, public stock: StockLedger, label: string, private retries: number) {",
      "    this.payments = payments;",
      "  }",
      "  a() {}",
      "  b() {}",
      "  c() {}",
      "}",
    ];
    const fields = collaboratorFields(await typeOf("typescript", "Desk.ts", source), source);
    expect([...fields].sort()).toEqual(["billing", "payments", "stock"]);
  });

  it("Kotlin: the primary constructor's val and var properties", async () => {
    const source = [
      "class Desk(private val billing: BillingClient, private val label: String, val stock: StockLedger) {",
      "    fun a() {}",
      "    fun b() {}",
      "    fun c() {}",
      "}",
    ];
    const fields = collaboratorFields(await typeOf("kotlin", "Desk.kt", source), source);
    expect([...fields].sort()).toEqual(["billing", "stock"]);
  });

  it("Python: what __init__ assigns from a name, not a literal", async () => {
    const source = [
      "class Desk:",
      "    def __init__(self, billing, stock):",
      "        self.billing = billing",
      "        self.stock = stock",
      "        self.count = 0",
      "    def a(self):",
      "        pass",
      "    def b(self):",
      "        pass",
      "    def c(self):",
      "        pass",
    ];
    const fields = collaboratorFields(await typeOf("python", "desk.py", source), source);
    expect([...fields].sort()).toEqual(["billing", "stock"]);
  });

  it("is empty when the header shows no collaborator", async () => {
    const source = ["class Desk {", "  a() {}", "  b() {}", "  c() {}", "}"];
    expect([...collaboratorFields(await typeOf("typescript", "Plain.ts", source), source)]).toEqual([]);
  });
});

describe("planStructureMap — rows keep the failure handling of the calls on a collaborator field", () => {
  const SOURCE = [
    "public class FulfillmentDesk {",
    "    private final BillingClient billingClient;",
    "    private final Validator validator;",
    "    private final OrderRepository orderRepository;",
    "",
    "    public FulfillmentDesk(BillingClient billingClient, Validator validator, OrderRepository orderRepository) {",
    "        this.billingClient = billingClient;",
    "        this.validator = validator;",
    "        this.orderRepository = orderRepository;",
    "    }",
    "",
    "    public void place(Order order) {",
    "        int fee = compute(order);",
    "        try {",
    "            validator.check(order);",
    "        } catch (ValidationException ex) {",
    "            log.warn(\"invalid\", ex);",
    "            throw ex;",
    "        }",
    "        billingClient.charge(order.total() + fee);",
    "        order.setStatus(PAID);",
    "        orderRepository.save(order);",
    "    }",
    "",
    "    public void a() {",
    "    }",
    "",
    "    public void b() {",
    "    }",
    "}",
  ];

  it("a try that calls a collaborator brings its handler whole; the page of whole bodies is unchanged", async () => {
    const type = await deskType(SOURCE);
    const rows = planStructureMap(type, SOURCE, ["billing"], Number.MAX_SAFE_INTEGER, true, { bodies: "rows" });
    expect(rows.windows.filter(window => window.kind === "call" && window.member === "place").map(window => windowText(SOURCE, window)))
      .toEqual(["try { validator.check(order); } catch (ValidationException ex) { log.warn(\"invalid\", ex); throw ex; } billingClient.charge(order.total() + fee); order.setStatus(PAID); orderRepository.save(order); }".replace(/ \}$/u, "")]);
    const whole = planStructureMap(type, SOURCE, ["billing"], Number.MAX_SAFE_INTEGER, true);
    expect(whole.windows.filter(window => window.kind === "call" && window.member === "place").map(window => windowText(SOURCE, window)))
      .toEqual(["int fee = compute(order); try { validator.check(order); } catch (ValidationException ex) { log.warn(\"invalid\", ex); throw ex; } billingClient.charge(order.total() + fee); order.setStatus(PAID); orderRepository.save(order); }"]);
  });
});

// ---------------------------------------------------------------------------
// TL_EFF_MAP_ANSWER_FIRST (2026-10-23): the members whose whole bodies are the
// core of an answer-first map, the planner option that serves exactly them, and
// the call texts the reply's facts name. The wiring is mapAnswerFirst.spec.ts /
// t03AnswerFirst.spec.ts; the facts are answerFirstFacts.spec.ts.
// ---------------------------------------------------------------------------

const ENTRY_SOURCE = [
  "public class FulfillmentDesk {",
  "    private final BillingClient billingClient;",
  "    private final StockLedger stockLedger;",
  "    private final DeliveryService deliveryService;",
  "",
  "    public FulfillmentDesk(BillingClient billingClient, StockLedger stockLedger, DeliveryService deliveryService) {",
  "        billingClient.warm();",
  "        this.billingClient = billingClient;",
  "    }",
  "",
  "    public void refundAndRecall(Order order) {",
  "        billingClient.refund(order.id());",
  "        deliveryService.recall(order.id());",
  "    }",
  "",
  "    public void open(Order order) {",
  "        stockLedger.reserve(order.sku());",
  "        billingClient.charge(order.total());",
  "        deliveryService.dispatch(order.id());",
  "    }",
  "",
  "    public void reopen(Order order) {",
  "        stockLedger.reserve(order.sku());",
  "        billingClient.charge(order.total());",
  "        deliveryService.dispatch(order.id());",
  "    }",
  "",
  "    private void note(Order order) {",
  "        // billingClient.charge(order) is mentioned here, in a comment",
  "        log.info(\"stockLedger.reserve( is mentioned here, in a message\");",
  "    }",
  "",
  "    private void viaHelper(Order order) {",
  "        open(order);",
  "    }",
  "",
  "    public record Receipt(long id) {}",
  "}",
];

describe("directConcernMembers — the concerns each member's own body invokes", () => {
  it("a member invokes a concern by a call in its comment- and string-masked body; a constructor, a nested type, a helper-only caller and a mention in a comment or a message do not", async () => {
    const type = await deskType(ENTRY_SOURCE);
    const direct = directConcernMembers(type, ENTRY_SOURCE, ["billing", "stock", "delivery"]);
    const byName = new Map([...direct].map(([member, found]) => [member.name, [...found].sort()]));
    expect(byName).toEqual(new Map([
      ["refundAndRecall", ["billing", "delivery"]],
      ["open", ["billing", "delivery", "stock"]],
      ["reopen", ["billing", "delivery", "stock"]],
    ]));
    expect([...direct.keys()].map(member => member.name), "source order").toEqual(["refundAndRecall", "open", "reopen"]);
  });

  it("no terms, and terms nothing invokes, find no member; the words are read case-insensitively and once", async () => {
    const type = await deskType(ENTRY_SOURCE);
    expect(directConcernMembers(type, ENTRY_SOURCE, []).size).toBe(0);
    expect(directConcernMembers(type, ENTRY_SOURCE, ["absent"]).size).toBe(0);
    const found = [...directConcernMembers(type, ENTRY_SOURCE, ["Billing", "BILLING", "billing"]).values()];
    expect(found.every(set => set.size === 1 && set.has("billing"))).toBe(true);
  });
});

describe("coverMembers — the entry point first, then what it leaves", () => {
  const names = (members: readonly StructureMapMember[]): string[] => members.map(member => member.name);

  it("the member that invokes the most named concerns is the entry point; the earlier of two that tie", async () => {
    const type = await deskType(ENTRY_SOURCE);
    // open and reopen both invoke all three; refundAndRecall invokes two. open is earlier.
    expect(names(coverMembers(type, ENTRY_SOURCE, ["billing", "stock", "delivery"]))).toEqual(["open"]);
    // Two of the three words: refundAndRecall is the earliest of the three that invoke both billing and delivery.
    expect(names(coverMembers(type, ENTRY_SOURCE, ["billing", "delivery"]))).toEqual(["refundAndRecall"]);
  });

  it("adds, while a concern is still unaccounted for, the member that accounts for most of what is left, and returns the cover in source order", async () => {
    const source = [
      "public class FulfillmentDesk {",
      "    public void late(Order order) {",
      "        auditTrail.record(order);",
      "    }",
      "",
      "    public void entry(Order order) {",
      "        billingClient.charge(order.total());",
      "        stockLedger.reserve(order.sku());",
      "    }",
      "",
      "    public void other(Order order) {",
      "        billingClient.refund(order.id());",
      "    }",
      "",
      "    public void tail(Order order) {",
      "        deliveryService.dispatch(order.id());",
      "        auditTrail.flush();",
      "    }",
      "}",
    ];
    const type = await deskType(source);
    // entry accounts for billing and stock; delivery and audit are left: tail invokes both, late only audit.
    const cover = coverMembers(type, source, ["billing", "stock", "delivery", "audit"]);
    expect(names(cover)).toEqual(["entry", "tail"]);
    // A word nothing invokes does not force a member into the cover ...
    expect(names(coverMembers(type, source, ["billing", "stock", "absent"]))).toEqual(["entry"]);
    // ... and a word only a smaller member invokes does: "refund" is other()'s call.
    expect(names(coverMembers(type, source, ["billing", "stock", "refund"]))).toEqual(["entry", "other"]);
  });

  it("among members that account for the same left-over word, the smaller body is taken, then the earlier", async () => {
    const source = [
      "public class FulfillmentDesk {",
      "    public void entry(Order order) {",
      "        billingClient.charge(order.total());",
      "    }",
      "",
      "    public void bigDelivery(Order order) {",
      "        int a = 1;",
      "        int b = 2;",
      "        int c = 3;",
      "        deliveryService.dispatch(order.id());",
      "    }",
      "",
      "    public void recallOne(Order order) {",
      "        deliveryService.recall(order.id());",
      "    }",
      "",
      "    public void recallTwo(Order order) {",
      "        deliveryService.recall(order.id());",
      "    }",
      "}",
    ];
    const type = await deskType(source);
    // bigDelivery is the earliest; recallOne and recallTwo are smaller and the same size: the earlier of the two.
    expect(names(coverMembers(type, source, ["billing", "delivery"]))).toEqual(["entry", "recallOne"]);
    // A smaller body that comes later still wins over a larger one that comes first.
    const swapped = source.map(line => line.replace("recallOne", "recallA").replace("recallTwo", "recallB"));
    expect(names(coverMembers(await deskType(swapped), swapped, ["billing", "delivery"]))).toEqual(["entry", "recallA"]);
  });

  it(`a cover of more than ${STRUCTURE_MAP_COVER_MAX_MEMBERS} members is no cover: [] (or the larger bound the caller passes)`, async () => {
    const source = [
      "public class FulfillmentDesk {",
      "    public void a(Order order) {",
      "        billingClient.charge(order);",
      "    }",
      "    public void b(Order order) {",
      "        stockLedger.reserve(order);",
      "    }",
      "    public void c(Order order) {",
      "        deliveryService.dispatch(order);",
      "    }",
      "    public void d(Order order) {",
      "        auditTrail.record(order);",
      "    }",
      "}",
    ];
    const type = await deskType(source);
    const terms = ["billing", "stock", "delivery", "audit"];
    expect(coverMembers(type, source, terms)).toEqual([]);
    expect(names(coverMembers(type, source, terms, 4))).toEqual(["a", "b", "c", "d"]);
    expect(names(coverMembers(type, source, terms.slice(0, 3)))).toEqual(["a", "b", "c"]);
  });

  it("a member whose body is on its signature line has no body of its own to serve: it is never a direct member", async () => {
    const source = [
      "public class FulfillmentDesk {",
      "    public void a(Order order) { billingClient.charge(order); }",
      "    public void b(Order order) {",
      "        billingClient.refund(order);",
      "    }",
      "    public void c(Order order) {",
      "        log(order);",
      "    }",
      "}",
    ];
    const type = await deskType(source);
    expect([...directConcernMembers(type, source, ["billing"]).keys()].map(member => member.name)).toEqual(["b"]);
  });

  it("no direct member, or no terms, is no cover", async () => {
    const type = await deskType(ENTRY_SOURCE);
    expect(coverMembers(type, ENTRY_SOURCE, [])).toEqual([]);
    expect(coverMembers(type, ENTRY_SOURCE, ["absent"])).toEqual([]);
    // viaHelper only calls open(): the helper is the cover's business, not a direct member.
    expect(names(coverMembers(type, ENTRY_SOURCE, ["billing", "stock", "delivery"]))).not.toContain("viaHelper");
  });
});

describe("concernMembers — the members a map would owe", () => {
  it("every direct member that invokes a concern or calls a helper that does; never a constructor or a nested type", async () => {
    const type = await deskType(ENTRY_SOURCE);
    expect(concernMembers(type, ENTRY_SOURCE, ["billing", "stock", "delivery"]).map(member => member.name))
      .toEqual(["refundAndRecall", "open", "reopen", "viaHelper"]);
    const desk = await deskType(DESK_SOURCE);
    expect(concernMembers(desk, DESK_SOURCE, ["billing", "stock"]).map(member => member.name)).toEqual(["place", "cancel", "undo"]);
    expect(concernMembers(desk, DESK_SOURCE, []).length).toBe(0);
  });
});

describe("planStructureMap with a cover — the core and nothing else", () => {
  it("serves the doc, the header, every signature and the cover's whole body, and no other member's body", async () => {
    const type = await deskType(DESK_SOURCE);
    const terms = ["billing", "stock"];
    const cover = coverMembers(type, DESK_SOURCE, terms);
    expect(cover.map(member => member.name)).toEqual(["place"]);
    const plan = planStructureMap(type, DESK_SOURCE, terms, Number.MAX_SAFE_INTEGER, true, { cover });
    expect(plan.windows.map(window => [window.kind, window.member])).toEqual([
      ["doc", "FulfillmentDesk"], ["header", "FulfillmentDesk"],
      ["signature", "place"], ["call", "place"],
      ["signature", "cancel"], ["signature", "undo"], ["signature", "audit"], ["signature", "Receipt"],
    ]);
    const body = plan.windows.find(window => window.kind === "call")!;
    expect(windowText(DESK_SOURCE, body)).toBe("validate(order); stockLedger.reserve(order.sku()); billingClient.charge(order.total()); audit(order); }");
    // Everything else of the type is owed exactly once.
    const count = new Map<number, number>();
    for (const span of [...plan.windows, ...plan.remaining]) for (let line = span.start; line <= span.end; line += 1) count.set(line, (count.get(line) ?? 0) + 1);
    for (let line = type.start; line <= type.end; line += 1) expect(count.get(line), `line ${line}`).toBe(1);
    // The ordinary plan serves the other concern members' bodies too.
    const ordinary = planStructureMap(type, DESK_SOURCE, terms, Number.MAX_SAFE_INTEGER, true);
    expect(ordinary.windows.filter(window => window.kind === "call").map(window => window.member)).toEqual(["place", "cancel", "undo"]);
    expect(plan.bytes).toBeLessThan(ordinary.bytes);
  });

  it("takes a cover body whole or not at all: under a budget the body does not fit, it is owed, never a prefix", async () => {
    const type = await deskType(DESK_SOURCE);
    const terms = ["billing", "stock"];
    const cover = coverMembers(type, DESK_SOURCE, terms);
    const full = planStructureMap(type, DESK_SOURCE, terms, Number.MAX_SAFE_INTEGER, true, { cover });
    const outline = planStructureMap(type, DESK_SOURCE, terms, Number.MAX_SAFE_INTEGER, true, { cover: [] });
    const tight = planStructureMap(type, DESK_SOURCE, terms, full.bytes - 1, true, { cover });
    expect(tight.windows.some(window => window.kind === "call"), "no prefix of the body").toBe(false);
    expect(tight.windows).toEqual(outline.windows);
    expect(tight.bytes).toBe(outline.bytes);
    const body = full.windows.find(window => window.kind === "call")!;
    expect(tight.remaining.some(span => span.start <= body.start && span.end >= body.end), "the whole body is owed").toBe(true);
    expect(planStructureMap(type, DESK_SOURCE, terms, full.bytes, true, { cover }).windows.some(window => window.kind === "call")).toBe(true);
  });

  it("an empty cover is the outline alone; no option is today's plan", async () => {
    const type = await deskType(DESK_SOURCE);
    const terms = ["billing", "stock"];
    const outline = planStructureMap(type, DESK_SOURCE, terms, Number.MAX_SAFE_INTEGER, true, { cover: [] });
    expect(outline.windows.some(window => window.kind === "call")).toBe(false);
    expect(planStructureMap(type, DESK_SOURCE, terms, undefined, true, {})).toEqual(planStructureMap(type, DESK_SOURCE, terms));
    expect(planStructureMap(type, DESK_SOURCE, terms, undefined, true, { constructorsLast: true })).toEqual(planStructureMap(type, DESK_SOURCE, terms));
  });

  it("constructorsLast ends the header before the first constructor and serves each constructor as a signature stub; its body is owed", async () => {
    const type = await deskType(DESK_SOURCE);
    const terms = ["billing", "stock"];
    const cover = coverMembers(type, DESK_SOURCE, terms);
    const kept = planStructureMap(type, DESK_SOURCE, terms, Number.MAX_SAFE_INTEGER, true, { cover });
    const last = planStructureMap(type, DESK_SOURCE, terms, Number.MAX_SAFE_INTEGER, true, { cover, constructorsLast: true });
    const constructor = type.members.find(member => member.constructor)!;
    expect(windowText(DESK_SOURCE, kept.windows.find(window => window.kind === "header")!)).toContain("this.stockLedger = stockLedger;");
    const header = last.windows.find(window => window.kind === "header")!;
    expect(header.end).toBe(constructor.start - 1);
    expect(windowText(DESK_SOURCE, header)).not.toContain("this.stockLedger = stockLedger;");
    const stub = last.windows.find(window => window.kind === "signature" && window.member === "FulfillmentDesk")!;
    expect(windowText(DESK_SOURCE, stub)).toBe("public FulfillmentDesk(BillingClient billingClient, StockLedger stockLedger) {");
    expect(last.remaining.some(span => span.start <= constructor.signatureEnd + 1 && span.end >= constructor.end - 1), "the constructor's body is owed").toBe(true);
    expect(last.bytes).toBeLessThan(kept.bytes);
  });
});

describe("concernCallsOnLine — the calls a line makes on a named concern", () => {
  it.each([
    ["        paymentService.refund(order.getPaymentId());", ["payment"], ["paymentService.refund"]],
    ["        this.paymentService.charge(x);", ["payment"], ["paymentService.charge"]],
    ["        BigDecimal fee = pricingService.shipping(items, to);", ["shipping"], ["pricingService.shipping"]],
    ["        x = req.method().paymentKind();", ["payment"], [".paymentKind"]],
    ["        Shipping::quote(order);", ["shipping"], ["Shipping.quote"]],
    ["        inventoryService.release(a); inventoryService.release(b);", ["inventory"], ["inventoryService.release"]],
    ["        paymentService.charge(x); shippingService.voidLabel(y);", ["payment", "shipping"], ["paymentService.charge", "shippingService.voidLabel"]],
    ["        order.setPaymentId(order.getPaymentId());", ["payment"], []],
    ["        this.paymentService = paymentService;", ["payment"], []],
    ["        log.warn(\"paymentService.charge( failed\");", ["payment"], []],
  ] as const)("%j with %j -> %j", (line, terms, expected) => {
    expect(concernCallsOnLine(line, terms)).toEqual(expected);
  });
});

// ---------------------------------------------------------------------------
// 2026-10-23 (independent review F4): what the answer-first facts call a CONCERN CALL
// is a call that hangs from one of the type's collaborator fields — not a record
// accessor on a parameter that merely has the concern's name (T03's
// `req.paymentMethod()` in dryRunPlace, which read as "dryRunPlace calls payment").
// ---------------------------------------------------------------------------

/** The text each call of `code` makes, for the terms, as `concernCallMatches` reports it. */
const callsOf = (code: string, terms: readonly string[], collaborators?: ReadonlySet<string>): string[] =>
  concernCallMatches(code, terms, collaborators).map(entry => entry.call);

describe("concernCallMatches with collaborators — a call counts when it hangs from a collaborator field", () => {
  const FIELDS = new Set(["paymentService", "inventoryService", "shippingService", "billing", "stock", "delivery", "payment_client"]);
  const TERMS = ["payment", "inventory", "shipping", "billing", "stock", "delivery"];

  it.each([
    // the shape of T03's dryRunPlace: a record accessor on a parameter has the concern's name and is no call on the payment collaborator
    ["        if (req.paymentMethod() == null) {", []],
    ["        errors.add(\"payment_method_required: \" + req.paymentMethod());", []],
    ["        if (request.billingKind() == null) {", []],
    // a call on a local, on another object's field, on a static, on this
    ["        var gateway = order.paymentGateway(); gateway.charge(total);", []],
    ["        order.paymentService.refund(order.id());", []],
    ["        PaymentGateway.charge(order.total());", []],
    ["        Shipping::quote(order);", []],
    ["        this.paymentMethod();", []],
    ["        new PaymentService().refund(id);", []],
    // a call on a collaborator field, however it is spelled
    ["        paymentService.refund(order.getPaymentId());", ["paymentService.refund"]],
    ["        this.paymentService.refund(order.getPaymentId());", ["paymentService.refund"]],
    ["        this . paymentService . refund(id);", ["paymentService.refund"]],
    ["        inventoryService.release(item.getSku(), 0);", ["inventoryService.release"]],
    // …a member named for the concern on a collaborator counts, as it always has (`pricingService.shipping`)
    ["        fee = this.pricingService.shipping(items, to);", []],
    // a chain rooted at one: the first call of the chain carries the concern's name
    ["        paymentService.gateway().charge(order);", ["paymentService.gateway"]],
    ["        this.shippingService.carrier().voidLabel(ref);", ["shippingService.carrier"]],
    ["        stock.lanes()[0].reserve(sku);", ["stock.lanes"]],
    ["        this.stock.reserve(sku); req.stockLevel();", ["stock.reserve"]],
    // Kotlin / TypeScript / Python / C++ spellings
    ["        billing.charge(order.total)", ["billing.charge"]],
    ["        this.billing.charge(order.total);", ["billing.charge"]],
    ["        request.paymentMethod();", []],
    ["        self.payment_client.charge(order)", ["payment_client.charge"]],
    ["        request.payment_method()", []],
    ["        this->billing->charge(order);", ["billing.charge"]],
  ] as const)("%j -> %j", (line, expected) => {
    expect(callsOf(line, TERMS, FIELDS)).toEqual([...expected]);
  });

  it("the collaborator rule is an addition: without it every named call counts, as before", () => {
    expect(callsOf("        if (req.paymentMethod() == null) {", TERMS)).toEqual(["req.paymentMethod"]);
    expect(callsOf("        order.paymentService.refund(order.id());", TERMS)).toEqual(["paymentService.refund"]);
    expect(callsOf("        PaymentGateway.charge(order.total());", TERMS)).toEqual(["PaymentGateway.charge"]);
  });

  it("reports where each call starts, as the index of its receiver or of its dot", () => {
    const line = "    this.stock.reserve(sku); req.stockLevel(); billing.charge(x);";
    expect(concernCallMatches(line, TERMS, FIELDS)).toEqual([
      { call: "stock.reserve", index: line.indexOf("stock.reserve") },
      { call: "billing.charge", index: line.indexOf("billing.charge") },
    ]);
  });
});

/** A type parsed from `source` in `lang`, named FulfillmentDesk. */
async function deskTypeIn(lang: string, extension: string, source: readonly string[]): Promise<StructureMapType> {
  const symbols = await collectSymbols(source.join("\n"), lang, {});
  const type = structureMapTypeOf(symbols, `src/FulfillmentDesk.${extension}`, "FulfillmentDesk", 1, source.length);
  expect(type, JSON.stringify(symbols.map((entry) => [entry.name, entry.kind, entry.startLine, entry.endLine]))).toBeDefined();
  return type!;
}

describe("collaborator-rooted concern members — a record accessor makes no member a concern member", () => {
  const TERMS = ["billing", "stock", "delivery"];
  const JAVA = [
    "public class FulfillmentDesk {",
    "    private final BillingClient billingClient;",
    "    private final StockLedger stockLedger;",
    "    private final DeliveryService deliveryService;",
    "",
    "    public FulfillmentDesk(BillingClient billingClient, StockLedger stockLedger, DeliveryService deliveryService) {",
    "        this.billingClient = billingClient;",
    "        this.stockLedger = stockLedger;",
    "        this.deliveryService = deliveryService;",
    "    }",
    "",
    "    public void review(OrderRequest req) {",
    "        log(req.billingKind());",
    "        log(req.stockLevel());",
    "        log(req.deliveryDate());",
    "    }",
    "",
    "    public void open(Order order) {",
    "        stockLedger.reserve(order.sku());",
    "        billingClient.charge(order.total());",
    "    }",
    "",
    "    public void preview(OrderRequest req) {",
    "        Level level = stockLedger.get(req.sku());",
    "        if (req.billingKind() == null) {",
    "            log(level);",
    "        }",
    "    }",
    "",
    "    public void viaHelper(Order order) {",
    "        open(order);",
    "    }",
    "}",
  ];

  it("a member whose only 'calls' are accessors on a parameter is not a direct member, and is no entry point", async () => {
    const type = await deskTypeIn("java", "java", JAVA);
    const fields = collaboratorFields(type, JAVA);
    expect([...fields].sort()).toEqual(["billingClient", "deliveryService", "stockLedger"]);
    const names = (map: Map<StructureMapMember, Set<string>>): string[] => [...map.keys()].map(member => member.name);
    // loose: review "invokes" billing, stock and delivery by the names of the accessors, and out-ranks open
    expect(names(directConcernMembers(type, JAVA, TERMS))).toEqual(["review", "open", "preview"]);
    expect(coverMembers(type, JAVA, TERMS).map(member => member.name)).toEqual(["review"]);
    // strict: review calls nothing; preview calls stock only (its billingKind() is an accessor); open calls two
    expect(names(directConcernMembers(type, JAVA, TERMS, fields))).toEqual(["open", "preview"]);
    expect([...directConcernMembers(type, JAVA, TERMS, fields).get(type.members.find(member => member.name === "preview")!)!]).toEqual(["stock"]);
    // …and the entry point is open, which calls two collaborators, not review
    expect(coverMembers(type, JAVA, TERMS, undefined, fields).map(member => member.name)).toEqual(["open"]);
  });

  it("collaboratorConcernMembers: the direct members and the members that call one of them", async () => {
    const type = await deskTypeIn("java", "java", JAVA);
    const fields = collaboratorFields(type, JAVA);
    expect(concernMembers(type, JAVA, TERMS).map(member => member.name)).toEqual(["review", "open", "preview", "viaHelper"]);
    expect(collaboratorConcernMembers(type, JAVA, TERMS, fields).map(member => member.name)).toEqual(["open", "preview", "viaHelper"]);
    expect(collaboratorConcernMembers(type, JAVA, [], fields)).toEqual([]);
    // no collaborator the header shows: no member calls one
    expect(collaboratorConcernMembers(type, JAVA, TERMS, new Set())).toEqual([]);
  });

  it("the same in Kotlin and TypeScript", async () => {
    const kotlin = [
      "class FulfillmentDesk(",
      "    private val billing: Billing,",
      "    private val stock: Stock,",
      ") {",
      "    fun open(order: Order) {",
      "        stock.reserve(order.sku())",
      "        billing.charge(order.total())",
      "    }",
      "",
      "    fun preview(req: PlaceRequest) {",
      "        val level = stock.level(req.sku())",
      "        if (req.paymentMethod() == null) {",
      "            log(level)",
      "        }",
      "    }",
      "",
      "    fun review(req: PlaceRequest) {",
      "        log(req.billingKind())",
      "        log(req.stockLevel())",
      "    }",
      "}",
    ];
    const typescript = [
      "export class FulfillmentDesk {",
      "  constructor(private readonly billing: Billing, private readonly stock: Stock) {}",
      "",
      "  open(order: Order): void {",
      "    this.stock.reserve(order.sku);",
      "    this.billing.charge(order.total);",
      "  }",
      "",
      "  preview(request: PlaceRequest): void {",
      "    const level = this.stock.level(request.sku);",
      "    if (request.paymentMethod() === null) {",
      "      log(level);",
      "    }",
      "  }",
      "",
      "  review(request: PlaceRequest): void {",
      "    log(request.billingKind());",
      "    log(request.stockLevel());",
      "  }",
      "}",
    ];
    for (const [lang, extension, source] of [["kotlin", "kt", kotlin], ["typescript", "ts", typescript]] as const) {
      const type = await deskTypeIn(lang, extension, source);
      const fields = collaboratorFields(type, source);
      expect([...fields].sort(), lang).toEqual(["billing", "stock"]);
      // loose: review's accessors have the concerns' names, and preview's req.paymentMethod() is a payment call
      expect(concernMembers(type, source, ["billing", "stock", "payment"]).map(member => member.name), lang).toEqual(["open", "preview", "review"]);
      // strict: review is not a concern member; preview is one for its stock call alone
      expect(collaboratorConcernMembers(type, source, ["billing", "stock", "payment"], fields).map(member => member.name), lang).toEqual(["open", "preview"]);
      const preview = type.members.find(member => member.name === "preview")!;
      expect([...directConcernMembers(type, source, ["billing", "stock", "payment"], fields).get(preview)!], lang).toEqual(["stock"]);
      expect([...directConcernMembers(type, source, ["billing", "stock", "payment"]).get(preview)!].sort(), lang).toEqual(["payment", "stock"]);
    }
  });
});

// 2026-10-24 (the generality audit): the rows of an owed member keep a bare assignment to a field of the
// type in the languages where a field needs no `this.` (Java, C#, Kotlin, C++), found between the type's
// members (memberRows.ts `typeFieldNames`), and nowhere else; a local of the same name is the local.
describe("planStructureMap — rows keep the writes of a type's own fields, named bare", () => {
  const calls = (type: StructureMapType, source: readonly string[], terms: readonly string[]): Array<[string, string]> =>
    planStructureMap(type, source, terms, Number.MAX_SAFE_INTEGER, true, { bodies: "rows" }).windows
      .filter(window => window.kind === "call").map((window): [string, string] => [window.member, windowText(source, window)]);

  it("Java: `status = …;` and `attempts++;` are rows; a method that declares its own `attempts` has the local", async () => {
    const source = [
      "public class FulfillmentDesk {",
      "    private final BillingClient billingClient;",
      "    private OrderStatus status = OrderStatus.OPEN;",
      "    private int attempts;",
      "",
      "    public void place(Order order) {",
      "        billingClient.charge(order.total());",
      "        long fee = order.total() * 2;",
      "        status = OrderStatus.BILLED;",
      "        attempts++;",
      "    }",
      "",
      "    public void cancel(Order order) {",
      "        billingClient.refund(order.id());",
      "        int attempts = 0;",
      "        attempts++;",
      "    }",
      "",
      "    public void idle() {",
      "    }",
      "}",
    ];
    const type = await deskTypeIn("java", "java", source);
    expect(calls(type, source, ["billing"])).toEqual([
      ["place", "billingClient.charge(order.total());"],
      ["place", "status = OrderStatus.BILLED; attempts++;"],
      ["cancel", "billingClient.refund(order.id());"],
    ]);
  });

  it("Java: a parameter named like a field is the parameter, and the local of a static initializer is no field", async () => {
    const source = [
      "public class FulfillmentDesk {",
      "    private final BillingClient billingClient;",
      "    private OrderStatus status = OrderStatus.OPEN;",
      "    private Order order;",
      "    private static final Map<String, Integer> LIMITS;",
      "    static {",
      "        Map<String, Integer> note = new HashMap<>();",
      "        LIMITS = note;",
      "    }",
      "",
      "    public void place(Order order) {",
      "        billingClient.charge(order.total());",
      "        order = normalize(order);",
      "        status = OrderStatus.BILLED;",
      "    }",
      "",
      "    public void review(String note) {",
      "        billingClient.audit(note);",
      "        note = trim(note);",
      "    }",
      "",
      "    public void idle() {",
      "    }",
      "}",
    ];
    const type = await deskTypeIn("java", "java", source);
    expect(calls(type, source, ["billing"])).toEqual([
      ["place", "billingClient.charge(order.total());"],
      ["place", "status = OrderStatus.BILLED;"],
      ["review", "billingClient.audit(note);"],
    ]);
  });

  it("C#: a property written bare is a row, and so are File.* and Directory.* calls", async () => {
    const source = [
      "public class FulfillmentDesk {",
      "    private readonly IBilling _billing;",
      "    public OrderStatus Status { get; set; }",
      "",
      "    public void Place(Order order) {",
      "        _billing.Charge(order.Total);",
      "        var fee = order.Total * 2;",
      "        Status = OrderStatus.Billed;",
      "        Directory.CreateDirectory(_dir);",
      "    }",
      "",
      "    public void Cancel(Order order) {",
      "        _billing.Refund(order.Id);",
      "    }",
      "",
      "    public void Idle() {",
      "    }",
      "}",
    ];
    const type = await deskTypeIn("csharp", "cs", source);
    expect(calls(type, source, ["billing"])).toEqual([
      ["Place", "_billing.Charge(order.Total);"],
      ["Place", "Status = OrderStatus.Billed; Directory.CreateDirectory(_dir);"],
      ["Cancel", "_billing.Refund(order.Id);"],
    ]);
  });

  it("Python and TypeScript: a bare name is never a field there, so `count = 5` stays a local", async () => {
    // (a Python signature runs through the first statement of the body)
    const python = [
      "class FulfillmentDesk:",
      "    count = 0",
      "",
      "    def place(self, order):",
      "        billing = self.billing",
      "        billing.charge(order)",
      "        count = 5",
      "        self.count = count",
      "",
      "    def cancel(self, order):",
      "        billing = self.billing",
      "        billing.refund(order)",
      "",
      "    def idle(self):",
      "        pass",
    ];
    const pyType = await deskTypeIn("python", "py", python);
    expect(calls(pyType, python, ["billing"])).toEqual([
      ["place", "billing.charge(order)"],
      ["place", "self.count = count"],
      ["cancel", "billing.refund(order)"],
    ]);
    const typescript = [
      "export class FulfillmentDesk {",
      "  private count = 0;",
      "  place(order: Order): void {",
      "    this.billing.charge(order);",
      "    count = 5;",
      "  }",
      "  cancel(order: Order): void {",
      "    this.billing.refund(order);",
      "  }",
      "  idle(): void {}",
      "}",
    ];
    const tsType = await deskTypeIn("typescript", "ts", typescript);
    expect(calls(tsType, typescript, ["billing"])).toEqual([
      ["place", "this.billing.charge(order);"],
      ["cancel", "this.billing.refund(order);"],
    ]);
  });
});
