/**
 * outOfLineDesks.ts — synthetic Go, Rust and C types whose members are declared
 * OUTSIDE the type's own range, scaled like the T03 class (owedRowsDesk.ts, the
 * Java desk of structureMapAnswer.spec.ts): a type that does not fit one surface,
 * collaborators it calls in a known order (billing, stock, delivery — timer,
 * queue, clock for C), `fillers` members that call nothing, and — between its
 * members — the code of OTHER types and functions that the map must never serve.
 *
 * The generators return the lines they wrote and where the interesting ones are,
 * so a spec states what a reply must and must not carry without re-deriving the
 * rule (out-of-line-maps-design.md, Stage 1; structureMapOutOfLineServer.spec.ts).
 */
import * as fs from "node:fs";
import * as path from "node:path";

export interface OutOfLineDesk {
  /** Workspace-relative path of the file that declares the type. */
  readonly file: string;
  /** The lines of that file. */
  readonly lines: string[];
  /** The line of the first concern call in each member that makes one, by call text, in file order. */
  readonly calls: ReadonlyMap<string, number>;
  /** Lines of code of other types and functions between the members. */
  readonly foreign: ReadonlyArray<{ readonly start: number; readonly end: number }>;
  /** Lines of the members' arithmetic that call nothing (no map serves them). */
  readonly filler: ReadonlyArray<{ readonly start: number; readonly end: number }>;
  /** Signature line of every member, in file order. */
  readonly signatures: ReadonlyMap<string, number>;
  /** The type's declaration: first line of its doc to its closing brace. */
  readonly declaration: { readonly start: number; readonly end: number };
  /** Files, other than `file`, that declare members of the type (for the advisory). */
  readonly elsewhere: ReadonlyArray<{ readonly file: string; readonly count: number }>;
}

function write(ws: string, rel: string, lines: readonly string[]): void {
  const abs = path.join(ws, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, `${lines.join("\n")}\n`, "utf8");
}

/** Collects what a generator knows about the lines it appends. */
class Builder {
  readonly lines: string[] = [];
  readonly calls = new Map<string, number>();
  readonly signatures = new Map<string, number>();
  readonly foreign: Array<{ start: number; end: number }> = [];
  readonly filler: Array<{ start: number; end: number }> = [];
  add(...more: string[]): number {
    this.lines.push(...more);
    return this.lines.length - more.length + 1;
  }
  line(): number { return this.lines.length; }
  foreignBlock(...more: string[]): void {
    const start = this.add(...more);
    this.foreign.push({ start, end: this.lines.length });
  }
}

// ===========================================================================
// Go
// ===========================================================================

export const GO_DESK_FILE = "pkg/desk/desk.go";
export const GO_DESK_EXTRA_FILE = "pkg/desk/desk_extra.go";
export const GO_DESK_TEST_FILE = "pkg/desk/desk_test.go";
export const GO_DESK_QUERY_EN = "Explain what the big Desk struct (in pkg/desk/desk.go) does, around how it calls billing / stock / delivery and in what order — briefly, as a map of its structure (under 40 lines). No code changes.";
export const GO_DESK_QUERY_JA = "pkg/desk/desk.go の Desk 構造体について、billing / stock / delivery をどの順番で呼んでいるかを中心に、何をしている構造体か短く説明してほしい (40行以内、構造の地図として見たい)。コード変更は不要。";

export const GO_DECODER_QUERY_EN = "Explain what the big decoder struct (in pkg/desk/desk.go) does, around how it calls billing / stock / delivery and in what order — briefly, as a map of its structure (under 40 lines). No code changes.";
export const GO_DECODER_QUERY_JA = "pkg/desk/desk.go の decoder 型について、billing / stock / delivery をどの順番で呼んでいるかを中心に、何をしている型か短く説明してほしい (40行以内、構造の地図として見たい)。コード変更は不要。";

/**
 * A Go struct with a `//` doc, a constructor, methods with doc comments, a value receiver, another type and a method of the same name between them, and `fillers` measuring methods that call nothing.
 * `typeName` renames the struct (and its constructor, `new<TypeName>` for a lowercase one): the same
 * file for a type whose name is one plain lowercase word, as yaml.v3's `decoder` is.
 */
