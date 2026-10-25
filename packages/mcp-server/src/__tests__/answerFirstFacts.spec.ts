/**
 * answerFirstFacts.spec.ts — TL_EFF_MAP_ANSWER_FIRST (2026-10-23): the FACTS an
 * answer-first structure map states about what it left out
 * (features/task-pack/answerFirstFacts.ts), as pure units: which bodies were
 * not served, the loop guards inside them, the same-file usage index of the
 * constants declared in the served lines, the concern calls of each unserved
 * member, and the budget the advisory is composed under. The wiring (flag,
 * admission, certificate, the finished reply) is mapAnswerFirst.spec.ts and
 * t03AnswerFirst.spec.ts.
 */
import { describe, expect, it } from "vitest";

import {
  ANSWER_FIRST_MAX_CALLS_PER_MEMBER,
  ANSWER_FIRST_MAX_CONSTANTS,
  ANSWER_FIRST_MAX_CONSTANT_LINES,
  advisoryWireBytes,
  answerFirstFacts,
  classifyConstantUse,
  composeAnswerFirst,
  composeAnswerFirstAdvisory,
  constantUsageFacts,
  constantUses,
  formatConstantUses,
  renderConcernCalls,
  type AnswerFirstFacts,
  type ConstantUse,
  type FoundConcernCall,
} from "../features/task-pack/answerFirstFacts.js";
import { branchArms } from "../features/task-pack/branchArms.js";
import { maskCommentsAndStrings } from "../features/task-pack/sfCodeMask.js";
import {
  collaboratorFields,
  concernCallMatches,
  coverMembers,
  structureMapTypeOf,
  type StructureMapType,
} from "../features/task-pack/structureMap.js";
import { collectSymbols } from "../symbols/collectSymbols.js";

const DESK = [
  "public class FulfillmentDesk {",
  "    private static final String NOTE_FAILED = \"failed\";",
  "    private static final String NOTE_RESERVED = \"reserved\";",
  "    private static final String NOTE_PAID = \"paid\";",
  "    private static final int RETRIES = 3;",
  "    private final BillingClient billingClient;",
  "    private final StockLedger stockLedger;",
  "",
  "    public FulfillmentDesk(BillingClient billingClient, StockLedger stockLedger) {",
  "        this.billingClient = billingClient;",
  "        this.stockLedger = stockLedger;",
  "    }",
  "",
  "    public void place(Order order) {",
  "        stockLedger.reserve(order.sku());",
  "        order.setNote(NOTE_PAID);",
  "        billingClient.charge(order.total());",
  "    }",
  "",
  "    public void cancel(Order order) {",
  "        billingClient.refund(order.id());",
  "        // NOTE_RESERVED is mentioned in a comment, which is no reference",
  "        log.warn(\"NOTE_RESERVED is mentioned in a message, which is no reference\");",
  "        order.setNote(NOTE_FAILED);",
  "        stockLedger.release(order.sku());",
  "    }",
  "",
  "    private void retry(Order order) {",
  "        for (int attempt = 0; attempt < RETRIES; attempt++) {",
  "            order.setNote(NOTE_FAILED);",
  "            int other = NOTE_FAILED_EXTRA;",
  "            stockLedger.release(order.sku());",
  "        }",
  "    }",
  "",
  "    private void audit(Order order) {",
  "        log.info(order.id());",
  "    }",
  "}",
];

/** The 1-based number of the `nth` line containing `needle`. */
function at(lines: readonly string[], needle: string, nth = 1): number {
  let seen = 0;
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index]!.includes(needle)) {
      seen += 1;
      if (seen === nth) return index + 1;
    }
  }
  throw new Error(`no line ${nth} containing ${needle}`);
}

async function typeOf(lines: readonly string[], lang = "java", extension = "java"): Promise<StructureMapType> {
  const symbols = await collectSymbols(lines.join("\n"), lang, {});
  const type = structureMapTypeOf(symbols, `src/FulfillmentDesk.${extension}`, "FulfillmentDesk", 1, lines.length);
  expect(type, JSON.stringify(symbols.map(entry => [entry.name, entry.kind, entry.startLine, entry.endLine]))).toBeDefined();
  return type!;
}

/** The rows an answer-first page carries for DESK: the header, every signature stub, the cover whole. */
function servedRows(type: StructureMapType, cover: readonly string[]): Array<{ start: number; end: number }> {
  const rows = [{ start: type.signatureStart, end: at(DESK, "private final StockLedger") }];
  for (const member of type.members) {
    rows.push(cover.includes(member.name)
      ? { start: member.signatureStart, end: member.end }
      : { start: member.signatureStart, end: member.signatureEnd });
  }
  return rows.sort((left, right) => left.start - right.start);
}

