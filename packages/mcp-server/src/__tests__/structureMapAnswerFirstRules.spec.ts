/**
 * structureMapAnswerFirstRules.spec.ts — TL_EFF_MAP_ANSWER_FIRST (2026-10-24, generality
 * audit follow-up), the pure rules that decide WHICH calls an answer-first map states, as units
 * (features/task-pack/structureMap.ts). The audit found the rules shaped by T03's one class:
 *
 *   R3  a concern call is a call on a collaborator field — and `collaboratorFields` only saw
 *       injected ones. It also sees the fields a constructor builds or conventionally receives
 *       now, and where the strict rule still finds no member, the NAMED rule decides (a call
 *       whose receiver chain or callee names a concern, never a data accessor on a parameter or
 *       a local, never the type's own member called through `this`).
 *   R4  a member the request names is in the cover when it calls a concern.
 *   R5  the words that describe the answer's form are no concern.
 *
 * The six desks below have the SHAPES of the six types the audit found strict-rule-blind (a
 * Python parser and client, a TypeScript engine, a JavaScript workbook, a compiler, a state
 * store): invented, small, and about nothing in any real code base. The end-to-end behavior is
 * mapAnswerFirst.spec.ts / answerFirstAdoption.spec.ts; the facts are answerFirstFacts.spec.ts.
 */
import { describe, expect, it } from "vitest";

import { collectSymbols } from "../symbols/collectSymbols.js";
import {
  ANSWER_FORM_WORDS,
  answerFirstCover,
  answerFormFree,
  collaboratorFields,
  concernCallMatchesIn,
  concernMembersByReach,
  coverMembers,
  directConcernMembers,
  membersNamed,
  namedConcernCallMatches,
  namedConcernRule,
  structureMapCallTerms,
  structureMapTypeOf,
  type StructureMapMember,
  type StructureMapType,
} from "../features/task-pack/structureMap.js";
import { answerFirstFacts, composeAnswerFirst } from "../features/task-pack/answerFirstFacts.js";

/** The type `name` of `source` in `lang`. */
async function typeIn(lang: string, file: string, name: string, source: readonly string[]): Promise<StructureMapType> {
  const symbols = await collectSymbols(source.join("\n"), lang, {});
  const type = structureMapTypeOf(symbols, file, name, 1, source.length);
  expect(type, JSON.stringify(symbols.map((entry) => [entry.name, entry.kind, entry.startLine, entry.endLine]))).toBeDefined();
  return type!;
}

const names = (members: readonly StructureMapMember[]): string[] => members.map((member) => member.name);