export function writeGoDesk(ws: string, fillers = 24, typeName = "Desk"): OutOfLineDesk {
  const rename = (lines: readonly string[]): string[] => typeName === "Desk" ? [...lines] : lines.map((line) => line
    .replace(/\bNewDesk\b/gu, `new${typeName[0]!.toUpperCase()}${typeName.slice(1)}`)
    .replace(/\bDesk\b/gu, typeName));
  const b = new Builder();
  b.add(
    "package desk", "",
    "import (", "\t\"context\"", "\t\"fmt\"", ")", "",
  );
  const docStart = b.add(
    "// Desk coordinates fulfilment for one order at a time.",
    "// It reserves stock, bills and dispatches, in that order.",
    "type Desk struct {",
    "\tbilling  BillingClient",
    "\tstock    StockLedger",
    "\tdelivery DeliveryService",
    "\tmoves    map[DeskState][]DeskState",
    "}",
  );
  const declaration = { start: docStart, end: b.line() };
  b.add("");
  b.foreignBlock(
    "// DeskState is where one ticket stands.",
    "type DeskState int",
    "",
    "const (", "\tOpen DeskState = iota", "\tBilled", "\tShipped", "\tVoid", ")",
    "",
    "// ticketKey identifies one ticket.",
    "type ticketKey string",
  );
  b.add("");
  b.signatures.set("NewDesk", b.add(
    "// NewDesk wires the collaborators.",
    "func NewDesk(b BillingClient, s StockLedger, d DeliveryService) *Desk {",
    "\treturn &Desk{",
    "\t\tbilling:  b,",
    "\t\tstock:    s,",
    "\t\tdelivery: d,",
    "\t\tmoves: map[DeskState][]DeskState{",
    "\t\t\tOpen:   {Billed, Void},",
    "\t\t\tBilled: {Shipped, Void},",
    "\t\t},",
    "\t}",
    "}",
  ) + 1);
  b.add("");
  b.foreignBlock(
    "// newTicketKey makes a key; it returns no Desk, so it is no constructor of one.",
    "func newTicketKey(n int) ticketKey { return ticketKey(fmt.Sprint(n)) }",
  );
  b.add("");
  const openAt = b.add(
    "// Open reserves stock, bills and dispatches one order.",
    "func (d *Desk) Open(ctx context.Context, o Order) error {",
    "\tif err := d.stock.Reserve(ctx, o.SKU, o.Quantity); err != nil {",
    "\t\treturn err",
    "\t}",
    "\tif err := d.billing.Charge(ctx, o.Account, o.Total); err != nil {",
    "\t\td.release(ctx, o)",
    "\t\treturn err",
    "\t}",
    "\treturn d.delivery.Dispatch(ctx, o)",
    "}",
  );
  b.signatures.set("Open", openAt + 1);
  b.calls.set("d.stock.Reserve(", openAt + 2);
  b.calls.set("d.billing.Charge(", openAt + 5);
  b.calls.set("d.delivery.Dispatch(", openAt + 9);
  b.add("");
  b.foreignBlock(
    "func (k ticketKey) String() string { return string(k) }",
    "",
    "// Other is a second type; its Open is not the desk's.",
    "type Other struct{ n int }",
    "",
    "func (o *Other) Open() { o.n++ }",
    "",
    "// helper is a free function.",
    "func helper() int { return 1 }",
  );
  const measure = (i: number): void => {
    b.add("");
    b.signatures.set(`Measure${i}`, b.add(
      `// Measure${i} measures step ${i}.`,
      `func (d *Desk) Measure${i}(seed int64) int64 {`,
    ) + 1);
    const start = b.add(...Array.from({ length: 12 }, (_, j) => `\tv${j} := seed*${j + 3} + ${i * 7 + j} - (seed >> ${j % 5})`));
    b.filler.push({ start, end: b.line() });
    b.add(`\treturn v0 + v11 + ${i}`, "}");
    // Every sixth member another type sits between the members.
    if (i % 6 === 5) {
      b.add("");
      b.foreignBlock(
        `// ticketAudit${i} is audit data, not the desk.`,
        `type ticketAudit${i} struct { at int64; note string }`,
        "",
        `func (a ticketAudit${i}) Line() string { return fmt.Sprintf("%d %s", a.at, a.note) }`,
        "",
        `func formatTicket${i}(a ticketAudit${i}) string {`,
        "\treturn a.Line()",
        "}",
      );
    }
  };
  for (let i = 0; i < fillers; i += 1) measure(i);
  b.add("");
  b.signatures.set("release", b.add("func (d *Desk) release(ctx context.Context, o Order) {") );
  b.add("\td.stock.Release(ctx, o.SKU, o.Quantity)", "}");
  b.add("");
  const cancelAt = b.add(
    "// Cancel undoes an order: refund, release the stock, recall the delivery.",
    "func (d *Desk) Cancel(ctx context.Context, o Order) {",
    "\td.billing.Refund(ctx, o.Account, o.Total)",
    "\td.release(ctx, o)",
    "\td.delivery.Recall(ctx, o)",
    "}",
  );
  b.signatures.set("Cancel", cancelAt + 1);
  b.calls.set("d.billing.Refund(", cancelAt + 2);
  b.calls.set("d.delivery.Recall(", cancelAt + 4);
  b.add("");
  b.signatures.set("Summary", b.add(
    "// Summary reads the desk through a value receiver.",
    "func (d Desk) Summary() string { return fmt.Sprintf(\"%d moves\", len(d.moves)) }",
  ) + 1);
  const lines = rename(b.lines);
  write(ws, "go.mod", ["module example.com/shop", "", "go 1.22"]);
  write(ws, GO_DESK_FILE, lines);
  write(ws, GO_DESK_EXTRA_FILE, rename([
    "package desk", "",
    "// Audit lists what the desk did; a method of Desk in another file of the package.",
    "func (d *Desk) Audit() []string { return nil }",
  ]));
  write(ws, GO_DESK_TEST_FILE, rename([
    "package desk", "", "import \"testing\"", "",
    ...Array.from({ length: 8 }, (_, i) => [
      `func TestDeskOpen${i}(t *testing.T) {`,
      "\td := NewDesk(fakeBilling{}, fakeStock{}, fakeDelivery{})",
      `\tif err := d.Open(nil, Order{SKU: "sku-${i}"}); err != nil {`,
      "\t\tt.Fatal(err)",
      "\t}",
      "\t// the Desk struct bills, reserves and dispatches the Desk order",
      "}",
      "",
    ]).flat(),
  ]));
  return {
    file: GO_DESK_FILE, lines, calls: b.calls, foreign: b.foreign, filler: b.filler, signatures: b.signatures, declaration,
    elsewhere: [{ file: "desk_extra.go", count: 1 }],
  };
}