describe("constantUsageFacts — where the constants declared in the served lines are referenced elsewhere", () => {
  it("names each constant's lines outside the served ones, and the constants nothing else mentions", async () => {
    const type = await typeOf(DESK);
    const served = servedRows(type, ["place"]);
    const facts = constantUsageFacts(type, DESK, served);
    const failed = [at(DESK, "order.setNote(NOTE_FAILED);"), at(DESK, "order.setNote(NOTE_FAILED);", 2)];
    expect(facts).toEqual({
      // NOTE_RESERVED is named in a comment and in a message only; NOTE_PAID is referenced by a served line only.
      unreferenced: ["NOTE_RESERVED"],
      referenced: [`NOTE_FAILED: set L${failed[0]} L${failed[1]}`, `RETRIES: read L${at(DESK, "attempt < RETRIES")}`],
    });
  });

  it("a name inside a comment or a message is no reference, and neither is a longer identifier that starts with it", async () => {
    const type = await typeOf(DESK);
    const facts = constantUsageFacts(type, DESK, servedRows(type, ["place"]));
    expect(facts.referenced.join(" ")).not.toContain(`L${at(DESK, "// NOTE_RESERVED")}`);
    expect(facts.referenced.join(" ")).not.toContain(`L${at(DESK, "NOTE_FAILED_EXTRA")}`);
    expect(facts.unreferenced).toContain("NOTE_RESERVED");
  });

  it("a constant referenced only by served lines needs no fact; serving more lines removes the references that fell inside", async () => {
    const type = await typeOf(DESK);
    const wide = constantUsageFacts(type, DESK, servedRows(type, ["place", "cancel"]));
    expect(wide.referenced).toEqual([
      `NOTE_FAILED: set L${at(DESK, "order.setNote(NOTE_FAILED);", 2)}`,
      `RETRIES: read L${at(DESK, "attempt < RETRIES")}`,
    ]);
    const everything = constantUsageFacts(type, DESK, [{ start: 1, end: DESK.length }]);
    expect(everything).toEqual({ unreferenced: ["NOTE_RESERVED"], referenced: [] });
  });

  it("only constants declared on a served line are indexed; a constant declared in an owed line is left out", async () => {
    const type = await typeOf(DESK);
    const onlyHeader = [{ start: type.signatureStart, end: at(DESK, "private static final String NOTE_PAID") }];
    const facts = constantUsageFacts(type, DESK, onlyHeader);
    // RETRIES is declared on the line after the served ones: it is indexed by no fact, though it is referenced.
    expect(facts.referenced.map(entry => entry.split(":")[0])).toEqual(["NOTE_FAILED", "NOTE_PAID"]);
    expect(facts.unreferenced).toEqual(["NOTE_RESERVED"]);
  });

  it(`indexes at most ${ANSWER_FIRST_MAX_CONSTANTS} constants and names at most ${ANSWER_FIRST_MAX_CONSTANT_LINES} lines of one, counting the rest`, async () => {
    const names = Array.from({ length: 12 }, (_, index) => `LIMIT_${String.fromCharCode(65 + index)}`);
    const source = [
      "public class FulfillmentDesk {",
      ...names.map(name => `    private static final int ${name} = 1;`),
      "    public void a(Order order) {",
      "        order.touch();",
      "    }",
      "    public void b(Order order) {",
      ...names.map(name => `        order.use(${name});`),
      "        order.use(LIMIT_A);",
      "        order.use(LIMIT_A);",
      "        order.use(LIMIT_A);",
      "        order.use(LIMIT_A);",
      "        order.use(LIMIT_A);",
      "    }",
      "    public void c(Order order) {",
      "        order.touch();",
      "    }",
      "}",
    ];
    const type = await typeOf(source);
    const served = [{ start: 1, end: at(source, "public void a") }];
    const facts = constantUsageFacts(type, source, served);
    expect(facts.unreferenced).toEqual([]);
    expect(facts.referenced).toHaveLength(ANSWER_FIRST_MAX_CONSTANTS);
    expect(facts.referenced[0]).toMatch(/^LIMIT_A: read L\d+ L\d+ L\d+ L\d+ \+2$/u);
    expect(facts.referenced[1]).toMatch(/^LIMIT_B: read L\d+$/u);
    // Unreferenced constants take the room first: the two lists together name at most the maximum.
    const unreferenced = [
      "public class FulfillmentDesk {",
      ...names.slice(0, 10).map(name => `    private static final int ${name} = 1;`),
      "    private static final int USED_ONE = 1;",
      "    public void a(Order order) {",
      "        order.touch();",
      "    }",
      "    public void b(Order order) {",
      "        order.use(USED_ONE);",
      "    }",
      "    public void c(Order order) {",
      "        order.touch();",
      "    }",
      "}",
    ];
    const typeTwo = await typeOf(unreferenced);
    const capped = constantUsageFacts(typeTwo, unreferenced, [{ start: 1, end: at(unreferenced, "public void a") }]);
    expect(capped.unreferenced).toHaveLength(ANSWER_FIRST_MAX_CONSTANTS);
    expect(capped.referenced).toEqual([]);
  });

  // Declarations by the modifiers each language puts in front of a constant.
  const HEADER_ONLY = (lines: readonly string[]): StructureMapType => ({
    path: "src/Desk",
    name: "Desk",
    start: 1,
    end: lines.length,
    signatureStart: 1,
    signatureEnd: 1,
    members: [],
  });
  it.each([
    ["Java", ["class Desk {", "    static final String NOTE_SENT = \"s\";", "    final static int LIMIT_ONE = 1;", "}"], ["NOTE_SENT", "LIMIT_ONE"]],
    ["C#", ["class Desk {", "    private const string NOTE_SENT = \"s\";", "    public static readonly int LIMIT_ONE = 1;", "}"], ["NOTE_SENT", "LIMIT_ONE"]],
    ["Kotlin", ["class Desk {", "    private const val NOTE_SENT = \"s\"", "    val LIMIT_ONE: Int = 1", "}"], ["NOTE_SENT", "LIMIT_ONE"]],
    ["TypeScript", ["class Desk {", "    static readonly NOTE_SENT = \"s\";", "    private readonly LIMIT_ONE: number = 1;", "}"], ["NOTE_SENT", "LIMIT_ONE"]],
    ["Python", ["class Desk:", "    NOTE_SENT = \"s\"", "    LIMIT_ONE: int = 1", ""], ["NOTE_SENT", "LIMIT_ONE"]],
  ] as const)("%s declarations are constants", (_language, source, expected) => {
    const lines = [...source];
    const facts = constantUsageFacts(HEADER_ONLY(lines), lines, [{ start: 1, end: lines.length }]);
    expect(facts.unreferenced).toEqual([...expected]);
  });

  it.each([
    ["a mixed-case field", "    private static final String noteSent = \"s\";"],
    ["an upper-case name of two letters", "    private static final int AB = 1;"],
    ["a non-constant upper-case field", "    private int COUNT_SO_FAR;"],
    ["a comparison", "    NOTE_SENT == other"],
    ["a logger", "    private static final Logger log = Logger.get();"],
  ])("%s is no constant", (_what, declaration) => {
    const lines = ["class Desk {", declaration, "}"];
    expect(constantUsageFacts(HEADER_ONLY(lines), lines, [{ start: 1, end: lines.length }])).toEqual({ unreferenced: [], referenced: [] });
  });
});