describe("collaboratorFields — the fields a constructor builds and the ones a language conventionally injects", () => {
  it("Java: `this.x = new X(…)` in the constructor, and `x = y;` to a field the header declares without modifiers; not a value or a literal", async () => {
    const source = [
      "public class Desk {",
      "    PaymentService payments;",
      "    private final Clock clock;",
      "    private int counter;",
      "    private String label;",
      "",
      "    public Desk(PaymentService svc, Clock clock) {",
      "        payments = svc;",
      "        this.clock = clock;",
      "        this.client = new ShippingClient(clock);",
      "        this.label = new String(\"x\");",
      "        this.counter = 0;",
      "    }",
      "",
      "    public void a() {}",
      "    public void b() {}",
      "    public void c() {}",
      "}",
    ];
    const fields = collaboratorFields(await typeIn("java", "Desk.java", "Desk", source), source);
    expect([...fields].sort()).toEqual(["client", "clock", "payments"]);
  });

  it("C#: `private readonly IFoo _foo;`, a get-only property, `_x = x;`; not `{ get; set; }` data, not a count", async () => {
    const source = [
      "public class Desk",
      "{",
      "    private readonly IBilling _billing;",
      "    private readonly int _retries;",
      "    public IStock Stock { get; }",
      "    public IDelivery Delivery { get; private set; }",
      "    public ILabelPrinter Printer { get; init; }",
      "    public IAudit Audit { get; set; }",
      "    public int Count { get; }",
      "",
      "    public Desk(IBilling billing, IStock stock)",
      "    {",
      "        _billing = billing;",
      "        Stock = stock;",
      "    }",
      "",
      "    public void A() { }",
      "    public void B() { }",
      "    public void C() { }",
      "}",
    ];
    const fields = collaboratorFields(await typeIn("csharp", "Desk.cs", "Desk", source), source);
    expect([...fields].sort()).toEqual(["Delivery", "Printer", "Stock", "_billing"]);
  });

  it("C++: class-typed members wherever the class declares them (here after the methods), and the initializer list's by-value members; not a pointer to a value", async () => {
    const source = [
      "class Desk {",
      " public:",
      "  Desk(Billing& billing, Stock* stock, Config config) : billing_(billing), stock_(stock), config_(config), retries_(3) {}",
      "  void a() {}",
      "  void b() {}",
      "  void c() {}",
      " private:",
      "  Billing& billing_;",
      "  Stock* stock_;",
      "  const Delivery& delivery_;",
      "  std::unique_ptr<Printer> printer_;",
      "  std::shared_ptr<const Audit> audit_;",
      "  Config config_;",
      "  Scratch scratch_;",
      "  int* cursor_;",
      "  int retries_;",
      "};",
    ];
    const fields = collaboratorFields(await typeIn("cpp", "desk.hpp", "Desk", source), source);
    expect([...fields].sort()).toEqual(["audit_", "billing_", "config_", "delivery_", "printer_", "stock_"]);
  });

  it("Python: `self._s = requests.Session()` and `self.x = X(…)` (a capitalized callee), not a lowercase factory, a literal or a call of a lowercase function", async () => {
    const source = [
      "class Client:",
      "    def __init__(self, config, token):",
      "        self.config = config",
      "        self._s = requests.Session()",
      "        self.queue = RetryQueue(config)",
      "        self.cache = make_cache(config)",
      "        self.count = 0",
      "        self.name = str(token)",
      "    def a(self):",
      "        pass",
      "    def b(self):",
      "        pass",
      "    def c(self):",
      "        pass",
    ];
    const fields = collaboratorFields(await typeIn("python", "client.py", "Client", source), source);
    expect([...fields].sort()).toEqual(["_s", "config", "queue"]);
  });

  it("TypeScript: `this.x = new X()` in the constructor; a field built in place in the header (`= new Map()`) is still not one", async () => {
    const source = [
      "export class Engine {",
      "  private readonly seen = new Map<string, number>();",
      "  constructor(private readonly clock: Clock) {",
      "    this.queue = new JobQueue(clock);",
      "  }",
      "  a() {}",
      "  b() {}",
      "  c() {}",
      "}",
    ];
    const fields = collaboratorFields(await typeIn("typescript", "engine.ts", "Engine", source), source);
    expect([...fields].sort()).toEqual(["clock", "queue"]);
  });
});

