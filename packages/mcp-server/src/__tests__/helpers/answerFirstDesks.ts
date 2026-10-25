/**
 * answerFirstDesks.ts — synthetic types for the rule that decides whether an
 * answer-first page is ADOPTED (answerFirstAdoption.spec.ts, TL_EFF_MAP_ANSWER_FIRST,
 * 2026-10-24 generality audit follow-up).
 *
 * `OrderDesk` here is the TypeScript class of mapAnswerFirst.spec.ts (a state enum in
 * another file, constants, `steps` members that reserve, bill and ship — the last two
 * also loop — and `route`, which branches), with the knobs the audit's findings turn on:
 *
 *   `topLevel`      lines appended to the class's file: a top-level function of the SAME file.
 *   `files`         other files of the workspace: a sibling that uses the class.
 *   `ambient`       the collaborators are module-level objects, not fields the constructor receives.
 *   `extraMembers`  members appended to the class (here: one whose calls are `.map(` — a word of a request's own shape).
 *
 * A function that builds the desk, or a file that does, is a call site of `OrderDesk`, and a flow
 * question over the type requires its call sites (facetGate.ts): windows OUTSIDE the type, which an
 * answer-first page — the core of the type alone — does not hold. The same class without them is
 * the control: its page holds everything the facets require.
 */
import * as fs from "node:fs";
import * as path from "node:path";

export const AF_DESK_FILE = "src/orderDesk.ts";
export const AF_DESK_STATE_FILE = "src/deskState.ts";
export const AF_DESK_QUERY = "Give me a short overview of OrderDesk: its state transition table and how it sequences the billing / stock / delivery calls. No code changes.";

export interface AfDeskOptions {
  /**
   * The collaborators are module-level objects (`import { billing, stock, delivery } from "./services.js"`), not fields the
   * constructor receives: the class has no collaborator field, and its concern calls hang from a name that is neither a
   * field nor a parameter of its members — the shape the collaborators rule cannot see and the named rule can.
   */
  readonly ambient?: boolean;
  /** Members appended to the class, last (`  name() { … }` lines, indented as the class's members are). */
  readonly extraMembers?: readonly string[];
  /** Lines appended to `src/orderDesk.ts` after the class. */
  readonly topLevel?: readonly string[];
  /** More files, by workspace-relative path. */
  readonly files?: Readonly<Record<string, string>>;
}

export interface AfDesk {
  /** The source lines of `src/orderDesk.ts`, 1-based line N being `[N - 1]`. */
  readonly lines: string[];
  /** The line of each `step{n}` member's signature, and the closing brace of its body. */
  readonly steps: ReadonlyArray<{ readonly name: string; readonly signature: number; readonly end: number }>;
}