describe("answerFirstFacts — what the page leaves out", () => {
  const TERMS = ["billing", "stock"];

  it("names the cover's whole range and each unserved body (signature excluded); a member that calls no concern is not owed", async () => {
    const type = await typeOf(DESK);
    const cover = coverMembers(type, DESK, TERMS);
    expect(cover.map(member => member.name)).toEqual(["place"]);
    const facts = answerFirstFacts({ type, lines: DESK, terms: TERMS, cover, served: servedRows(type, ["place"]), guards: [] });
    expect(facts.served).toEqual([`place ${at(DESK, "public void place")}-${at(DESK, "billingClient.charge(order.total());") + 1}`]);
    expect(facts.notServed).toEqual([
      `cancel ${at(DESK, "public void cancel") + 1}-${at(DESK, "stockLedger.release(order.sku());") + 1}`,
      `retry ${at(DESK, "private void retry") + 1}-${at(DESK, "private void retry") + 6}`,
    ]);
    expect(facts.notServed.join(" ")).not.toContain("audit");
  });

  it("a member whose code the page serves in full is not named as unserved", async () => {
    const type = await typeOf(DESK);
    const cover = coverMembers(type, DESK, TERMS);
    const facts = answerFirstFacts({ type, lines: DESK, terms: TERMS, cover, served: servedRows(type, ["place", "cancel"]), guards: [] });
    expect(facts.notServed.map(entry => entry.split(" ")[0])).toEqual(["retry"]);
    const none = answerFirstFacts({ type, lines: DESK, terms: TERMS, cover, served: [{ start: 1, end: DESK.length }], guards: [] });
    expect(none.notServed).toEqual([]);
    expect(none.calls).toEqual([]);
  });

  it("the loop-guard notes inside the unserved bodies ride in source order; one in the cover or outside any body does not", async () => {
    const type = await typeOf(DESK);
    const cover = coverMembers(type, DESK, TERMS);
    const loop = at(DESK, "for (int attempt");
    const facts = answerFirstFacts({
      type, lines: DESK, terms: TERMS, cover, served: servedRows(type, ["place"]),
      guards: [
        { firstLine: loop, lastLine: loop + 4, text: "retry guard" },
        { firstLine: at(DESK, "public void place") + 1, lastLine: at(DESK, "public void place") + 2, text: "in the cover" },
        { firstLine: at(DESK, "private static final String NOTE_FAILED"), lastLine: at(DESK, "private static final String NOTE_FAILED"), text: "in the header" },
        { firstLine: at(DESK, "order.setNote(NOTE_FAILED);"), lastLine: at(DESK, "order.setNote(NOTE_FAILED);"), text: "cancel guard" },
        { firstLine: loop + 1, lastLine: loop + 9, text: "starts in a body, ends beyond it" },
      ],
    });
    expect(facts.guards).toEqual(["cancel guard", "retry guard"]);
  });

  it("lists the concern calls of each unserved member, in source order, with the line of each; a call in a comment or a message is none", async () => {
    const type = await typeOf(DESK);
    const cover = coverMembers(type, DESK, TERMS);
    const facts = answerFirstFacts({ type, lines: DESK, terms: TERMS, cover, served: servedRows(type, ["place"]), guards: [] });
    expect(facts.calls).toEqual([
      `cancel billingClient.refund L${at(DESK, "billingClient.refund")}, stockLedger.release L${at(DESK, "stockLedger.release", 1)}`,
      `retry stockLedger.release L${at(DESK, "stockLedger.release", 2)}`,
    ]);
  });

  it(`names at most ${ANSWER_FIRST_MAX_CALLS_PER_MEMBER} calls of one member and counts the rest`, async () => {
    const source = [
      "public class FulfillmentDesk {",
      "    public void a(Order order) {",
      "        billingClient.charge(order);",
      "    }",
      "    public void b(Order order) {",
      ...Array.from({ length: 11 }, (_, index) => `        stockLedger.step${index}(order);`),
      "    }",
      "    public void c(Order order) {",
      "        order.touch();",
      "    }",
      "}",
    ];
    const type = await typeOf(source);
    const cover = coverMembers(type, source, TERMS);
    expect(cover.map(member => member.name)).toEqual(["a", "b"]);
    const facts = answerFirstFacts({ type, lines: source, terms: TERMS, cover: [cover[0]!], served: [{ start: 1, end: 4 }], guards: [] });
    expect(facts.calls).toHaveLength(1);
    expect(facts.calls[0]!.startsWith("b stockLedger.step0 L6, ")).toBe(true);
    expect(facts.calls[0]!.endsWith(`, +${11 - ANSWER_FIRST_MAX_CALLS_PER_MEMBER}`)).toBe(true);
    expect(facts.calls[0]!.split(", ")).toHaveLength(ANSWER_FIRST_MAX_CALLS_PER_MEMBER + 1);
  });

  it("carries the constant index of the served lines", async () => {
    const type = await typeOf(DESK);
    const cover = coverMembers(type, DESK, TERMS);
    const served = servedRows(type, ["place"]);
    const facts = answerFirstFacts({ type, lines: DESK, terms: TERMS, cover, served, guards: [] });
    const usage = constantUsageFacts(type, DESK, served);
    expect(facts.unreferencedConstants).toEqual(usage.unreferenced);
    expect(facts.referencedConstants).toEqual(usage.referenced);
  });
});

// ---------------------------------------------------------------------------
// 2026-10-23, the coordinator's refinements (rubric O9 / DQ-F): a use of a constant is a
// `set` or a `read`, and the calls of a member that are alternatives are marked as such.
// ---------------------------------------------------------------------------

/** How the first (or `nth`) occurrence of the constant `NOTE` in `source` is used. */
function useOf(source: string, nth = 1): ConstantUse {
  const masked = maskCommentsAndStrings(source);
  const hit = [...masked.matchAll(/(?<![\w$])NOTE(?![\w$])/gu)][nth - 1];
  if (hit === undefined) throw new Error(`no ${nth}th NOTE in ${source}`);
  return classifyConstantUse(masked, hit.index!, hit.index! + "NOTE".length);
}

describe("classifyConstantUse — `set` stores the constant's value, `read` is every other use (lexical)", () => {
  it.each([
    // the argument of a setter-style call, however it is spelled, wherever it stands in the arguments
    ["order.setStatusNote(NOTE);"],
    ["this.setStatusNote(NOTE);"],
    ["setStatusNote(NOTE);"],
    ["if (shipped) order.setStatusNote(NOTE);"],
    ["order.setStatusNote(flag ? NOTE : OTHER);"],
    ["order.setStatusNote(prefix + NOTE);"],
    ["order.setStatusNote((String) NOTE);"],
    ["order.setStatusNote(\n        NOTE);"],
    ["order.setPair(first, NOTE);"],
    ["order.set_status_note(NOTE)"],
    ["list.forEach(o -> o.setStatusNote(NOTE));"],
    // the whole right-hand side of an assignment to a field or a local
    ["this.note = NOTE;"],
    ["this.note = OrderDesk.NOTE;"],
    ["note = this.NOTE;"],
    ["note = a.b.NOTE;"],
    ["String note = NOTE;"],
    ["note = NOTE;"],
    ["note += NOTE;"],
    ["note = NOTE\nnext();"],
    ["order.note = NOTE\n"],
    ["list.forEach(o -> { o.note = NOTE; });"],
    // a ternary arm or an operand in a setter's arguments is the value stored; only a comparison or a test of the constant is not
    ["order.setNote(a == b ? NOTE : c);"],
    ["order.setNote(a ? NOTE : b);"],
    ["order.setNote(a ? b : NOTE);"],
    ["order.setNote(NOTE + suffix);"],
    ["order.setMask(1 << NOTE);"],
    ["setHandler(x -> NOTE);"],
    ["return order.setStatusNote(NOTE);"],
  ])("set: %j", (source) => {
    expect(useOf(source)).toBe("set");
  });

  it.each([
    // a receiver, an element, a method reference
    ["if (NOTE.equals(x)) { y(); }"],
    ["list.stream().filter(o -> NOTE.equals(o.getStatusNote())).count();"],
    ["x = foo().NOTE;"],
    ["x = NOTE.length();"],
    ["x = NOTE[0];"],
    ["f(NOTE::get);"],
    // a comparison, a header, a switch label, a return
    ["if (x == NOTE) { y(); }"],
    ["boolean ok = x == NOTE;"],
    ["boolean ok = x >= NOTE;"],
    ["boolean ok = x != NOTE;"],
    ["while (i < NOTE) { i++; }"],
    ["for (int i = 0; i <= NOTE; i++) { }"],
    ["if (a\n        && b == NOTE) { }"],
    ["switch (x) { case NOTE: y(); }"],
    ["return NOTE;"],
    // an argument of a call that is not a setter
    ["log.warn(\"failed {}\", NOTE);"],
    ["map.put(\"k\", NOTE);"],
    ["map.get(NOTE);"],
    ["foo(NOTE);"],
    ["Instant cutoff = Instant.now().minus(NOTE);"],
    ["new Ticket(order, NOTE);"],
    ["@Foo(NOTE) void m() {}"],
    ["auditTransition(a, b,\n        \"max=\" + NOTE);"],
    ["settle(NOTE);"],
    ["set(NOTE);"],
    ["setTimeout(tick, NOTE);"],
    ["window.setInterval(tick, NOTE);"],
    // a setter's argument that is itself the argument of another call, or a receiver
    ["order.setStatusNote(compute(NOTE));"],
    ["order.setStatusNote(NOTE.trim());"],
    ["order.setStatusNote(map.get(NOTE));"],
    // F5: inside a setter's arguments the constant is only COMPARED or TESTED, not stored
    ["order.setNote(NOTE == a ? b : c);"],
    ["order.setNote(NOTE != null ? b : c);"],
    ["order.setNote(NOTE === a ? b : c);"],
    ["order.setNote(a == NOTE ? b : c);"],
    ["order.setNote(a != NOTE ? b : c);"],
    ["order.setNote(a < NOTE ? b : c);"],
    ["order.setNote(a >= NOTE ? b : c);"],
    ["order.setNote(NOTE ? a : b);"],
    ["order.setNote(!NOTE);"],
    ["order.setNote(a && NOTE);"],
    ["order.setNote(NOTE || b);"],
    ["order.setNote(x instanceof NOTE);"],
    ["order.setNote((NOTE == a) ? b : c);"],
    // a value combined before it is stored, a ternary arm, a continued expression
    ["long ms = NOTE * (1L << n);"],
    ["x = NOTE + suffix;"],
    ["x = cond ? NOTE : OTHER;"],
    ["String s = NOTE\n        + suffix;"],
  ])("read: %j", (source) => {
    expect(useOf(source)).toBe("read");
  });

  it.each([
    // F5: an assignment TO the constant is its initializer — part of the declaration, neither a use of its value nor a reference to it
    ["NOTE = other;"],
    ["this.NOTE = other;"],
    ["Desk.NOTE = other;"],
    ["    static {\n        NOTE = Collections.unmodifiableMap(t);\n    }"],
    ["NOTE\n        = other;"],
    ["NOTE += 1;"],
    ["NOTE <<= 2;"],
    ["NOTE >>>= 2;"],
    ["NOTE |= FLAG;"],
  ])("assigned: %j", (source) => {
    expect(useOf(source)).toBe("assigned");
  });

  it.each([
    // …and the comparisons and the arrow that look like one are not
    ["if (NOTE == other) { }", "read"],
    ["boolean b = NOTE <= other;", "read"],
    ["boolean b = NOTE >= other;", "read"],
    ["boolean b = NOTE != other;", "read"],
    ["boolean b = NOTE === other;", "read"],
    ["f(NOTE => 1);", "read"],
    ["x = NOTE;", "set"],
  ] as const)("not an assignment target: %j is a %s", (source, expected) => {
    expect(useOf(source)).toBe(expected);
  });

  it("reads the occurrence it is asked about: the second NOTE of a line is classified on its own", () => {
    expect(useOf("order.setStatusNote(NOTE); if (NOTE.equals(x)) { }", 1)).toBe("set");
    expect(useOf("order.setStatusNote(NOTE); if (NOTE.equals(x)) { }", 2)).toBe("read");
  });

  it("a name inside a string or a comment is masked and cannot be classified by what the string says", () => {
    // The masked line holds no NOTE; the one real use decides.
    expect(useOf("log.info(\"x = NOTE;\"); x = NOTE;")).toBe("set");
  });
});

