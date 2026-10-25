/**
 * pyOwedRowsDesk.ts — owedRowsDesk.ts's `OrderDesk` in Python (2026-10-24, the
 * structure map under VS Code's 14,336 B ceiling): a transition table over an
 * imported enum, collaborators injected through `__init__`, and `steps` flow
 * members `step0 … step{n-1}`. Every step is `PY_DESK_FILLERS` lines of arithmetic
 * that call nothing, then one `try` that bills and reserves, a handler that logs,
 * releases and re-raises, three state writes, a save, an audit, the delivery call
 * and a closing return. 16 steps are 694 lines, the "700-line Python class" of
 * structureMapCeiling.spec.ts.
 *
 * The generator returns, with the lines, what each step contributes by line
 * number: `rows` (the signature, the concern calls, the failure handling, the
 * state writes, the save, the audit and the delivery call — what a map requires of
 * a member) and `filler`, so a spec states what a chain served without re-deriving
 * the rule. The load of the ticket is neither: Java's `ticketRepository.load` is a
 * row by the `*Repository` name (memberRows.ts), a collaborator named `tickets` is not.
 * The closing `return` is left out of `rows`, as owedRowsDesk.ts leaves it out.
 */
import * as fs from "node:fs";
import * as path from "node:path";

export const PY_DESK_FILE = "src/demo/order_desk.py";
export const PY_DESK_STATE_FILE = "src/demo/desk_state.py";
export const PY_DESK_QUERY = "Give me a short overview of OrderDesk: its state transition table and how it sequences the billing / stock / delivery calls. No code changes.";
/** Lines of arithmetic that call nothing, per step. */
export const PY_DESK_FILLERS = 22;
/** What a line of arithmetic looks like. */
export const PY_DESK_FILLER_RE = /filler\d+_\d+ =/u;

export interface PyDeskStep {
  readonly name: string;
  /** The `def` line. */
  readonly signature: number;
  /** Lines a map requires: the signature, concern calls, failure handling, state writes, save, audit and delivery call. */
  readonly rows: readonly number[];
  /** The block of arithmetic after the signature: no row holds a line of it. */
  readonly filler: readonly number[];
  readonly start: number;
  readonly end: number;
}

export interface PyDesk {
  readonly lines: string[];
  readonly steps: PyDeskStep[];
  /** The first line of the first step: everything before it is the class's header. */
  readonly headerEnd: number;
}

export function pyOwedRowsDesk(steps: number): PyDesk {
  const lines: string[] = [
    "import logging", "",
    "from .desk_state import DeskState", "",
    "log = logging.getLogger(__name__)", "", "",
    "class OrderDesk:",
    '    """Runs orders from billing to delivery."""', "",
    "    MOVES = {",
    "        DeskState.OPEN: {DeskState.BILLED, DeskState.VOID},",
    "        DeskState.BILLED: {DeskState.SHIPPED, DeskState.VOID},",
    "        DeskState.SHIPPED: set(),",
    "        DeskState.VOID: set(),",
    "    }", "",
    "    def __init__(self, billing, stock, delivery, tickets):",
    "        self.billing = billing", "        self.stock = stock", "        self.delivery = delivery", "        self.tickets = tickets",
  ];
  const headerEnd = lines.length;
  const out: PyDeskStep[] = [];
  for (let step = 0; step < steps; step += 1) {
    const rows: number[] = [];
    const filler: number[] = [];
    const at = (): number => lines.length;
    const row = (text: string): void => { lines.push(text); rows.push(at()); };
    const fill = (text: string): void => { lines.push(text); filler.push(at()); };
    lines.push("");
    const start = at() + 1;
    row(`    def step${step}(self, order):`);
    const signature = at();
    lines.push(`        """Step ${step}: bills, reserves and dispatches ticket ${step}."""`);
    lines.push(`        base = order.total * ${step + 2}`);
    for (let j = 0; j < PY_DESK_FILLERS; j += 1) fill(`        filler${step}_${j} = base * ${j + 3} + ${step * 7 + j} - (base >> ${j % 5})`);
    lines.push("        ticket = self.tickets.load(order.id)");
    row("        try:");
    row("            self.billing.charge(order.account, base)");
    row("            self.stock.reserve(order.sku, order.quantity)");
    row("        except BillingError:");
    row(`            log.warning("step${step} billing failed for %s", order.id)`);
    row("            self.stock.release(order.sku, order.quantity)");
    row("            raise");
    lines.push(`        filler${step}_tail = base - ${step}`);
    row("        ticket.state = DeskState.BILLED");
    row("        ticket.billed_at = clock.now()");
    row("        self.tickets.save(ticket)");
    row(`        audit_trail("step${step}", ticket.id)`);
    lines.push(`        filler${step}_end = base // ${step + 5}`);
    row("        self.delivery.dispatch(ticket)");
    lines.push("        return ticket");
    out.push({ name: `step${step}`, signature, rows, filler, start, end: at() });
  }
  lines.push("");
  return { lines, steps: out, headerEnd };
}

/** Writes the class and its state enum under `root`; returns what each step contributes. */
export function writePyOwedRowsDesk(root: string, steps: number): PyDesk {
  const desk = pyOwedRowsDesk(steps);
  const file = path.join(root, PY_DESK_FILE);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, desk.lines.join("\n"));
  fs.writeFileSync(path.join(path.dirname(file), "__init__.py"), "");
  fs.writeFileSync(path.join(root, PY_DESK_STATE_FILE), [
    "from enum import Enum", "", "", "class DeskState(Enum):", '    """The states one fulfilment moves through."""', "",
    '    OPEN = "open"', '    BILLED = "billed"', '    SHIPPED = "shipped"', '    VOID = "void"', "",
  ].join("\n"));
  return desk;
}