/** Writes the desk (`steps` members) under `root`; returns its lines. */
export function writeAfDesk(root: string, steps: number, options: AfDeskOptions = {}): AfDesk {
  const put = (rel: string, content: string): void => {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, "utf8");
  };
  put("package.json", `${JSON.stringify({ name: "afdesk-ts", version: "1.0.0", type: "module" }, null, 2)}\n`);
  put(AF_DESK_STATE_FILE, ["/** The states one order moves through. */", "export enum DeskState {", "  Open = \"open\",", "  Billed = \"billed\",", "  Shipped = \"shipped\",", "  Void = \"void\",", "}", ""].join("\n"));
  const ambient = options.ambient === true;
  const via = ambient ? "" : "this.";
  const lines: string[] = [
    "import { DeskState } from \"./deskState.js\";", ...(ambient ? ["import { billing, stock, delivery } from \"./services.js\";"] : []), "",
    "/** Runs orders from billing to delivery. */",
    "export class OrderDesk {",
    "  private static readonly MAX_TRIES = 3;",
    "  private static readonly NOTE_VOID = \"void\";",
    "  private readonly moves: Map<DeskState, DeskState[]> = new Map();", "",
    ambient ? "  constructor() {" : "  constructor(private readonly billing: Billing, private readonly stock: Stock, private readonly delivery: Delivery) {",
    "    this.moves.set(DeskState.Open, [DeskState.Billed, DeskState.Void]);",
    "    this.moves.set(DeskState.Billed, [DeskState.Shipped, DeskState.Void]);",
    "  }",
  ];
  const placed: Array<{ name: string; signature: number; end: number }> = [];
  for (let step = 0; step < steps; step++) {
    lines.push("", `  /** Step ${step}: bills, reserves and ships order ${step}. */`, `  step${step}(order: Order): Ticket {`);
    const signature = lines.length;
    lines.push(`    const base = order.total * ${step + 2};`);
    for (let j = 0; j < 22; j++) lines.push(`    const filler${step}_${j} = base * ${j + 3} + ${step * 7 + j} - (base >> ${j % 5});`);
    if (step >= steps - 2) lines.push("    for (let attempt = 1; attempt <= OrderDesk.MAX_TRIES; attempt++) {", "      if (attempt < OrderDesk.MAX_TRIES) { this.wait(base * attempt); }", "    }");
    lines.push(`    ${via}stock.reserve(order.sku);`, "    try {", `      ${via}billing.charge(order.account, base);`, "    } catch (error) {", `      ${via}stock.release(order.sku);`, "      throw error;", "    }", "    const ticket = new Ticket(order, OrderDesk.NOTE_VOID);", `    ${via}delivery.ship(ticket);`, "    return ticket;", "  }");
    placed.push({ name: `step${step}`, signature, end: lines.length });
    // The member after step0 branches: the cases of one switch and the arms of one if/else are alternatives, not a sequence.
    if (step === 0) {
      lines.push(
        "", "  /** Routes an order by what happened to it. */", "  route(order: Order, event: string): void {",
        "    switch (event) {",
        "      case \"refund\":", `        ${via}billing.refund(order.account);`, "        break;",
        "      case \"recall\":", `        ${via}delivery.recall(order.id);`, "        break;",
        "      default:", `        ${via}stock.release(order.sku);`,
        "    }",
        "    if (order.void) {", `      ${via}stock.restore(order.sku);`, "    } else {", `      ${via}billing.settle(order.account);`, "    }",
        "    order.note = OrderDesk.NOTE_VOID;",
        "  }",
      );
    }
  }
  if ((options.extraMembers ?? []).length > 0) lines.push("", ...options.extraMembers!);
  lines.push("}", "", ...(options.topLevel ?? []), "");
  put(AF_DESK_FILE, lines.join("\n"));
  if (ambient) put("src/services.ts", ["export const billing = { charge(account: string, amount: number) {}, refund(account: string) {}, settle(account: string) {} };", "export const stock = { reserve(sku: string) {}, release(sku: string) {}, restore(sku: string) {} };", "export const delivery = { ship(ticket: unknown) {}, recall(id: string) {} };", ""].join("\n"));
  for (const [rel, content] of Object.entries(options.files ?? {})) put(rel, content);
  return { lines, steps: placed };
}

/** A top-level function of the desk's own file that builds the desk and bills through the collaborator it was given. */
export const AF_TOP_LEVEL_FUNCTION: readonly string[] = [
  "/** Opens a desk and bills the first order. */",
  "export function openDesk(billing: Billing, stock: Stock, delivery: Delivery, order: Order): Ticket {",
  "  const desk = new OrderDesk(billing, stock, delivery);",
  "  billing.charge(order.account, order.total);",
  "  return desk.step0(order);",
  "}",
];

/** A sibling file that builds the desk and warms the billing client up. */
export const AF_SIBLING_FILE: Readonly<Record<string, string>> = {
  "src/factory.ts": [
    "import { OrderDesk } from \"./orderDesk.js\";", "",
    "export function makeDesk(billing: Billing, stock: Stock, delivery: Delivery): OrderDesk {",
    "  billing.warmUp();",
    "  return new OrderDesk(billing, stock, delivery);",
    "}", "",
  ].join("\n"),
};