describe("formatConstantUses — the set lines first, a bounded number of lines in all, each group counting what it leaves out", () => {
  it.each([
    [{ name: "N", set: [1, 2], read: [] }, "N: set L1 L2"],
    [{ name: "N", set: [], read: [1] }, "N: read L1"],
    [{ name: "N", set: [684, 778], read: [1394] }, "N: set L684 L778, read L1394"],
    [{ name: "N", set: [1, 2], read: [3, 4, 5] }, `N: set L1 L2, read L3 L4 +1`],
    [{ name: "N", set: [1, 2, 3, 4, 5, 6], read: [7] }, "N: set L1 L2 L3 L4 +2, read +1"],
    [{ name: "N", set: [], read: [1, 2, 3, 4, 5, 6] }, "N: read L1 L2 L3 L4 +2"],
  ])("%j", (uses, expected) => {
    expect(ANSWER_FIRST_MAX_CONSTANT_LINES).toBe(4);
    expect(formatConstantUses(uses)).toBe(expected);
  });
});

describe("constantUses — set and read lines of the constants declared in the served header", () => {
  const USES = [
    "public class FulfillmentDesk {",
    "    private static final String NOTE_FAILED = \"failed\";",
    "    private static final String NOTE_PAID = \"paid\";",
    "    private static final int LIMIT = 3;",
    "    private final BillingClient billingClient;",
    "    private final StockLedger stockLedger;",
    "",
    "    public FulfillmentDesk(BillingClient billingClient, StockLedger stockLedger) {",
    "        this.billingClient = billingClient;",
    "    }",
    "",
    "    public void place(Order order) {",
    "        billingClient.charge(order.total());",
    "        order.setNote(NOTE_PAID);",
    "    }",
    "",
    "    public void cancel(Order order) {",
    "        billingClient.refund(order.id());",
    "        order.setNote(NOTE_FAILED);",
    "        stockLedger.release(order.sku());",
    "    }",
    "",
    "    private void sweep(List<Order> orders) {",
    "        for (int attempt = 0; attempt < LIMIT; attempt++) {",
    "            orders.stream().filter(o -> NOTE_FAILED.equals(o.note())).forEach(o -> o.setNote(NOTE_FAILED));",
    "            String copy = NOTE_PAID;",
    "            stockLedger.release(copy);",
    "        }",
    "    }",
    "}",
  ];

  it("lists, per constant, the lines that store it and the lines that read it outside the served rows", async () => {
    const type = await typeOf(USES);
    const served = [{ start: 1, end: 9 }, ...type.members.map(member => ({ start: member.signatureStart, end: member.signatureEnd }))];
    const line = (text: string): number => at(USES, text);
    const stored = {
      cancel: line("order.setNote(NOTE_FAILED)"),
      sweep: line("o.setNote(NOTE_FAILED)"),
      paid: line("order.setNote(NOTE_PAID)"),
      copy: line("String copy = NOTE_PAID"),
    };
    expect(constantUses(type, USES, served)).toEqual({
      unreferenced: [],
      referenced: [
        // the sweep line both compares NOTE_FAILED (equals) and stores it (the forEach's setter): a line that stores counts as a store
        { name: "NOTE_FAILED", set: [stored.cancel, stored.sweep], read: [] },
        { name: "NOTE_PAID", set: [stored.paid, stored.copy], read: [] },
        { name: "LIMIT", set: [], read: [line("attempt < LIMIT")] },
      ],
    });
    expect(constantUsageFacts(type, USES, served).referenced).toEqual([
      `NOTE_FAILED: set L${stored.cancel} L${stored.sweep}`,
      `NOTE_PAID: set L${stored.paid} L${stored.copy}`,
      `LIMIT: read L${line("attempt < LIMIT")}`,
    ]);
  });

  it("an assignment TO a constant (its static initializer) is no use: not listed, and not a reference either", async () => {
    const source = [
      "public class FulfillmentDesk {",
      "    private static final Map<String, String> TABLE;",
      "    private static final String ONLY_INIT;",
      "    public void a(Order order) {",
      "        order.touch();",
      "    }",
      "    static {",
      "        TABLE = Collections.unmodifiableMap(m);",
      "        ONLY_INIT = compute();",
      "    }",
      "    public void b(Order order) {",
      "        TABLE.get(order.key());",
      "    }",
      "    public void c(Order order) {",
      "        order.touch();",
      "    }",
      "}",
    ];
    const type = await typeOf(source);
    const served = [{ start: 1, end: 3 }, ...type.members.map(member => ({ start: member.signatureStart, end: member.signatureEnd }))];
    const found = constantUses(type, source, served);
    // TABLE: the initializer (line 8) is left out, the lookup (line 12) is the one read; ONLY_INIT is mentioned by its initializer alone
    expect(found).toEqual({ unreferenced: ["ONLY_INIT"], referenced: [{ name: "TABLE", set: [], read: [12] }] });
  });

  it("a reading line stays a read when the same constant is stored on another line", async () => {
    const source = [
      "public class FulfillmentDesk {",
      "    private static final String NOTE_FAILED = \"failed\";",
      "    public void a(Order order) {",
      "        order.touch();",
      "    }",
      "    public void b(Order order) {",
      "        order.setNote(NOTE_FAILED);",
      "    }",
      "    public void c(Order order) {",
      "        if (NOTE_FAILED.equals(order.note())) { order.touch(); }",
      "    }",
      "}",
    ];
    const type = await typeOf(source);
    const found = constantUses(type, source, [{ start: 1, end: 3 }]);
    expect(found.referenced).toEqual([{ name: "NOTE_FAILED", set: [7], read: [10] }]);
    expect(constantUsageFacts(type, source, [{ start: 1, end: 3 }]).referenced).toEqual(["NOTE_FAILED: set L7, read L10"]);
  });
});