describe("the named rule — a call whose receiver chain or callee names a concern, not a data accessor", () => {
  const TERMS = ["payment", "billing", "stock"];
  const DATA = new Set(["req", "order", "gateway"]);
  const callsOf = (code: string, dataNames: ReadonlySet<string> = DATA): string[] =>
    namedConcernCallMatches(code, TERMS, dataNames).map((entry) => entry.call);

  it.each([
    // F4: a record accessor on a parameter or a local never counts, however it is spelled
    ["        if (req.paymentMethod() == null) {", []],
    ["        errors.add(\"x: \" + req.paymentMethod());", []],
    ["        log(order.billingKind());", []],
    ["        var kind = order.stockLevel();", []],
    // …but a call WITH arguments on a parameter, and a call on a name that is not one of the member's own data, does
    ["        req.chargePayment(card);", ["req.chargePayment"]],
    ["        Metrics.stockSample(sku);", ["Metrics.stockSample"]],
    ["        PaymentGateway.charge(order.total());", ["PaymentGateway.charge"]],
    ["        paymentService.refund(order.getPaymentId());", ["paymentService.refund"]],
    ["        this.paymentService.refund(id);", ["paymentService.refund"]],
    ["        self.billing_client.charge(order)", ["billing_client.charge"]],
    // a plain chain of field accesses one of which names the concern
    ["        this.paymentGateway.client.send(order);", ["client.send"]],
    ["        this->stock_.lanes.reserve(sku);", ["lanes.reserve"]],
    // the type's own member through `this` / `self` is a helper, the facts follow it one level
    ["        this.paymentMethod();", []],
    ["        self.charge_payment(order)", []],
    // an accessor-named callee is not a concern call by its callee; by its receiver it is
    ["        order.getPaymentId();", []],
    ["        paymentService.getStatus();", ["paymentService.getStatus"]],
    // a call on a call's result: the concern-named call of the chain counts once
    ["        paymentService.gateway().charge(order);", ["paymentService.gateway"]],
    ["        order.payment().charge(total);", []],
  ] as const)("%j -> %j", (line, expected) => {
    expect(callsOf(line)).toEqual([...expected]);
  });

  it("a name a member declares as a parameter or a local is data; a collaborator field of that name is not", async () => {
    const source = [
      "public class Desk {",
      "    private final PaymentService paymentService;",
      "    public Desk(PaymentService paymentService) { this.paymentService = paymentService; }",
      "    public void review(OrderRequest req, Order order) {",
      "        Payment payment = order.payment();",
      "        log(req.paymentMethod());",
      "        log(payment.paymentKind());",
      "        paymentService.audit(req.sku());",
      "    }",
      "    public void a() {}",
      "    public void b() {}",
      "}",
    ];
    const type = await typeIn("java", "Desk.java", "Desk", source);
    const fields = collaboratorFields(type, source);
    const rule = namedConcernRule(source, fields);
    const review = type.members.find((member) => member.name === "review")!;
    expect([...rule.dataNamesOf(review)].sort()).toEqual(["order", "payment", "req"]);
    const body = source.slice(review.signatureEnd, review.end);
    expect(body.flatMap((line) => concernCallMatchesIn(rule, review, line, ["payment"]).map((entry) => entry.call))).toEqual(["paymentService.audit"]);
  });
});

