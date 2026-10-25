/**
 * owedRowsDesk.ts — a synthetic type for the rule that decides how a structure
 * map OWES the members its first page does not hold (codex-copilot-proxy r18
 * T03, 2026-10-23): as their ROWS when those rows fit one continuation page, as
 * their WHOLE bodies when they do not (readCodeTaskPack.ts `owedRowsFitOnePage`).
 *
 * `OrderDesk` has the shape the T03 class has, scaled: a transition table over
 * an imported enum, collaborators injected through the constructor and a
 * repository, and `steps` flow members `step0 … step{n-1}`. Every step is
 * `FILLERS` lines of arithmetic that call nothing (the lines rows leave out),
 * then one `try` that bills and reserves, a handler that logs, releases and
 * rethrows, three state writes, a save, an audit, the delivery call and a
 * closing return. The page of a Copilot CLI reply holds the first six or so
 * steps whole; every later step is owed.
 *
 * The generator returns, with the lines, what each step contributes by line
 * number: `rows` (the signature, the concern calls, the failure handling, the
 * state writes, the save, the audit and the delivery call) and `filler`, so a
 * spec states what a branch serves without re-deriving the rule.
 *
 * `guards` (2026-10-23, independent review of T03 A/B, F5): the last `guards`
 * steps (at most four: more and the analyzer reads none) also hold the
 * loop-guard shape javaLoopGuardReview.ts recognizes — `for (… attempt <= MAX_TRIES …)`,
 * `if (attempt < MAX_TRIES)`, `Thread.sleep(backoffMs)` — whose review note rides as
 * the `why` of the row that serves its lines (~160 B each on the continuation
 * page). They are the `guard` lines of the step, neutral to `rows` and `filler`.
 */
import * as fs from "node:fs";
import * as path from "node:path";

export const OWED_ROWS_DESK_FILE = "src/main/java/demo/OrderDesk.java";
export const OWED_ROWS_DESK_STATE_FILE = "src/main/java/demo/model/DeskState.java";
export const OWED_ROWS_DESK_QUERY = "OrderDesk の state machine の transition table と、billing / stock / delivery をどう順番に呼んでいるかを中心に、何をしているクラスか短く説明して (30行以内、構造の地図として見たい)。コード変更は不要。";
/** Lines of arithmetic that call nothing, per step. */
export const OWED_ROWS_DESK_FILLERS = 22;
/** What a line of arithmetic looks like. */
export const OWED_ROWS_DESK_FILLER_RE = /long filler\d+_\d+ =/u;

export interface OwedRowsDeskStep {
  readonly name: string;
  readonly signature: number;
  /** Lines rows serve: concern calls, failure handling, state writes, save, audit, delivery, and the signature. */
  readonly rows: readonly number[];
  /** The block of arithmetic after the signature: no row holds a line of it, and it is far from every row. */
  readonly filler: readonly number[];
  /** Two lines of arithmetic between rows: a row costs more to address than they cost to carry, so coalescing carries them. */
  readonly between: readonly number[];
  /** The lines of a loop guard (`guards` > 0 and one of the last steps): served whole as one window, neither a row nor arithmetic. */
  readonly guard: readonly number[];
  readonly start: number;
  readonly end: number;
}

export interface OwedRowsDesk {
  readonly lines: string[];
  readonly steps: OwedRowsDeskStep[];
}