/** The concern calls of `source` as `answerFirstFacts` finds them (one entry per member is rendered by `renderConcernCalls`). */
function callsOf(source: string, terms: readonly string[] = ["billing", "stock", "delivery"], lang?: string): string {
  const masked = maskCommentsAndStrings(source);
  const maskedLines = masked.split("\n");
  const found: FoundConcernCall[] = [];
  let offset = 0;
  maskedLines.forEach((text, index) => {
    for (const match of concernCallMatches(text, terms)) found.push({ call: match.call, line: index + 1, offset: offset + match.index });
    offset += text.length + 1;
  });
  return renderConcernCalls(found, lang === "python" ? [] : branchArms(masked, source, 0, source.length));
}

describe("renderConcernCalls — calls in sequence are listed in order, alternatives are marked", () => {
  it("calls that run one after the other (each behind its own `if` without an `else`, or in a loop) carry no label and are joined by commas", () => {
    expect(callsOf(`
if (payment != null) {
    try { billingClient.refund(payment); } catch (RuntimeException ex) { log(ex); }
}
for (OrderItem item : items) {
    stockLedger.release(item.sku());
}
if (label != null) {
    deliveryService.voidLabel(label);
}`)).toBe("billingClient.refund L3, stockLedger.release L6, deliveryService.voidLabel L9");
  });

  it("the cases of one switch are alternatives: labelled with their case and joined by \" / \"", () => {
    expect(callsOf(`
switch (newState) {
    case FULFILLED:
        deliveryService.notifyFulfilled(orderId);
        break;
    case SHIPPED:
        order.setShippedAt(now);
        break;
    case DELIVERED:
        for (OrderItem item : items) { stockLedger.release(item.sku()); }
        break;
}`)).toBe("deliveryService.notifyFulfilled L4 [case FULFILLED] / stockLedger.release L10 [case DELIVERED]");
  });

  it("a call before the switch and a call after it are in sequence with the arms: no label, a comma", () => {
    expect(callsOf(`
billingClient.charge(total);
switch (event) {
    case FAILED:
        deliveryService.scheduleReship(id);
        break;
    case RETURNED:
        billingClient.refund(id);
        break;
}
stockLedger.release(sku);`)).toBe("billingClient.charge L2, deliveryService.scheduleReship L5 [case FAILED] / billingClient.refund L8 [case RETURNED], stockLedger.release L11");
  });

  it("the arms of an if / else if / else chain are alternatives too; an arm with no call of its own is not shown", () => {
    expect(callsOf(`
if (from == PAID) {
    billingClient.refund(id);
} else if (from == FULFILLED) {
    stockLedger.release(sku);
} else {
    log.warn("nothing");
}`)).toBe("billingClient.refund L3 [if from == PAID] / stockLedger.release L5 [else if from == FULFILLED]");
  });

  it("a call in an arm whose sibling arms have no call of the list is in sequence with the rest: no label", () => {
    expect(callsOf(`
billingClient.charge(total);
if (from == SHIPPED) {
    billingClient.refund(id);
} else {
    log.warn("skipped");
}`)).toBe("billingClient.charge L2, billingClient.refund L4");
  });

  it("an inner if/else under a case is told apart from its sibling by its own arm, behind the case when the cases differ", () => {
    expect(callsOf(`
switch (event) {
    case RETURNED:
        if (from == SHIPPED) {
            billingClient.refund(id);
        } else {
            stockLedger.release(sku);
        }
        break;
    case FAILED:
        deliveryService.scheduleReship(id);
}`)).toBe("billingClient.refund L5 [case RETURNED > if from == SHIPPED] / stockLedger.release L7 [case RETURNED > else] / deliveryService.scheduleReship L11 [case FAILED]");
  });

  it("a case that falls into the next makes no alternatives: the calls stay a sequence", () => {
    expect(callsOf(`
switch (event) {
    case A:
        billingClient.charge(id);
    case B:
        stockLedger.reserve(sku);
        break;
}`)).toBe("billingClient.charge L4, stockLedger.reserve L6");
  });

  it("two calls under the same arm are labelled alike and joined by a comma; the next arm's call after \" / \"", () => {
    expect(callsOf(`
switch (event) {
    case A:
        billingClient.charge(id);
        stockLedger.reserve(sku);
        break;
    case B:
        deliveryService.dispatch(id);
}`)).toBe("billingClient.charge L4 [case A], stockLedger.reserve L5 [case A] / deliveryService.dispatch L8 [case B]");
  });

  it("past the per-member bound the calls are counted and the marks still tell the shown ones from the hidden alternatives", () => {
    const body = Array.from({ length: 10 }, (_, i) => `    billingClient.step${i}(x);`).join("\n");
    const text = callsOf(`${body}\nswitch (e) {\n    case A: stockLedger.one(); break;\n    case B: stockLedger.two(); break;\n}`);
    expect(text.endsWith(", +4")).toBe(true);
    expect(text.split(", ")).toHaveLength(ANSWER_FIRST_MAX_CALLS_PER_MEMBER + 1);
    const hiddenAlternatives = callsOf(`switch (e) {\n    case A: ${Array.from({ length: 9 }, (_, i) => `billingClient.a${i}(x);`).join(" ")} break;\n    case B: stockLedger.two(); break;\n}`);
    expect(hiddenAlternatives).toMatch(/^billingClient\.a0 L2 \[case A\], billingClient\.a1 L2 \[case A\]/u);
    expect(hiddenAlternatives).toMatch(/, \+2$/u);
  });

  it("a language that marks blocks by indentation is not read: no arms, a plain sequence", () => {
    expect(callsOf("switch (x) { case A: billingClient.a(); break; case B: stockLedger.b(); }", ["billing", "stock"], "python")).toBe("billingClient.a L1, stockLedger.b L1");
  });
});