describe("answerFirstCover — one rule per type: collaborators first, the named rule where that finds no member", () => {
  const F4_DESK = [
    "public class Desk {",
    "    private final PaymentService paymentService;",
    "    private final StockLedger stockLedger;",
    "    public Desk(PaymentService paymentService, StockLedger stockLedger) {",
    "        this.paymentService = paymentService;",
    "        this.stockLedger = stockLedger;",
    "    }",
    "    public void preview(PlaceRequest req) {",
    "        if (req.paymentMethod() == null) { log(req.stockLevel()); }",
    "    }",
    "    public void place(PlaceRequest req) {",
    "        stockLedger.reserve(req.sku());",
    "        paymentService.charge(req.total());",
    "    }",
    "    public void cancel(String id) {",
    "        paymentService.refund(id);",
    "    }",
    "}",
  ];

  it("F4: `req.paymentMethod()` is in neither the cover nor the call index, under the collaborators rule and under the named rule", async () => {
    const type = await typeIn("java", "Desk.java", "Desk", F4_DESK);
    const terms = ["payment", "stock"];
    const chosen = answerFirstCover(type, F4_DESK, terms)!;
    expect(names(chosen.cover)).toEqual(["place"]);
    expect(chosen.rule).toBe(chosen.collaborators);
    // the named rule agrees: preview's two "calls" are accessors on its parameter
    const named = namedConcernRule(F4_DESK, chosen.collaborators);
    expect(names([...directConcernMembers(type, F4_DESK, terms, named).keys()])).toEqual(["place", "cancel"]);
    for (const rule of [chosen.rule, named]) {
      const facts = answerFirstFacts({ type, lines: F4_DESK, terms, cover: chosen.cover, served: [{ start: 1, end: 10 }, { start: 11, end: 14 }], guards: [], lang: "java", rule });
      expect(facts.calls.join(" | ")).not.toMatch(/\breq\./u);
      expect(composeAnswerFirstText(facts)).not.toContain("req.");
      expect(facts.notServed.map((entry) => entry.split(" ")[0])).toEqual(["cancel"]);
    }
  });

  it("a header with no collaborator uses the named rule from the start: the accessor is still no call", async () => {
    const source = [
      "public class Plain {",
      "    public void preview(PlaceRequest req) {",
      "        if (req.paymentMethod() == null) { log(req.stockLevel()); }",
      "    }",
      "    public void place(PlaceRequest req) {",
      "        stockLedger.reserve(req.sku());",
      "        paymentGateway.charge(req.total());",
      "    }",
      "    public void other() {}",
      "}",
    ];
    const type = await typeIn("java", "Plain.java", "Plain", source);
    expect(collaboratorFields(type, source).size).toBe(0);
    const chosen = answerFirstCover(type, source, ["payment", "stock"])!;
    expect(names(chosen.cover)).toEqual(["place"]);
    expect(chosen.rule).not.toBe(chosen.collaborators);
  });

  it("nothing calls a concern under either rule: no cover", async () => {
    const source = [
      "public class Desk {",
      "    private final PaymentService paymentService;",
      "    public Desk(PaymentService paymentService) { this.paymentService = paymentService; }",
      "    public void a(Req req) { log(req.paymentMethod()); }",
      "    public void b() { this.paymentHelper(); }",
      "    public void c() {}",
      "}",
    ];
    expect(answerFirstCover(await typeIn("java", "Desk.java", "Desk", source), source, ["payment"])).toBeUndefined();
  });

  // The six shapes. In each the type HAS collaborators or a header, and the strict rule — a call on a field it receives —
  // finds no member; the cover is the member the audit found the looser rule would have picked.
  describe("six types whose concern calls do not hang from a field the header shows (invented; shapes from the 2026-10-24 audit)", () => {
    const cases: Array<{ name: string; lang: string; file: string; terms: string[]; cover: string; collaborators: number; strictCover: boolean; source: string[] }> = [
      {
        name: "OutputParser", lang: "python", file: "parser.py", terms: ["metrics", "tracer"], cover: "feed", collaborators: 5, strictCover: false,
        source: [
          "class OutputParser:",
          "    def __init__(self, decoder, sink, logger, config, clock):",
          "        self.decoder = decoder",
          "        self.sink = sink",
          "        self.logger = logger",
          "        self.config = config",
          "        self.clock = clock",
          "    def feed(self, chunk):",
          "        text = self.decoder.decode(chunk)",
          "        Metrics.record(len(text))",
          "        tracer.span('feed')",
          "        self.sink.write(text)",
          "    def flush(self):",
          "        self.sink.flush()",
          "    def reset(self):",
          "        self.config.reset()",
        ],
      },
      {
        name: "CommonRockClient", lang: "python", file: "client.py", terms: ["retry", "auth"], cover: "_request", collaborators: 8, strictCover: false,
        source: [
          "class CommonRockClient:",
          "    def __init__(self, base_url, token, session, logger, clock, config, cache, metrics):",
          "        self.base_url = base_url",
          "        self.token = token",
          "        self.session = session",
          "        self.logger = logger",
          "        self.clock = clock",
          "        self.config = config",
          "        self.cache = cache",
          "        self.metrics = metrics",
          "    def _request(self, method, path):",
          "        retry_policy = RetryPolicy(self.config)",
          "        auth_header = build_header(self.token)",
          "        while True:",
          "            response = self.session.request(method, self.base_url + path, headers=auth_header)",
          "            if response.ok:",
          "                return response",
          "            retry_policy.wait(self.clock)",
          "    def get(self, path):",
          "        return self._request('GET', path)",
          "    def close(self):",
          "        self.session.close()",
        ],
      },
      {
        name: "Engine", lang: "typescript", file: "engine.ts", terms: ["queue", "scheduler"], cover: "enqueue", collaborators: 2, strictCover: false,
        source: [
          "export class Engine {",
          "  private readonly queue = new JobQueue();",
          "  constructor(private readonly clock: Clock, private readonly log: Logger) {}",
          "  enqueue(job: Job): void {",
          "    this.queue.push(job);",
          "    this.log.info('queued');",
          "    scheduler.wake(this.clock.now());",
          "  }",
          "  drain(): Job[] {",
          "    return this.queue.drain();",
          "  }",
          "  size(): number {",
          "    return this.queue.length;",
          "  }",
          "}",
        ],
      },
      {
        name: "XLSX", lang: "javascript", file: "xlsx.js", terms: ["workbook", "stream"], cover: "load", collaborators: 1, strictCover: false,
        source: [
          "class XLSX {",
          "  constructor(zip) {",
          "    this.zip = zip;",
          "  }",
          "  load(data) {",
          "    const workbook = new Workbook();",
          "    const entries = this.zip.entries(data);",
          "    workbook.load(entries);",
          "    stream.pipe(workbook);",
          "    return workbook;",
          "  }",
          "  save(workbook) {",
          "    return this.zip.pack(workbook.model());",
          "  }",
          "  size() {",
          "    return this.zip.length;",
          "  }",
          "}",
        ],
      },
      {
        name: "Ajv", lang: "typescript", file: "ajv.ts", terms: ["codegen", "keyword"], cover: "compile", collaborators: 2, strictCover: false,
        source: [
          "export class Ajv {",
          "  constructor(private readonly opts: Options, private readonly logger: Logger) {}",
          "  compile(schema: Schema): Validate {",
          "    const code = codegen.generate(schema, this.opts);",
          "    this.logger.log('compiled');",
          "    return keywordTable.apply(code);",
          "  }",
          "  validate(schema: Schema, data: unknown): boolean {",
          "    return this.opts.strict && schema != null;",
          "  }",
          "  addSchema(schema: Schema): void {",
          "    this.logger.log(schema);",
          "  }",
          "}",
        ],
      },
      {
        name: "WorkspaceStateStore", lang: "typescript", file: "store.ts", terms: ["operation", "journal"], cover: "rememberOperation", collaborators: 3, strictCover: false,
        source: [
          "export class WorkspaceStateStore {",
          "  private readonly operations = new Map<string, Operation>();",
          "  constructor(private readonly fs: FileSystem, private readonly clock: Clock, private readonly log: Logger) {}",
          "  rememberOperation(id: string, op: Operation): void {",
          "    this.operations.set(id, op);",
          "    this.log.info(id);",
          "    journal.append(id);",
          "  }",
          "  recall(id: string): Operation | undefined {",
          "    return this.operations.get(id);",
          "  }",
          "  persist(): void {",
          "    this.fs.write('state.json', JSON.stringify([...this.operations]));",
          "  }",
          "}",
        ],
      },
    ];

    it.each(cases)("$name: $collaborators collaborators, the strict rule finds no member, the cover is $cover", async (shape) => {
      const type = await typeIn(shape.lang, shape.file, shape.name, shape.source);
      const fields = collaboratorFields(type, shape.source);
      expect(fields.size, "collaborators").toBeGreaterThanOrEqual(Math.min(shape.collaborators, 1));
      expect(coverMembers(type, shape.source, shape.terms, undefined, fields).length > 0, "the strict rule's cover").toBe(shape.strictCover);
      const chosen = answerFirstCover(type, shape.source, shape.terms);
      expect(chosen, "a cover").toBeDefined();
      expect(names(chosen!.cover)).toEqual([shape.cover]);
      // the facts are written under the same rule: the covered member is served, no accessor is indexed
      const facts = answerFirstFacts({ type, lines: shape.source, terms: shape.terms, cover: chosen!.cover, served: [], guards: [], lang: shape.lang, rule: chosen!.rule });
      expect(facts.served[0]).toMatch(new RegExp(`^${shape.cover} `, "u"));
    });

    it("the collaborators the audit counted are those of the widened rule: OutputParser's five, CommonRockClient's eight", async () => {
      const [parser, client] = [cases[0]!, cases[1]!];
      expect(collaboratorFields(await typeIn(parser.lang, parser.file, parser.name, parser.source), parser.source).size).toBe(5);
      expect(collaboratorFields(await typeIn(client.lang, client.file, client.name, client.source), client.source).size).toBe(8);
    });
  });

  it("a constructed field makes the STRICT rule find the member: the widening alone is enough where the call hangs from it", async () => {
    const source = [
      "class Client:",
      "    def __init__(self, config):",
      "        self.session = requests.Session()",
      "        self.config = config",
      "    def fetch(self, url):",
      "        timeout = self.config.timeout",
      "        return self.session.get(url, timeout=timeout)",
      "    def head(self, url):",
      "        timeout = self.config.timeout",
      "        return self.config.head_url(url, timeout)",
      "    def close(self):",
      "        self.config.flush()",
      "        self.session.close()",
    ];
    const type = await typeIn("python", "client.py", "Client", source);
    const fields = collaboratorFields(type, source);
    expect([...fields].sort()).toEqual(["config", "session"]);
    // before the widening the only collaborator was `config`: no member called `session` on a field, and answer-first gave up
    expect(coverMembers(type, source, ["session"], undefined, new Set(["config"]))).toEqual([]);
    const chosen = answerFirstCover(type, source, ["session"])!;
    expect(chosen.rule).toBe(chosen.collaborators);
    expect(names(chosen.cover)).toEqual(["fetch"]);
    expect(names([...directConcernMembers(type, source, ["session"], fields).keys()])).toEqual(["fetch", "close"]);
  });
});

