/**
 * twoPageDesk.ts — a synthetic type whose owed rows span exactly TWO
 * continuation pages under the Copilot CLI ceiling (codex-copilot-proxy r18 T03,
 * 2026-10-23).
 *
 * The specs that exercise the published batch (`decision.next[]` of two sibling
 * cursors: reuse of the outstanding sibling, the cwd-less alias, CAS, a stale
 * source, a smaller budget) used the T03 cell as their vehicle, because its two
 * continuation pages were whole member bodies. A map now owes those members as
 * rows (structureMap.ts `StructureMapBodies`), T03's rows fit ONE page, and T03
 * no longer publishes siblings. The sibling machinery is unchanged, and it still
 * runs for a type whose rows do not fit one page: this one. `FulfillmentDesk`
 * has the shape structureMapAnswer.spec.ts uses (a transition table over an
 * imported enum, an `open` flow, constructor wiring) and six `step*` members,
 * each a block of 55 consecutive billing calls inside a try with its handler: a
 * row is one contiguous window per member, so a page costs its source bytes and
 * little addressing, and the six together are about 32 KB, more than the first
 * page and one continuation page can hold.
 *
 * Measured with TOKENLIGHTEN_CLIENT_ID=copilot-cli (2026-10-23): the first reply
 * is a discover whose `next` is two sibling cursors (16.7 KB), the first sibling
 * a discover of 17.7 KB restating the other, the other the act.answer.
 */
import * as fs from "node:fs";
import * as path from "node:path";

export const TWO_PAGE_DESK_FILE = "src/main/java/demo/FulfillmentDesk.java";
export const TWO_PAGE_DESK_STATE_FILE = "src/main/java/demo/model/DeskState.java";
export const TWO_PAGE_DESK_QUERY = "FulfillmentDesk の state machine の transition table と、billing / stock / delivery をどう順番に呼んでいるかを中心に、何をしているクラスか短く説明して (30行以内)。コード変更は不要。";
export const TWO_PAGE_DESK_STEPS = 6;
export const TWO_PAGE_DESK_STEP_CALLS = 55;

/** The class's source lines, 1-based line N being `[N - 1]`. */
export function twoPageDeskLines(): string[] {
  const lines = [
    "package demo;", "",
    "import demo.model.DeskState;", "import java.util.EnumMap;", "import java.util.Map;", "import java.util.Set;", "",
    "/**", " * Runs one fulfilment from billing to delivery.", " */",
    "public class FulfillmentDesk {", "",
    "    private final BillingClient billingClient;", "    private final StockLedger stockLedger;", "    private final DeliveryService deliveryService;", "",
    "    private static final Map<DeskState, Set<DeskState>> MOVES = new EnumMap<>(DeskState.class);", "",
    "    public FulfillmentDesk(BillingClient billingClient, StockLedger stockLedger, DeliveryService deliveryService) {",
    "        this.billingClient = billingClient;", "        this.stockLedger = stockLedger;", "        this.deliveryService = deliveryService;", "    }", "",
    "    /** Opens a ticket and drives it to delivery. */",
    "    public Ticket open(Order order) {", "        Ticket ticket = new Ticket(order);", "        stockLedger.reserve(order.sku(), order.quantity());",
    "        try {", "            billingClient.charge(order.account(), order.total());", "        } catch (BillingException ex) {",
    "            stockLedger.release(order.sku(), order.quantity());", "            throw ex;", "        }",
    "        deliveryService.dispatch(ticket);", "        return ticket;", "    }",
  ];
  for (let step = 0; step < TWO_PAGE_DESK_STEPS; step += 1) {
    lines.push("", `    /** Step ${step}. */`, `    public void step${step}(Order order) {`, "        try {");
    for (let call = 0; call < TWO_PAGE_DESK_STEP_CALLS; call += 1) {
      lines.push(`            billingClient.charge(order.account(), order.total() + ${step * 1000 + call}, "reference-${step}-${call}");`);
    }
    lines.push("        } catch (BillingException ex) {", "            stockLedger.release(order.sku(), order.quantity());", "            throw ex;", "        }", "    }");
  }
  lines.push("}", "");
  return lines;
}

/** Writes the class and its state enum under `root`. */
export function writeTwoPageDesk(root: string): void {
  const file = path.join(root, TWO_PAGE_DESK_FILE);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, twoPageDeskLines().join("\n"));
  const state = path.join(root, TWO_PAGE_DESK_STATE_FILE);
  fs.mkdirSync(path.dirname(state), { recursive: true });
  fs.writeFileSync(state, "package demo.model;\n\n/** States. */\npublic enum DeskState {\n    OPEN,\n    BILLED,\n    SHIPPED,\n    VOID;\n}\n");
}

/** A row of the class by number: every line that calls billing, stock or delivery, and the try / catch / throw lines of the members. */
export function twoPageDeskRowLines(): number[] {
  const lines = twoPageDeskLines();
  const rows: number[] = [];
  lines.forEach((text, index) => {
    if (index < 24) return;
    if (/\b(?:billingClient|stockLedger|deliveryService)\./u.test(text) || /^\s*(?:try \{|\} catch \(|throw ex;)/u.test(text)) rows.push(index + 1);
  });
  return rows;
}