describe("answerFirstFacts — the call index of an unserved member that branches", () => {
  const BRANCHING = [
    "public class FulfillmentDesk {",
    "    private final BillingClient billingClient;",
    "    private final StockLedger stockLedger;",
    "",
    "    public FulfillmentDesk(BillingClient billingClient, StockLedger stockLedger) {",
    "        this.billingClient = billingClient;",
    "    }",
    "",
    "    public void place(Order order) {",
    "        stockLedger.reserve(order.sku());",
    "        billingClient.charge(order.total());",
    "    }",
    "",
    "    public void transition(Order order, Status to) {",
    "        switch (to) {",
    "            case FULFILLED:",
    "                billingClient.notifyFulfilled(order.id());",
    "                break;",
    "            case DELIVERED:",
    "                stockLedger.release(order.sku());",
    "                break;",
    "            default:",
    "                break;",
    "        }",
    "    }",
    "",
    "    public void cancel(Order order) {",
    "        if (order.paid()) {",
    "            billingClient.refund(order.id());",
    "        }",
    "        stockLedger.release(order.sku());",
    "    }",
    "}",
  ];

  it("marks the alternatives of a switch with their case and leaves a sequence plain", async () => {
    const type = await typeOf(BRANCHING);
    const cover = coverMembers(type, BRANCHING, ["billing", "stock"]);
    expect(cover.map(member => member.name)).toEqual(["place"]);
    const served = [{ start: 1, end: 7 }, ...type.members.map(member => ({ start: member.signatureStart, end: cover.includes(member) ? member.end : member.signatureEnd }))];
    const facts = answerFirstFacts({ type, lines: BRANCHING, terms: ["billing", "stock"], cover, served, guards: [], lang: "java" });
    expect(facts.calls).toEqual([
      `transition billingClient.notifyFulfilled L${at(BRANCHING, "billingClient.notifyFulfilled")} [case FULFILLED] / stockLedger.release L${at(BRANCHING, "stockLedger.release", 1)} [case DELIVERED]`,
      `cancel billingClient.refund L${at(BRANCHING, "billingClient.refund")}, stockLedger.release L${at(BRANCHING, "stockLedger.release", 2)}`,
    ]);
    const plain = answerFirstFacts({ type, lines: BRANCHING, terms: ["billing", "stock"], cover, served, guards: [], lang: "python" });
    expect(plain.calls[0]).toBe(`transition billingClient.notifyFulfilled L${at(BRANCHING, "billingClient.notifyFulfilled")}, stockLedger.release L${at(BRANCHING, "stockLedger.release", 1)}`);
  });
});

// ---------------------------------------------------------------------------
// 2026-10-23, independent review F4 and F6: what the facts call a concern call, and what
// they say of the members they do not name.
// ---------------------------------------------------------------------------

describe("answerFirstFacts — a concern call hangs from a collaborator field of the type", () => {
  // T03's dryRunPlace: one call on a collaborator and an accessor on the request that has the concern's name.
  const DRY_RUN = [
    "public class FulfillmentDesk {",
    "    private final InventoryService inventoryService;",
    "    private final PaymentService paymentService;",
    "",
    "    public FulfillmentDesk(InventoryService inventoryService, PaymentService paymentService) {",
    "        this.inventoryService = inventoryService;",
    "        this.paymentService = paymentService;",
    "    }",
    "",
    "    public void place(Order order) {",
    "        inventoryService.reserve(order.sku());",
    "        paymentService.charge(order.total());",
    "    }",
    "",
    "    public ValidationReport dryRun(PlaceRequest req) {",
    "        for (Line line : req.items()) {",
    "            Inventory inv = inventoryService.get(line.sku());",
    "        }",
    "        if (req.paymentMethod() == null) {",
    "            errors.add(\"payment_method_required\");",
    "        }",
    "        return report;",
    "    }",
    "",
    "    public void describe(PlaceRequest req) {",
    "        log(req.paymentMethod());",
    "        log(req.inventoryLevel());",
    "    }",
    "}",
  ];
  const input = async (collaborators?: ReadonlySet<string>) => {
    const type = await typeOf(DRY_RUN);
    const fields = collaborators ?? collaboratorFields(type, DRY_RUN);
    const terms = ["payment", "inventory"];
    const cover = coverMembers(type, DRY_RUN, terms, undefined, fields.size > 0 ? fields : undefined);
    const served = [{ start: 1, end: 8 }, ...type.members.map(member => ({ start: member.signatureStart, end: cover.includes(member) ? member.end : member.signatureEnd }))];
    return { type, terms, cover, served, fields };
  };

  it("the request's accessor is neither a call in the index nor a reason to list its member", async () => {
    const { type, terms, cover, served, fields } = await input();
    expect(cover.map(member => member.name)).toEqual(["place"]);
    expect([...fields].sort()).toEqual(["inventoryService", "paymentService"]);
    const facts = answerFirstFacts({ type, lines: DRY_RUN, terms, cover, served, guards: [], lang: "java", collaborators: fields });
    // dryRun calls inventory on a collaborator; describe calls nothing (two accessors named for the concerns)
    expect(facts.notServed.map(entry => entry.split(" ")[0])).toEqual(["dryRun"]);
    expect(facts.calls).toEqual([`dryRun inventoryService.get L${at(DRY_RUN, "inventoryService.get")}`]);
    expect(facts.concerns).toEqual(["payment", "inventory"]);
  });

  it("without the collaborators the map's own looser rule applies: the accessors count", async () => {
    const { type, terms, cover, served } = await input();
    const loose = answerFirstFacts({ type, lines: DRY_RUN, terms, cover, served, guards: [], lang: "java" });
    expect(loose.notServed.map(entry => entry.split(" ")[0])).toEqual(["dryRun", "describe"]);
    expect(loose.calls[0]).toBe(`dryRun inventoryService.get L${at(DRY_RUN, "inventoryService.get")}, req.paymentMethod L${at(DRY_RUN, "req.paymentMethod() == null")}`);
    // …and an empty set is the same as none: a header that shows no collaborator keeps the looser rule
    const empty = answerFirstFacts({ type, lines: DRY_RUN, terms, cover, served, guards: [], lang: "java", collaborators: new Set() });
    expect(empty.calls).toEqual(loose.calls);
  });

  it("the concerns named are those some member calls: a word of the request that no member calls is not one", async () => {
    const { type, cover, served, fields } = await input();
    const facts = answerFirstFacts({ type, lines: DRY_RUN, terms: ["payment", "slack", "inventory", "orchestrator"], cover, served, guards: [], lang: "java", collaborators: fields });
    expect(facts.concerns).toEqual(["payment", "inventory"]);
  });

  it("the same in TypeScript and Kotlin", async () => {
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
    for (const [lang, extension, source, level] of [["typescript", "ts", typescript, "this.stock.level"], ["kotlin", "kt", kotlin, "stock.level"]] as const) {
      const type = await typeOf(source, lang, extension);
      const fields = collaboratorFields(type, source);
      const terms = ["billing", "stock", "payment"];
      const cover = coverMembers(type, source, terms, undefined, fields);
      expect(cover.map(member => member.name), lang).toEqual(["open"]);
      const served = [{ start: 1, end: type.members[0]!.signatureStart - 1 }, ...type.members.map(member => ({ start: member.signatureStart, end: cover.includes(member) ? member.end : member.signatureEnd }))];
      const facts = answerFirstFacts({ type, lines: source, terms, cover, served, guards: [], lang, collaborators: fields });
      // preview calls stock on a collaborator and an accessor named payment on its parameter; review calls two accessors
      expect(facts.notServed.map(entry => entry.split(" ")[0]), lang).toEqual(["preview"]);
      expect(facts.calls, lang).toEqual([`preview stock.level L${at(source, level)}`]);
      expect(facts.concerns, lang).toEqual(["billing", "stock"]);
    }
  });
});