describe("coverMembers with `required` — the members the request names", () => {
  const SOURCE = [
    "public class Desk {",
    "    private final BillingClient billingClient;",
    "    private final StockLedger stockLedger;",
    "    private final DeliveryService deliveryService;",
    "    public Desk(BillingClient billingClient, StockLedger stockLedger, DeliveryService deliveryService) {",
    "        this.billingClient = billingClient;",
    "        this.stockLedger = stockLedger;",
    "        this.deliveryService = deliveryService;",
    "    }",
    "    public void open(Order order) {",
    "        stockLedger.reserve(order.sku());",
    "        billingClient.charge(order.total());",
    "        deliveryService.dispatch(order);",
    "    }",
    "    public void restock(String sku) {",
    "        stockLedger.add(sku);",
    "    }",
    "    public void refund(Order order) {",
    "        billingClient.refund(order.total());",
    "    }",
    "    public void note(Order order) {",
    "        log(order);",
    "    }",
    "    public void notify(Order order) {",
    "        deliveryService.notifyLate(order);",
    "    }",
    "}",
  ];
  const TERMS = ["billing", "stock", "delivery"];

  it("without a name the entry point alone covers the three concerns; a named member that calls a concern is added to it", async () => {
    const type = await typeIn("java", "Desk.java", "Desk", SOURCE);
    const fields = collaboratorFields(type, SOURCE);
    expect(names(coverMembers(type, SOURCE, TERMS, undefined, fields))).toEqual(["open"]);
    expect(names(coverMembers(type, SOURCE, TERMS, undefined, fields, membersNamed(type, ["restock"])))).toEqual(["open", "restock"]);
    expect(names(coverMembers(type, SOURCE, TERMS, undefined, fields, membersNamed(type, ["restock", "refund"])))).toEqual(["open", "restock", "refund"]);
  });

  it("a named member that calls no concern needs no place in the cover; a name that is no member, a constructor or the type's own name are ignored", async () => {
    const type = await typeIn("java", "Desk.java", "Desk", SOURCE);
    const fields = collaboratorFields(type, SOURCE);
    expect(membersNamed(type, ["note", "Desk", "nothing"]).map((member) => member.name)).toEqual(["note"]);
    expect(names(coverMembers(type, SOURCE, TERMS, undefined, fields, membersNamed(type, ["note", "Desk", "nothing"])))).toEqual(["open"]);
  });

  it(`a cover the named members take past ${3} members is no cover: the ordinary map is served`, async () => {
    const type = await typeIn("java", "Desk.java", "Desk", SOURCE);
    const fields = collaboratorFields(type, SOURCE);
    const named = membersNamed(type, ["restock", "refund", "notify"]);
    expect(coverMembers(type, SOURCE, TERMS, undefined, fields, named)).toEqual([]);
    expect(answerFirstCover(type, SOURCE, TERMS, ["restock", "refund", "notify"])).toBeUndefined();
    expect(names(answerFirstCover(type, SOURCE, TERMS, ["restock"])!.cover)).toEqual(["open", "restock"]);
  });
});

