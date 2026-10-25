/**
 * owedRowsDeskLanguages.ts — the synthetic `OrderDesk` of owedRowsDesk.ts in C# and in
 * Python, for the rows of an owed member in a language the effects were not written
 * for (2026-10-24, the generality audit): the lines the map must serve are saves
 * (`File.WriteAllText`, `Directory.CreateDirectory`, `f.write`, `session.commit`), writes
 * (`ticket.State = …`, `cache[id] = …`, `self.cache[id] = …`) and the failure handling of
 * a call (`try` / `catch` / `except`); the lines it must leave out are arithmetic.
 *
 * Every step is 22 lines of arithmetic that call nothing, one `try` that bills and
 * reserves, a handler that logs, releases and rethrows, a state write, a file write, a
 * directory creation (C#) or a commit (Python), an element write and the delivery call,
 * with a line of arithmetic between some of them.
 */
import * as fs from "node:fs";
import * as path from "node:path";

export const LANGUAGE_DESK_QUERY = "OrderDesk の state machine の transition table と、billing / stock / delivery をどう順番に呼んでいるかを中心に、何をしているクラスか短く説明して (30行以内、構造の地図として見たい)。コード変更は不要。";
export const LANGUAGE_DESK_FILLERS = 22;

export interface LanguageDeskStep {
  readonly name: string;
  /** Lines the rows must serve: their trimmed text and their line number. */
  readonly rows: ReadonlyArray<{ readonly text: string; readonly line: number }>;
  /** The block of arithmetic after the signature: far from every row, so no row holds a line of it. (Two more lines of arithmetic stand between rows; coalescing carries them.) */
  readonly filler: readonly number[];
}

export interface LanguageDesk {
  readonly file: string;
  readonly lines: string[];
  readonly steps: LanguageDeskStep[];
}

const FILLER_LINE_RE = /filler\d+_(?:\d+|tail|end)\b/u;
export const isFillerLine = (line: string): boolean => FILLER_LINE_RE.test(line);

export function csharpDesk(steps: number): LanguageDesk {
  const lines: string[] = [
    "using System.Collections.Generic;", "using System.IO;", "", "namespace Demo {",
    "    /// <summary>Runs orders from billing to delivery.</summary>",
    "    public class OrderDesk {",
    "        private static readonly Dictionary<DeskState, HashSet<DeskState>> Moves = new Dictionary<DeskState, HashSet<DeskState>>();",
    "        private readonly IBillingClient billingClient;", "        private readonly IStockLedger stockLedger;", "        private readonly IDeliveryService deliveryService;",
    "        private readonly Dictionary<long, Ticket> cache = new Dictionary<long, Ticket>();", "        private readonly string exportDir;", "",
    "        public DeskState State { get; set; }", "",
    "        public OrderDesk(IBillingClient billingClient, IStockLedger stockLedger, IDeliveryService deliveryService, string exportDir) {",
    "            this.billingClient = billingClient;", "            this.stockLedger = stockLedger;", "            this.deliveryService = deliveryService;", "            this.exportDir = exportDir;", "        }",
  ];
  const out: LanguageDeskStep[] = [];
  for (let step = 0; step < steps; step += 1) {
    const rows: Array<{ text: string; line: number }> = [];
    const filler: number[] = [];
    const row = (text: string): void => { lines.push(text); rows.push({ text: text.trim(), line: lines.length }); };
    const fill = (text: string): void => { lines.push(text); filler.push(lines.length); };
    lines.push("", `        /// <summary>Step ${step}: bills, reserves and dispatches ticket ${step}.</summary>`);
    row(`        public Ticket Step${step}(Order order) {`);
    lines.push(`            long baseValue = order.Total * ${step + 2};`);
    for (let j = 0; j < LANGUAGE_DESK_FILLERS; j += 1) fill(`            long filler${step}_${j} = baseValue * ${j + 3} + ${step * 7 + j} - (baseValue >> ${j % 5});`);
    lines.push("            Ticket ticket = tickets.Find(order.Id);");
    row("            try {");
    row("                billingClient.Charge(order.Account, baseValue);");
    row("                stockLedger.Reserve(order.Sku, order.Quantity);");
    row("            } catch (BillingException ex) {");
    row(`                log.Warn("step${step} billing failed", order.Id);`);
    row("                stockLedger.Release(order.Sku, order.Quantity);");
    row("                throw;");
    row("            }");
    lines.push(`            long filler${step}_tail = baseValue - ${step};`);
    row("            ticket.State = DeskState.Billed;");
    row("            File.WriteAllText(Path.Combine(exportDir, ticket.Id + \".json\"), ticket.ToJson());");
    row("            Directory.CreateDirectory(exportDir);");
    row("            cache[ticket.Id] = ticket;");
    lines.push(`            long filler${step}_end = baseValue / ${step + 5};`);
    row("            deliveryService.Dispatch(ticket);");
    lines.push("            return ticket;", "        }");
    out.push({ name: `Step${step}`, rows, filler });
  }
  lines.push("    }", "}", "");
  return { file: "src/Demo/OrderDesk.cs", lines, steps: out };
}