describe("answerFirstFacts — what is true of every member the lists do not name", () => {
  const SOURCE = [
    "public class FulfillmentDesk {",
    "    private final BillingClient billingClient;",
    "    private final StockLedger stockLedger;",
    "",
    "    public FulfillmentDesk(BillingClient billingClient, StockLedger stockLedger) {",
    "        this.billingClient = billingClient;",
    "        this.stockLedger = stockLedger;",
    "    }",
    "",
    "    public void place(Order order) {",
    "        stockLedger.reserve(order.sku());",
    "        billingClient.charge(order.total());",
    "    }",
    "",
    "    public void cancel(Order order) {",
    "        billingClient.refund(order.id());",
    "        stockLedger.release(order.sku());",
    "    }",
    "",
    "    private void audit(Order order) {",
    "        log.info(order.id());",
    "        log.info(order.total());",
    "    }",
    "",
    "    private Order require(long id) {",
    "        return repository.get(id);",
    "    }",
    "",
    ...["A", "B", "C", "D", "E"].flatMap(letter => ["", `    private void tidy${letter}(Order order) {`, `        log.info(order.id());`, `        log.info(order.total());`, "    }"]),
    "",
    "    public record Receipt(long id) {}",
    "}",
  ];
  const facts = async (served: Array<{ start: number; end: number }>, cover = ["place"]) => {
    const type = await typeOf(SOURCE);
    const covered = type.members.filter(member => cover.includes(member.name));
    return answerFirstFacts({ type, lines: SOURCE, terms: ["billing", "stock"], cover: covered, served, guards: [], lang: "java", collaborators: collaboratorFields(type, SOURCE) });
  };
  const stubs = async (): Promise<Array<{ start: number; end: number }>> => {
    const type = await typeOf(SOURCE);
    return type.members.filter(member => member.name !== "place").map(member => ({ start: member.signatureStart, end: member.signatureEnd }));
  };

  it("when no body line of any other member is on the page: every other member is signature-only (the constructor and a body-less record included)", async () => {
    const served = [{ start: 1, end: 3 }, { start: at(SOURCE, "public void place"), end: at(SOURCE, "public void place") + 3 }, ...(await stubs())];
    const found = await facts(served);
    expect(found.others).toBe("every other member is signature-only");
    expect(found.notServed).toEqual([`cancel ${at(SOURCE, "public void cancel") + 1}-${at(SOURCE, "public void cancel") + 3}`]);
  });

  it("a body line that rode along in a served row makes its member an exception, named", async () => {
    // audit's first body line is inside a row that also holds its signature
    const served = [{ start: 1, end: 3 }, { start: at(SOURCE, "public void place"), end: at(SOURCE, "public void place") + 3 }, ...(await stubs()), { start: at(SOURCE, "private void audit"), end: at(SOURCE, "private void audit") + 1 }];
    expect((await facts(served)).others).toBe("every other member but audit is signature-only");
  });

  it("the constructor kept in the header is an exception too, and is called what it is", async () => {
    const served = [{ start: 1, end: at(SOURCE, "public void place") - 2 }, { start: at(SOURCE, "public void place"), end: at(SOURCE, "public void place") + 3 }, ...(await stubs())];
    expect((await facts(served)).others).toBe("every other member but the constructor is signature-only");
  });

  it("names three exceptions and counts the rest; says nothing when every other member has a body line on the page", async () => {
    const all = [{ start: 1, end: SOURCE.length }];
    expect((await facts(all)).others, "everything is served").toBe("");
    const near = [{ start: 1, end: at(SOURCE, "public void place") + 3 }, ...(await stubs()),
      { start: at(SOURCE, "public void cancel"), end: at(SOURCE, "public void cancel") + 2 },
      { start: at(SOURCE, "private void audit"), end: at(SOURCE, "private void audit") + 2 },
      { start: at(SOURCE, "private Order require"), end: at(SOURCE, "private Order require") + 2 },
    ];
    // the constructor (in the header rows 1..place-1), cancel, audit and require are exceptions: four
    expect((await facts(near)).others).toBe("every other member but the constructor, cancel, audit +1 is signature-only");
  });

  it("a type whose only member is the cover has nothing to say of the others", async () => {
    const lines = ["public class FulfillmentDesk {", "    public void place(Order order) {", "        stockLedger.reserve(order);", "    }", "}"];
    const symbols = await collectSymbols(lines.join("\n"), "java", {});
    const type = { path: "src/FulfillmentDesk.java", name: "FulfillmentDesk", start: 1, end: 5, signatureStart: 1, signatureEnd: 1,
      members: [{ name: "place", start: 2, end: 4, signatureStart: 2, signatureEnd: 2, nestedType: false, constructor: false }] } satisfies StructureMapType;
    expect(symbols.length).toBeGreaterThan(0);
    const only = answerFirstFacts({ type, lines, terms: ["stock"], cover: type.members, served: [{ start: 1, end: 5 }], guards: [] });
    expect(only.others).toBe("");
  });
});