// ===========================================================================
// Rust
// ===========================================================================

export const RUST_DESK_FILE = "src/desk.rs";
export const RUST_DESK_AUDIT_FILE = "src/audit.rs";
export const RUST_DESK_QUERY_EN = "Explain what the big Desk struct (in src/desk.rs) does, around how it calls billing / stock / delivery and in what order — briefly, as a map of its structure (under 40 lines). No code changes.";
export const RUST_DESK_QUERY_JA = "src/desk.rs の Desk 構造体について、billing / stock / delivery をどの順番で呼んでいるかを中心に、何をしている構造体か短く説明してほしい (40行以内、構造の地図として見たい)。コード変更は不要。";

/** A Rust struct with inherent and trait `impl` blocks (lifetimes, `where`), another struct and its impl between them, a tests module, and `fillers` measuring fns. */
export function writeRustDesk(ws: string, fillers = 22): OutOfLineDesk {
  const b = new Builder();
  b.add("use std::fmt;", "");
  const docStart = b.add(
    "/// Coordinates fulfilment for one order at a time.",
    "pub struct Desk {",
    "    billing: BillingClient,",
    "    stock: StockLedger,",
    "    delivery: DeliveryService,",
    "}",
  );
  const declaration = { start: docStart, end: b.line() };
  b.add("");
  b.foreignBlock("struct Ticket(u32);");
  b.add("");
  b.add("impl Desk {");
  b.signatures.set("new", b.add(
    "    /// Wires the collaborators.",
    "    pub fn new(billing: BillingClient, stock: StockLedger, delivery: DeliveryService) -> Self {",
    "        Desk { billing, stock, delivery }",
    "    }",
  ) + 1);
  b.add("");
  const openAt = b.add(
    "    /// Reserves stock, bills and dispatches one order.",
    "    pub fn open(&self, order: &Order) -> Result<(), DeskError> {",
    "        self.stock.reserve(&order.sku, order.quantity)?;",
    "        if let Err(err) = self.billing.charge(&order.account, order.total) {",
    "            self.release(order);",
    "            return Err(err.into());",
    "        }",
    "        self.delivery.dispatch(order)",
    "    }",
  );
  b.signatures.set("open", openAt + 1);
  b.calls.set("self.stock.reserve(", openAt + 2);
  b.calls.set("self.billing.charge(", openAt + 3);
  b.calls.set("self.delivery.dispatch(", openAt + 7);
  b.add("");
  b.signatures.set("release", b.add("    fn release(&self, order: &Order) {"));
  b.add("        self.stock.release(&order.sku, order.quantity);", "    }", "}", "");
  b.foreignBlock(
    "impl Ticket {",
    "    fn id(&self) -> u32 { self.0 }",
    "    fn open(&self) {}",
    "}",
  );
  b.add("");
  b.add("impl fmt::Display for Desk {");
  b.signatures.set("fmt", b.add(
    "    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {",
  ));
  b.add("        write!(f, \"desk\")", "    }", "}", "");
  b.add("impl<'a, T: Into<i64>> From<T> for Desk where T: Copy {");
  b.signatures.set("from", b.add("    fn from(value: T) -> Self {"));
  b.add(
    "        let _ = value.into();",
    "        Desk { billing: BillingClient::default(), stock: StockLedger::default(), delivery: DeliveryService::default() }",
    "    }", "}", "",
  );
  b.add("impl Desk {");
  const measure = (i: number): void => {
    b.add("");
    b.signatures.set(`measure${i}`, b.add(
      `    /// Measures step ${i}.`,
      `    fn measure${i}(&self, seed: i64) -> i64 {`,
    ) + 1);
    const start = b.add(...Array.from({ length: 10 }, (_, j) => `        let v${j} = seed * ${j + 3} + ${i * 7 + j} - (seed >> ${j % 5});`));
    b.filler.push({ start, end: b.line() });
    b.add(`        v0 + v9 + ${i}`, "    }");
  };
  for (let i = 0; i < fillers; i += 1) measure(i);
  b.add("");
  const cancelAt = b.add(
    "    /// Cancels an order: refund, release the stock, recall the delivery.",
    "    pub fn cancel(&self, order: &Order) {",
    "        self.billing.refund(&order.account, order.total);",
    "        self.release(order);",
    "        self.delivery.recall(order);",
    "    }",
  );
  b.signatures.set("cancel", cancelAt + 1);
  b.calls.set("self.billing.refund(", cancelAt + 2);
  b.calls.set("self.delivery.recall(", cancelAt + 4);
  b.add("}", "");
  b.foreignBlock(
    "#[cfg(test)]",
    "mod tests {",
    "    use super::*;",
    "",
    "    fn helper() -> Desk { Desk::new(a(), b(), c()) }",
    "}",
  );
  write(ws, "Cargo.toml", ["[package]", "name = \"shop\"", "version = \"0.1.0\"", "edition = \"2021\""]);
  write(ws, "src/lib.rs", ["pub mod audit;", "pub mod desk;"]);
  write(ws, RUST_DESK_FILE, b.lines);
  write(ws, RUST_DESK_AUDIT_FILE, [
    "use crate::desk::Desk;", "",
    "impl Desk {",
    "    /// Lists what the desk did; a block of Desk in another module.",
    "    pub fn audit(&self) -> Vec<String> { Vec::new() }",
    "}",
  ]);
  return {
    file: RUST_DESK_FILE, lines: b.lines, calls: b.calls, foreign: b.foreign, filler: b.filler, signatures: b.signatures, declaration,
    elsewhere: [{ file: "audit.rs", count: 1 }],
  };
}