describe("ANSWER_FORM_WORDS — language-meta vocabulary is no concern term", () => {
  it("the audit's Gdn#a-en terms (sycl, device, steady, briefly, big, around, call, map) come down to sycl, device, steady", () => {
    expect(answerFormFree(["sycl", "device", "steady", "briefly", "big", "around", "call", "map"])).toEqual(["sycl", "device", "steady"]);
  });

  it("the other request-shape words the extractor reports are filtered, in any case, and codebase words are not", () => {
    for (const word of ["brief", "briefly", "picture", "overview", "summary", "line", "lines", "code", "order", "flow", "step", "steps", "class", "method", "methods", "function", "functions", "type", "short", "quick", "explain", "walk", "through", "calls", "called", "structure", "Overview", "MAP"]) {
      expect(ANSWER_FORM_WORDS.has(word.toLowerCase()), word).toBe(true);
    }
    expect(answerFormFree(["payment", "inventory", "shipping", "slack", "shopflow", "metrics", "queue", "session", "retry"])).toEqual(["payment", "inventory", "shipping", "slack", "shopflow", "metrics", "queue", "session", "retry"]);
  });

  it("T03's terms (the three it lists by name, then the Latin words of its flow clauses) are unchanged; the ordinary map's own term function is not touched", () => {
    const flow = ["order", "slack", "shopflow", "orderorchestrator"];
    expect(structureMapCallTerms(answerFormFree(flow), "OrderOrchestrator")).toEqual(["slack", "shopflow"]);
    expect(structureMapCallTerms(flow, "OrderOrchestrator")).toEqual(["slack", "shopflow"]);
    // …whereas the ordinary map keeps every extractor word the type's name does not hold
    expect(structureMapCallTerms(["briefly", "big", "map", "sycl"], "Gdn")).toEqual(["briefly", "big", "map", "sycl"]);
    expect(structureMapCallTerms(answerFormFree(["briefly", "big", "map", "sycl"]), "Gdn")).toEqual(["sycl"]);
  });
});