describe("composeAnswerFirst — the advisory under a byte budget", () => {
  const FACTS: AnswerFirstFacts = {
    served: ["place 14-18"],
    notServed: ["cancel 21-26", "retry 29-34"],
    guards: ["retry guard text"],
    unreferencedConstants: ["NOTE_RESERVED"],
    referencedConstants: ["NOTE_FAILED: set L24, read L30", "RETRIES: read L29"],
    calls: ["cancel billingClient.refund L21, stockLedger.release L25", "retry stockLedger.release L32"],
    concerns: ["billing", "stock"],
    others: "every other member is signature-only",
  };
  // F6: the list names the members that call a requested concern; the last clause says what is true of every other member.
  const TIER_A = "structure map: served whole: place 14-18; bodies not served of members that call billing/stock: cancel 21-26, retry 29-34; every other member is signature-only";
  const TIER_B = "loop guards in unserved bodies: retry guard text";
  const TIER_C = "same-file references to constants declared in served lines (lexical): NOTE_FAILED: set L24, read L30; RETRIES: read L29; no reference outside the declaration: NOTE_RESERVED";
  const TIER_D = "concern calls in unserved bodies, in source order: cancel billingClient.refund L21, stockLedger.release L25 | retry stockLedger.release L32";
  const FULL = `${TIER_A}; ${TIER_B}; ${TIER_C}; ${TIER_D}`;
  const ONE = "structure map: served whole: place 14-18; bodies not served of members that call billing/stock: cancel 21-26, +1 more; every other member is signature-only";

  it("states the tiers in priority order — served and unserved, loop guards, constant usage, concern calls — joined by semicolons", () => {
    const composed = composeAnswerFirst(FACTS, Number.MAX_SAFE_INTEGER);
    expect(composed).toEqual({ text: FULL, tiers: 4 });
    expect(composeAnswerFirstAdvisory(FACTS, Number.MAX_SAFE_INTEGER)).toBe(FULL);
  });

  it("is empty when no body is owed, or when not even the first tier fits", () => {
    expect(composeAnswerFirst({ ...FACTS, notServed: [] }, Number.MAX_SAFE_INTEGER)).toEqual({ text: "", tiers: 0 });
    expect(composeAnswerFirst(FACTS, 0)).toEqual({ text: "", tiers: 0 });
    expect(composeAnswerFirst(FACTS, advisoryWireBytes(ONE) - 1)).toEqual({ text: "", tiers: 0 });
  });

  it("drops from the end: the calls first, then the constant usage, then the loop guards", () => {
    const upTo = (text: string): number => advisoryWireBytes(text);
    expect(composeAnswerFirst(FACTS, upTo(FULL))).toEqual({ text: FULL, tiers: 4 });
    // The calls tier is cut at a member boundary before it is dropped, and a cut tier does not count.
    const cut = `${TIER_A}; ${TIER_B}; ${TIER_C}; concern calls in unserved bodies, in source order: cancel billingClient.refund L21, stockLedger.release L25 | +1 more members`;
    expect(composeAnswerFirst(FACTS, upTo(FULL) - 1)).toEqual({ text: cut, tiers: 3 });
    expect(composeAnswerFirst(FACTS, upTo(cut))).toEqual({ text: cut, tiers: 3 });
    expect(composeAnswerFirst(FACTS, upTo(cut) - 1)).toEqual({ text: `${TIER_A}; ${TIER_B}; ${TIER_C}`, tiers: 3 });
    expect(composeAnswerFirst(FACTS, upTo(`${TIER_A}; ${TIER_B}; ${TIER_C}`) - 1)).toEqual({ text: `${TIER_A}; ${TIER_B}`, tiers: 2 });
    expect(composeAnswerFirst(FACTS, upTo(`${TIER_A}; ${TIER_B}`) - 1)).toEqual({ text: TIER_A, tiers: 1 });
  });

  it("cuts the unserved list at an entry with \"+N more\" only after every other tier is gone, and then states nothing further", () => {
    expect(composeAnswerFirst(FACTS, advisoryWireBytes(TIER_A) - 1)).toEqual({ text: ONE, tiers: 0 });
    expect(composeAnswerFirst(FACTS, advisoryWireBytes(ONE))).toEqual({ text: ONE, tiers: 0 });
  });

  it("never exceeds its budget and never loses text as the budget grows (every budget from 0 to the full text)", () => {
    const full = advisoryWireBytes(FULL);
    let previous = "";
    for (let budget = 0; budget <= full + 5; budget += 1) {
      const { text } = composeAnswerFirst(FACTS, budget);
      if (text !== "") expect(advisoryWireBytes(text), `budget ${budget}`).toBeLessThanOrEqual(budget);
      expect(text.length, `budget ${budget}`).toBeGreaterThanOrEqual(previous.length);
      previous = text;
    }
    expect(previous).toBe(FULL);
  });

  it("omits a tier with nothing to state, and counts only the tiers it carries", () => {
    const onlyA: AnswerFirstFacts = { ...FACTS, guards: [], unreferencedConstants: [], referencedConstants: [], calls: [] };
    expect(composeAnswerFirst(onlyA, Number.MAX_SAFE_INTEGER)).toEqual({ text: TIER_A, tiers: 1 });
    const unreferencedOnly: AnswerFirstFacts = { ...onlyA, unreferencedConstants: ["NOTE_RESERVED"] };
    expect(composeAnswerFirst(unreferencedOnly, Number.MAX_SAFE_INTEGER).text).toBe(`${TIER_A}; no reference outside the declaration: NOTE_RESERVED`);
    const referencedOnly: AnswerFirstFacts = { ...onlyA, referencedConstants: ["NOTE_FAILED: set L24"] };
    expect(composeAnswerFirst(referencedOnly, Number.MAX_SAFE_INTEGER).text).toBe(`${TIER_A}; same-file references to constants declared in served lines (lexical): NOTE_FAILED: set L24`);
  });

  it("names the concerns the members call, at most four; a request with none to name says only what was not served", () => {
    const many: AnswerFirstFacts = { ...FACTS, concerns: ["payment", "inventory", "shipping", "audit", "tax", "fraud"] };
    expect(composeAnswerFirst(many, Number.MAX_SAFE_INTEGER).text).toContain("bodies not served of members that call payment/inventory/shipping/audit/+2: cancel 21-26, retry 29-34");
    const none: AnswerFirstFacts = { ...FACTS, concerns: [] };
    expect(composeAnswerFirst(none, Number.MAX_SAFE_INTEGER).text).toContain("served whole: place 14-18; bodies not served: cancel 21-26, retry 29-34; every other member");
  });

  it("the last clause about every other member survives the list being cut, and is left off when there is nothing exact to say", () => {
    const cut = composeAnswerFirst(FACTS, advisoryWireBytes(TIER_A) - 1).text;
    expect(cut.endsWith("cancel 21-26, +1 more; every other member is signature-only")).toBe(true);
    const silent: AnswerFirstFacts = { ...FACTS, others: "" };
    expect(composeAnswerFirst(silent, Number.MAX_SAFE_INTEGER).text.startsWith("structure map: served whole: place 14-18; bodies not served of members that call billing/stock: cancel 21-26, retry 29-34; loop guards")).toBe(true);
    const exceptions: AnswerFirstFacts = { ...FACTS, others: "every other member but the constructor is signature-only" };
    expect(composeAnswerFirst(exceptions, Number.MAX_SAFE_INTEGER).text).toContain("retry 29-34; every other member but the constructor is signature-only; loop guards");
  });

  it("states facts only: no instruction to the reader and no tool name", () => {
    const text = composeAnswerFirstAdvisory(FACTS, Number.MAX_SAFE_INTEGER);
    // "read" is a classification (`read L30`), never an instruction: it is allowed where it labels lines.
    expect(text).not.toMatch(/\b(?:should|must|need|please|try|use|fetch|run|retry it|next|tl_[a-z_]+)\b/iu);
    expect(text).not.toMatch(/\bread\b(?! (?:L\d|\+\d))/iu);
    expect(text).not.toMatch(/[぀-ヿ一-鿿]/u);
  });

  it("advisoryWireBytes is the key and the JSON string as they ride on the wire, in UTF-8 bytes", () => {
    for (const text of ["a", "structure map: served whole: place 14-18", "日本語 \"quoted\" \\ and\nnewline"]) {
      expect(advisoryWireBytes(text)).toBe(Buffer.byteLength(`,"advisory":${JSON.stringify(text)}`, "utf8"));
    }
    expect(advisoryWireBytes("日本")).toBe(advisoryWireBytes("ab") + 4);
  });
});