export function owedRowsDesk(steps: number, guards = 0): OwedRowsDesk {
  const lines: string[] = [
    "package demo;", "",
    "import demo.model.DeskState;", "import java.util.EnumMap;", "import java.util.EnumSet;", "import java.util.Map;", "import java.util.Set;", "",
    "/**", " * Runs orders from billing to delivery.", " */",
    "public class OrderDesk {", "",
    "    private static final Logger log = LoggerFactory.getLogger(OrderDesk.class);",
    "    private final BillingClient billingClient;", "    private final StockLedger stockLedger;", "    private final DeliveryService deliveryService;",
    "    private final TicketRepository ticketRepository;", "",
    ...(guards > 0 ? ["    private static final int MAX_TRIES = 3;", ""] : []),
    "    private static final Map<DeskState, Set<DeskState>> MOVES = new EnumMap<>(DeskState.class);", "",
    "    static {",
    "        MOVES.put(DeskState.OPEN, EnumSet.of(DeskState.BILLED, DeskState.VOID));",
    "        MOVES.put(DeskState.BILLED, EnumSet.of(DeskState.SHIPPED, DeskState.VOID));",
    "        MOVES.put(DeskState.SHIPPED, EnumSet.noneOf(DeskState.class));",
    "        MOVES.put(DeskState.VOID, EnumSet.noneOf(DeskState.class));",
    "    }", "",
    "    public OrderDesk(BillingClient billingClient, StockLedger stockLedger, DeliveryService deliveryService, TicketRepository ticketRepository) {",
    "        this.billingClient = billingClient;", "        this.stockLedger = stockLedger;", "        this.deliveryService = deliveryService;",
    "        this.ticketRepository = ticketRepository;", "    }",
  ];
  const out: OwedRowsDeskStep[] = [];
  for (let step = 0; step < steps; step += 1) {
    const rows: number[] = [];
    const filler: number[] = [];
    const between: number[] = [];
    const guard: number[] = [];
    const at = (): number => lines.length;
    const row = (text: string): void => { lines.push(text); rows.push(at()); };
    const fill = (text: string): void => { lines.push(text); filler.push(at()); };
    const gap = (text: string): void => { lines.push(text); between.push(at()); };
    lines.push("", `    /** Step ${step}: bills, reserves and dispatches ticket ${step}. */`);
    const start = at();
    row(`    public Ticket step${step}(Order order) {`);
    const signature = at();
    lines.push(`        long base = order.total() * ${step + 2};`);
    for (let j = 0; j < OWED_ROWS_DESK_FILLERS; j += 1) fill(`        long filler${step}_${j} = base * ${j + 3} + ${step * 7 + j} - (base >> ${j % 5});`);
    row("        Ticket ticket = ticketRepository.load(order.id());");
    if (step >= steps - guards) {
      for (const text of [
        "        for (int attempt = 1; attempt <= MAX_TRIES; attempt++) {",
        "            long backoffMs = base * (1L << (attempt - 1));",
        "            if (attempt < MAX_TRIES) {",
        "                try {",
        "                    Thread.sleep(backoffMs);",
        "                } catch (InterruptedException ie) {",
        "                    Thread.currentThread().interrupt();",
        "                    return null;",
        "                }",
        "            }",
        "        }",
      ]) { lines.push(text); guard.push(at()); }
    }
    row("        try {");
    row("            billingClient.charge(order.account(), base);");
    row("            stockLedger.reserve(order.sku(), order.quantity());");
    row("        } catch (BillingException ex) {");
    row(`            log.warn("step${step} billing failed for {}", order.id());`);
    row("            stockLedger.release(order.sku(), order.quantity());");
    row("            throw ex;");
    row("        }");
    gap(`        long filler${step}_tail = base - ${step};`);
    row("        ticket.setState(DeskState.BILLED);");
    row("        ticket.setBilledAt(clock.now());");
    row("        ticketRepository.save(ticket);");
    row(`        auditTrail("step${step}", ticket.id());`);
    gap(`        long filler${step}_end = base / ${step + 5};`);
    row("        deliveryService.dispatch(ticket);");
    lines.push("        return ticket;", "    }");
    out.push({ name: `step${step}`, signature, rows, filler, between, guard, start, end: at() });
  }
  lines.push("}", "");
  return { lines, steps: out };
}

/** Writes the class and its state enum under `root`; returns what each step contributes. */
export function writeOwedRowsDesk(root: string, steps: number, guards = 0): OwedRowsDesk {
  const desk = owedRowsDesk(steps, guards);
  const file = path.join(root, OWED_ROWS_DESK_FILE);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, desk.lines.join("\n"));
  const state = path.join(root, OWED_ROWS_DESK_STATE_FILE);
  fs.mkdirSync(path.dirname(state), { recursive: true });
  fs.writeFileSync(state, "package demo.model;\n\n/** States. */\npublic enum DeskState {\n    OPEN,\n    BILLED,\n    SHIPPED,\n    VOID;\n}\n");
  return desk;
}