describe("a member that reaches a concern only through a helper of the type", () => {
  const SOURCE = [
    "public class Desk {",
    "    private final BillingClient billingClient;",
    "    public Desk(BillingClient billingClient) { this.billingClient = billingClient; }",
    "    public void charge(Order order) {",
    "        billingClient.charge(order.total());",
    "    }",
    "    public void retry(Order order) {",
    "        charge(order);",
    "        charge(order);",
    "    }",
    "    public void idle() {",
    "        log();",
    "    }",
    "}",
  ];

  it("concernMembersByReach tells the direct member from the one that calls it", async () => {
    const type = await typeIn("java", "Desk.java", "Desk", SOURCE);
    const fields = collaboratorFields(type, SOURCE);
    const reach = concernMembersByReach(type, SOURCE, ["billing"], fields);
    expect(names(reach.direct)).toEqual(["charge"]);
    expect(names(reach.viaHelper)).toEqual(["retry"]);
    expect(names(reach.all)).toEqual(["charge", "retry"]);
  });

  it("the facts list it as `via helper`, so the line does not say the member calls the concern", async () => {
    const type = await typeIn("java", "Desk.java", "Desk", SOURCE);
    const fields = collaboratorFields(type, SOURCE);
    const facts = answerFirstFacts({ type, lines: SOURCE, terms: ["billing"], cover: [], served: [], guards: [], lang: "java", collaborators: fields });
    expect(facts.notServed).toEqual(["charge 5-6", "retry 8-10 via helper"]);
    expect(facts.calls).toEqual(["charge billingClient.charge L5"]);
  });
});

/** The advisory text of `facts` with all the room there is. */
function composeAnswerFirstText(facts: ReturnType<typeof answerFirstFacts>): string {
  return composeAnswerFirst(facts, Number.MAX_SAFE_INTEGER).text;
}