// ===========================================================================
// C
// ===========================================================================

export const C_SCHED_FILE = "src/sched.c";
export const C_SCHED_QUERY_EN = "Explain what the big sched_s struct (in src/sched.c) does, around how it calls timer / queue / clock and in what order — briefly, as a map of its structure (under 40 lines). No code changes.";

/** A C struct with Allman functions taking it by pointer in every spelling, other structs with their own functions between them, and `fillers` measuring functions that call nothing. */
export function writeCSched(ws: string, fillers = 24): OutOfLineDesk {
  const b = new Builder();
  b.add("#include <stdlib.h>", "#include \"sched.h\"", "");
  const docStart = b.add(
    "/* The scheduler: one tick drives the timer, the queue and the clock. */",
    "struct sched_s {",
    "    int ticks;",
    "    struct sched_s *next;",
    "    struct timer_s *timer;",
    "    struct queue_s *queue;",
    "    struct clock_s *clock;",
    "};",
  );
  const declaration = { start: docStart, end: b.line() };
  b.add("", "typedef struct sched_s sched_t;", "", "extern struct sched_s *g_sched;", "");
  b.signatures.set("sched_pick", b.add(
    "static int sched_pick(struct sched_s *s)",
  ));
  b.add("{", "    return s->ticks;", "}", "");
  b.foreignBlock(
    "/* A second struct and its own function. */",
    "struct arena_s {",
    "    char *base;",
    "    long used;",
    "};",
    "",
    "static long arena_used(struct arena_s *a)",
    "{",
    "    return a->used;",
    "}",
  );
  b.add("");
  const tickAt = b.add(
    "void sched_tick(sched_t *s, int dt)",
    "{",
    "    s->clock->advance(s->clock, dt);",
    "    s->timer->arm(s->timer, dt);",
    "    s->queue->push(s->queue, s);",
    "    s->ticks += dt;",
    "}",
  );
  b.signatures.set("sched_tick", tickAt);
  b.calls.set("s->clock->advance(", tickAt + 2);
  b.calls.set("s->timer->arm(", tickAt + 3);
  b.calls.set("s->queue->push(", tickAt + 4);
  b.add("");
  b.foreignBlock(
    "static struct sched_s *sched_alloc(void) {",
    "    return malloc(sizeof(struct sched_s));",
    "}",
    "",
    "int other_fn(int x) { return x; }",
  );
  const measure = (i: number): void => {
    b.add("");
    b.signatures.set(`sched_measure${i}`, b.add(
      `/* Measures step ${i}. */`,
      `long sched_measure${i}(const struct sched_s *s, long seed)`,
    ) + 1);
    b.add("{");
    const start = b.add(...Array.from({ length: 12 }, (_, j) => `    long v${j} = seed * ${j + 3} + ${i * 7 + j} - (seed >> ${j % 5}) + s->ticks;`));
    b.filler.push({ start, end: b.line() });
    b.add(`    return v0 + v11 + ${i};`, "}");
    if (i % 8 === 7) {
      b.add("");
      b.foreignBlock(
        `struct probe${i}_s { int level; };`,
        "",
        `static int probe${i}_level(struct probe${i}_s *p) { return p->level; }`,
      );
    }
  };
  for (let i = 0; i < fillers; i += 1) measure(i);
  b.add("");
  const resetAt = b.add(
    "void sched_reset(sched_t * const s)",
    "{",
    "    s->queue->clear(s->queue);",
    "    s->timer->disarm(s->timer);",
    "    s->ticks = 0;",
    "}",
  );
  b.signatures.set("sched_reset", resetAt);
  b.calls.set("s->queue->clear(", resetAt + 2);
  b.calls.set("s->timer->disarm(", resetAt + 3);
  write(ws, C_SCHED_FILE, b.lines);
  write(ws, "src/sched.h", ["#ifndef SCHED_H", "#define SCHED_H", "struct sched_s;", "#endif"]);
  return {
    file: C_SCHED_FILE, lines: b.lines, calls: b.calls, foreign: b.foreign, filler: b.filler, signatures: b.signatures, declaration,
    elsewhere: [],
  };
}