export function pythonDesk(steps: number): LanguageDesk {
  const lines: string[] = [
    "\"\"\"Runs orders from billing to delivery.\"\"\"", "from demo.model import DeskState", "", "",
    "class OrderDesk:", "    \"\"\"Runs orders from billing to delivery.\"\"\"", "",
    "    MOVES = {DeskState.OPEN: {DeskState.BILLED, DeskState.VOID}, DeskState.BILLED: {DeskState.SHIPPED, DeskState.VOID}}", "",
    "    def __init__(self, billing_client, stock_ledger, delivery_service, export_path):",
    "        self.billing_client = billing_client", "        self.stock_ledger = stock_ledger", "        self.delivery_service = delivery_service",
    "        self.export_path = export_path", "        self.cache = {}",
  ];
  const out: LanguageDeskStep[] = [];
  for (let step = 0; step < steps; step += 1) {
    const rows: Array<{ text: string; line: number }> = [];
    const filler: number[] = [];
    const row = (text: string): void => { lines.push(text); rows.push({ text: text.trim(), line: lines.length }); };
    const fill = (text: string): void => { lines.push(text); filler.push(lines.length); };
    lines.push("", `    def step${step}(self, order):`);
    lines.push(`        """Step ${step}: bills, reserves and dispatches ticket ${step}."""`);
    lines.push(`        base = order.total * ${step + 2}`);
    for (let j = 0; j < LANGUAGE_DESK_FILLERS; j += 1) fill(`        filler${step}_${j} = base * ${j + 3} + ${step * 7 + j} - (base >> ${j % 5})`);
    lines.push("        ticket = self.tickets.find(order.id)");
    row("        try:");
    row("            self.billing_client.charge(order.account, base)");
    row("            self.stock_ledger.reserve(order.sku, order.quantity)");
    row("        except BillingError as ex:");
    row(`            self.log.warning("step${step} billing failed %s", order.id)`);
    row("            self.stock_ledger.release(order.sku, order.quantity)");
    row("            raise");
    lines.push(`        filler${step}_tail = base - ${step}`);
    row("        ticket.state = DeskState.BILLED");
    row("        with open(self.export_path, \"a\") as f:");
    row("            f.write(ticket.to_json())");
    row("        self.session.commit()");
    row("        self.cache[ticket.id] = ticket");
    lines.push(`        filler${step}_end = base // ${step + 5}`);
    row("        self.delivery_service.dispatch(ticket)");
    lines.push("        return ticket");
    out.push({ name: `step${step}`, rows, filler });
  }
  lines.push("");
  return { file: "src/demo/order_desk.py", lines, steps: out };
}

/** Writes the desk under `root`; returns it. */
export function writeLanguageDesk(root: string, desk: LanguageDesk): void {
  const file = path.join(root, desk.file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, desk.lines.join("\n"));
}