// ===========================================================================
// C++ (the class and its out-of-line definitions in ONE file)
// ===========================================================================

export const CPP_WIDGET_FILE = "src/widget.cpp";
export const CPP_WIDGET_QUERY_EN = "Explain what the big Widget class (in src/widget.cpp) does, around how it calls timer / queue / clock and in what order — briefly, as a map of its structure (under 40 lines). No code changes.";

/** A C++ class declared with member declarations only, its constructor, destructor and methods defined below it (Allman braces), another class and its definitions between them, and `fillers` measuring methods that call nothing. */
export function writeCppWidget(ws: string, fillers = 24): OutOfLineDesk {
  const b = new Builder();
  b.add("#include \"widget.hpp\"", "");
  const declStart = b.add(
    "// Widget drives one tick through the timer, the queue and the clock.",
    "class Widget {",
    "public:",
    "    Widget(Timer* timer, Queue* queue, Clock* clock);",
    "    ~Widget();",
    "    void tick(int dt);",
    "    void reset();",
    ...Array.from({ length: fillers }, (_, i) => `    long measure${i}(long seed) const;`),
    "private:",
    "    Timer* timer_;",
    "    Queue* queue_;",
    "    Clock* clock_;",
    "    int ticks_ = 0;",
    "};",
  );
  const declaration = { start: declStart, end: b.line() };
  b.add("");
  b.signatures.set("Widget", b.add("Widget::Widget(Timer* timer, Queue* queue, Clock* clock)"));
  b.add("    : timer_(timer), queue_(queue), clock_(clock)", "{", "}", "");
  b.signatures.set("~Widget", b.add("Widget::~Widget() {}"));
  b.add("");
  b.foreignBlock(
    "// Helper is another class of the file; its definitions are not the Widget's.",
    "class Helper {",
    "public:",
    "    void run();",
    "};",
    "",
    "void Helper::run()",
    "{",
    "    work();",
    "}",
  );
  b.add("");
  const tickAt = b.add(
    "void Widget::tick(int dt)",
    "{",
    "    clock_->advance(dt);",
    "    timer_->arm(dt);",
    "    queue_->push(this);",
    "    ticks_ += dt;",
    "}",
  );
  b.signatures.set("tick", tickAt);
  b.calls.set("clock_->advance(", tickAt + 2);
  b.calls.set("timer_->arm(", tickAt + 3);
  b.calls.set("queue_->push(", tickAt + 4);
  const measure = (i: number): void => {
    b.add("");
    b.signatures.set(`measure${i}`, b.add(`long Widget::measure${i}(long seed) const`));
    b.add("{");
    const start = b.add(...Array.from({ length: 12 }, (_, j) => `    long v${j} = seed * ${j + 3} + ${i * 7 + j} - (seed >> ${j % 5}) + ticks_;`));
    b.filler.push({ start, end: b.line() });
    b.add(`    return v0 + v11 + ${i};`, "}");
    if (i % 8 === 7) {
      b.add("");
      b.foreignBlock(
        `struct Probe${i} { int level; };`,
        "",
        `static int probeLevel${i}(const Probe${i}& p) { return p.level; }`,
      );
    }
  };
  for (let i = 0; i < fillers; i += 1) measure(i);
  b.add("");
  const resetAt = b.add(
    "void Widget::reset()",
    "{",
    "    queue_->clear();",
    "    timer_->disarm();",
    "    ticks_ = 0;",
    "}",
  );
  b.signatures.set("reset", resetAt);
  b.calls.set("queue_->clear(", resetAt + 2);
  b.calls.set("timer_->disarm(", resetAt + 3);
  write(ws, CPP_WIDGET_FILE, b.lines);
  write(ws, "src/widget.hpp", ["#pragma once", "class Timer; class Queue; class Clock;"]);
  return {
    file: CPP_WIDGET_FILE, lines: b.lines, calls: b.calls, foreign: b.foreign, filler: b.filler, signatures: b.signatures, declaration,
    elsewhere: [],
  };
}
