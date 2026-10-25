// editContextDeclarations.spec.ts — an edit pack's context serves whole
// declarations, not a definition's code lines (2026-10-20, decision runs 6t-4
// to 6t-7, T07 arm A; readCodeTaskPack.ts `editContextCandidates`).
//
// The fixture is T07's shape in miniature: Tally (the edit target) returns a
// same-package Sheet whose doc states Net's sign, converts to an enum type
// declared in another package (`entry.Side(…)`), calls Minus on a field of
// that Sheet and String on a value of either of two types that declare it.
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { resetAll } from "../util/session.js";
import { callTool } from "../server.js";
import { shortTmpDir } from "./helpers/shortTmpDir.js";
import { rmDirWithRetry } from "./helpers/rmDirWithRetry.js";

const HOME = process.env["HOME"] ?? process.env["USERPROFILE"] ?? os.homedir();
const tmpDirs: string[] = [];

beforeEach(() => resetAll());
afterAll(async () => {
  for (const dir of tmpDirs.splice(0)) {
    try { await rmDirWithRetry(dir); } catch { /* best-effort cleanup */ }
  }
});

const TALLY_FILES: Readonly<Record<string, string>> = {
  "go.mod": "module example.com/tally\n\ngo 1.22\n",
  "amount/amount.go": [
    "package amount",
    "",
    "import (",
    "\t\"errors\"",
    "\t\"fmt\"",
    "\t\"strconv\"",
    "\t\"strings\"",
    ")",
    "",
    "// ErrMismatch is returned when two amounts carry different units.",
    "var ErrMismatch = errors.New(\"unit mismatch\")",
    "",
    "// Amount is a quantity in milli-units of one unit.",
    "type Amount struct {",
    "\tMilli int64",
    "\tUnit  string",
    "}",
    "",
    "// Parse reads \"12.345 kg\" into an Amount.",
    "func Parse(s string) (Amount, error) {",
    "\tfields := strings.Fields(strings.TrimSpace(s))",
    "\tif len(fields) != 2 {",
    "\t\treturn Amount{}, fmt.Errorf(\"parse %q: want <number> <unit>\", s)",
    "\t}",
    "\twhole, frac, _ := strings.Cut(fields[0], \".\")",
    "\tfor len(frac) < 3 {",
    "\t\tfrac += \"0\"",
    "\t}",
    "\tif len(frac) > 3 {",
    "\t\treturn Amount{}, fmt.Errorf(\"parse %q: at most three decimals\", s)",
    "\t}",
    "\tw, err := strconv.ParseInt(whole, 10, 64)",
    "\tif err != nil {",
    "\t\treturn Amount{}, fmt.Errorf(\"parse %q: %w\", s, err)",
    "\t}",
    "\tf, err := strconv.ParseInt(frac, 10, 64)",
    "\tif err != nil {",
    "\t\treturn Amount{}, fmt.Errorf(\"parse %q: %w\", s, err)",
    "\t}",
    "\tmilli := w*1000 + f",
    "\tif strings.HasPrefix(whole, \"-\") {",
    "\t\tmilli = w*1000 - f",
    "\t}",
    "\treturn Amount{Milli: milli, Unit: fields[1]}, nil",
    "}",
    "",
    "// String formats the amount as \"12.345 kg\".",
    "func (a Amount) String() string {",
    "\tsign, m := \"\", a.Milli",
    "\tif m < 0 {",
    "\t\tsign, m = \"-\", -m",
    "\t}",
    "\treturn fmt.Sprintf(\"%s%d.%03d %s\", sign, m/1000, m%1000, a.Unit)",
    "}",
    "",
    "// Plus returns a + b, or ErrMismatch if the units differ.",
    "func (a Amount) Plus(b Amount) (Amount, error) {",
    "\tif a.Unit != b.Unit {",
    "\t\treturn Amount{}, fmt.Errorf(\"plus %s + %s: %w\", a.Unit, b.Unit, ErrMismatch)",
    "\t}",
    "\treturn Amount{Milli: a.Milli + b.Milli, Unit: a.Unit}, nil",
    "}",
    "",
    "// Minus returns a - b, or ErrMismatch if the units differ.",
    "func (a Amount) Minus(b Amount) (Amount, error) {",
    "\tif a.Unit != b.Unit {",
    "\t\treturn Amount{}, fmt.Errorf(\"minus %s - %s: %w\", a.Unit, b.Unit, ErrMismatch)",
    "\t}",
    "\treturn Amount{Milli: a.Milli - b.Milli, Unit: a.Unit}, nil",
    "}",
    "",
    "// Round rounds the amount to whole units, halves away from zero.",
    "func (a Amount) Round() Amount {",
    "\tm := a.Milli",
    "\tneg := m < 0",
    "\tif neg {",
    "\t\tm = -m",
    "\t}",
    "\tm = (m + 500) / 1000 * 1000",
    "\tif neg {",
    "\t\tm = -m",
    "\t}",
    "\treturn Amount{Milli: m, Unit: a.Unit}",
    "}",
    "",
  ].join("\n"),
  "entry/entry.go": [
    "package entry",
    "",
    "import (",
    "\t\"fmt\"",
    "\t\"sort\"",
    "",
    "\t\"example.com/tally/amount\"",
    ")",
    "",
    "// Side says which column of the ledger an entry posts to.",
    "type Side int",
    "",
    "const (",
    "\tDebit  Side = 1 // left column",
    "\tCredit Side = 2 // right column",
    ")",
    "",
    "// String names the side.",
    "func (s Side) String() string {",
    "\tswitch s {",
    "\tcase Debit:",
    "\t\treturn \"debit\"",
    "\tcase Credit:",
    "\t\treturn \"credit\"",
    "\t}",
    "\treturn fmt.Sprintf(\"Side(%d)\", int(s))",
    "}",
    "",
    "// Entry is one posting of an amount to an account.",
    "type Entry struct {",
    "\tAccount string",
    "\tSide    Side",
    "\tValue   amount.Amount",
    "}",
    "",
    "// Sorted returns a copy of es ordered by account, then side, then value.",
    "func Sorted(es []Entry) []Entry {",
    "\tout := append([]Entry(nil), es...)",
    "\tsort.SliceStable(out, func(i, j int) bool {",
    "\t\tif out[i].Account != out[j].Account {",
    "\t\t\treturn out[i].Account < out[j].Account",
    "\t\t}",
    "\t\tif out[i].Side != out[j].Side {",
    "\t\t\treturn out[i].Side < out[j].Side",
    "\t\t}",
    "\t\treturn out[i].Value.Milli < out[j].Value.Milli",
    "\t})",
    "\treturn out",
    "}",
    "",
    "// Validate rejects an entry with no account, an unknown side or a",
    "// non-positive value; a batch is checked entry by entry, in order.",
    "func Validate(es []Entry) error {",
    "\tfor i, e := range es {",
    "\t\tif e.Account == \"\" {",
    "\t\t\treturn fmt.Errorf(\"entry %d: no account\", i)",
    "\t\t}",
    "\t\tif e.Side != Debit && e.Side != Credit {",
    "\t\t\treturn fmt.Errorf(\"entry %d (%s): unknown side %d\", i, e.Account, int(e.Side))",
    "\t\t}",
    "\t\tif e.Value.Milli <= 0 {",
    "\t\t\treturn fmt.Errorf(\"entry %d (%s): value %s is not positive\", i, e.Account, e.Value)",
    "\t\t}",
    "\t}",
    "\treturn nil",
    "}",
    "",
    "// Accounts lists the distinct accounts es posts to, in first-use order.",
    "func Accounts(es []Entry) []string {",
    "\tseen := map[string]bool{}",
    "\tvar out []string",
    "\tfor _, e := range es {",
    "\t\tif !seen[e.Account] {",
    "\t\t\tseen[e.Account] = true",
    "\t\t\tout = append(out, e.Account)",
    "\t\t}",
    "\t}",
    "\treturn out",
    "}",
    "",
    "// Columns sums es per side, in milli-units, without checking units.",
    "func Columns(es []Entry) (left, right int64) {",
    "\tfor _, e := range es {",
    "\t\tswitch e.Side {",
    "\t\tcase Debit:",
    "\t\t\tleft += e.Value.Milli",
    "\t\tcase Credit:",
    "\t\t\tright += e.Value.Milli",
    "\t\t}",
    "\t}",
    "\treturn left, right",
    "}",
    "",
  ].join("\n"),
  "ledger/account.go": [
    "package ledger",
    "",
    "import \"example.com/tally/entry\"",
    "",
    "// Kind classifies an account.",
    "type Kind int",
    "",
    "const (",
    "\tKindAsset Kind = iota + 1",
    "\tKindLiability",
    "\tKindIncome",
    ")",
    "",
    "// Normal returns the side that increases an account of this kind.",
    "func (k Kind) Normal() entry.Side {",
    "\tif k == KindAsset {",
    "\t\treturn entry.Debit",
    "\t}",
    "\treturn entry.Credit",
    "}",
    "",
    "// Account is one ledger account.",
    "type Account struct {",
    "\tID   string",
    "\tKind Kind",
    "}",
    "",
  ].join("\n"),
  "sheet/sheet.go": [
    "// Package sheet totals ledger entries into one sheet per account. It",
    "// depends on amount, entry and ledger, and nothing depends on it.",
    "package sheet",
    "",
    "import (",
    "\t\"errors\"",
    "\t\"fmt\"",
    "",
    "\t\"example.com/tally/amount\"",
    "\t\"example.com/tally/entry\"",
    ")",
    "",
    "// ErrUnit is returned when an entry's unit differs from the sheet's.",
    "var ErrUnit = errors.New(\"sheet unit mismatch\")",
    "",
    "// Sheet is one account's running totals.",
    "type Sheet struct {",
    "\tAccount string",
    "\tLeft    amount.Amount // sum of debit entries",
    "\tRight   amount.Amount // sum of credit entries",
    "\t// Net is signed by the account's normal side:",
    "\t//   debit-normal  -> Net = Left - Right",
    "\t//   credit-normal -> Net = Right - Left",
    "\tNet amount.Amount",
    "}",
    "",
    "// Add posts one entry and recomputes Net for the given normal side:",
    "//   - entry.Debit  -> Net = Left - Right",
    "//   - entry.Credit -> Net = Right - Left",
    "func (s *Sheet) Add(e entry.Entry, normal entry.Side) error {",
    "\tif e.Value.Unit != s.Left.Unit {",
    "\t\treturn fmt.Errorf(\"add to sheet %s: %w\", s.Account, ErrUnit)",
    "\t}",
    "\tvar err error",
    "\tswitch e.Side {",
    "\tcase entry.Debit:",
    "\t\ts.Left, err = s.Left.Plus(e.Value)",
    "\tcase entry.Credit:",
    "\t\ts.Right, err = s.Right.Plus(e.Value)",
    "\tdefault:",
    "\t\treturn fmt.Errorf(\"add to sheet %s: unknown side %d\", s.Account, e.Side)",
    "\t}",
    "\tif err != nil {",
    "\t\treturn fmt.Errorf(\"add to sheet %s: %w\", s.Account, err)",
    "\t}",
    "\tif normal == entry.Debit {",
    "\t\ts.Net, err = s.Left.Minus(s.Right)",
    "\t} else {",
    "\t\ts.Net, err = s.Right.Minus(s.Left)",
    "\t}",
    "\treturn err",
    "}",
    "",
    "// Reset clears the totals, keeping the account and its unit.",
    "func (s *Sheet) Reset() {",
    "\tunit := s.Left.Unit",
    "\ts.Left = amount.Amount{Unit: unit}",
    "\ts.Right = amount.Amount{Unit: unit}",
    "\ts.Net = amount.Amount{Unit: unit}",
    "}",
    "",
  ].join("\n"),
  "sheet/tally.go": [
    "package sheet",
    "",
    "import (",
    "\t\"fmt\"",
    "",
    "\t\"example.com/tally/amount\"",
    "\t\"example.com/tally/entry\"",
    "\t\"example.com/tally/ledger\"",
    ")",
    "",
    "// Tally folds the entries of one account into a Sheet in the given unit.",
    "func Tally(acct ledger.Account, es []entry.Entry, unit string) (Sheet, error) {",
    "\t// Every account is summed debit-normal; Add flips the sign itself.",
    "\tnormal := entry.Side(entry.Debit)",
    "\ts := Sheet{Account: acct.ID, Left: amount.Amount{Unit: unit}, Right: amount.Amount{Unit: unit}}",
    "\tfor i, e := range es {",
    "\t\tif err := s.Add(e, normal); err != nil {",
    "\t\t\treturn Sheet{}, fmt.Errorf(\"tally %s, entry %d (%s): %w\", acct.ID, i, e.Side.String(), err)",
    "\t\t}",
    "\t}",
    "\tvar err error",
    "\ts.Net, err = s.Left.Minus(s.Right)",
    "\treturn s, err",
    "}",
    "",
  ].join("\n"),
};

// The one target a caller names alongside the request gets its edit context
// as a located one does (simpleBench1016.spec.ts covers both routes).
const FIX_QUERY = "Net comes out with the wrong sign: it goes down while the right column grows. Fix the sign in Tally.";
const FIX_TARGETS = [{ path: "sheet/tally.go" }];

function tallyWorkspace(): string {
  const ws = fs.realpathSync(shortTmpDir(HOME, ".tl-ectx-"));
  tmpDirs.push(ws);
  for (const [rel, text] of Object.entries(TALLY_FILES)) {
    const abs = path.join(ws, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text, "utf8");
  }
  return ws;
}

async function pack(args: Record<string, unknown>): Promise<any> {
  const result = await callTool("tl_read_file", args) as { content: Array<{ text: string }> };
  return JSON.parse(result.content[0]!.text);
}

const contextRows = (body: any): any[] => (body.evidence ?? []).filter((row: any) => String(row.why ?? "").startsWith("edit-context"));
const rowsOf = (body: any, rel: string): any[] => contextRows(body).filter((row) => row.path === rel);
const bodyOf = (rows: readonly any[]): string => rows.map((row) => String(row.body ?? "")).join("\n");
const lineCount = (rel: string): number => TALLY_FILES[rel]!.replace(/\n$/, "").split("\n").length;
const bytesOf = (rel: string): number => Buffer.byteLength(TALLY_FILES[rel]!, "utf8");
const span = (rel: string, first: string, last: string): number => {
  const text = TALLY_FILES[rel]!;
  return Buffer.byteLength(text.slice(text.indexOf(first), text.indexOf(last) + last.length), "utf8");
};

describe("edit context — whole declarations the edit target uses", () => {
  it("serves the target's own result type with its doc, the enum it converts to with its constants, and the method it calls on a field", async () => {
    const body = await pack({ cwd: tallyWorkspace(), query: FIX_QUERY, targets: FIX_TARGETS, task: { epoch: "new" } });
    const dump = JSON.stringify(body).slice(0, 1500);
    expect(body.decision?.kind, dump).toBe("act.edit");
    expect((body.decision?.frontier ?? []).map((entry: { path: string }) => entry.path), dump).toEqual(["sheet/tally.go"]);

    // Sheet is Tally's result type in its own package: no import names it.
    // With Add, what Tally needs of sheet.go leaves less than 1,600 B of a
    // file over 1,600 B, so the whole file rides.
    const sheet = rowsOf(body, "sheet/sheet.go");
    expect(bytesOf("sheet/sheet.go")).toBeGreaterThan(1_600);
    expect(bytesOf("sheet/sheet.go") - span("sheet/sheet.go", "// Sheet is one", "\treturn err\n}")).toBeLessThanOrEqual(1_600);
    expect(sheet.map((row) => row.range), dump).toEqual([`1-${lineCount("sheet/sheet.go")}`]);
    expect(String(sheet[0]!.why)).toMatch(/^edit-context: Add, Sheet\b.* \(used by Tally\)$/);
    expect(bodyOf(sheet)).toContain("//   credit-normal -> Net = Right - Left");

    // entry.Side(…) is a conversion, not a call: the type, its doc and its
    // const block, one window; Entry beside it with its doc. Not the file,
    // whose other 1,600 B and more Tally does not use.
    expect(bytesOf("entry/entry.go") - span("entry/entry.go", "// Side says", "right column\n)") - span("entry/entry.go", "// Entry is one", "amount.Amount\n}")).toBeGreaterThan(1_600);
    const entry = rowsOf(body, "entry/entry.go");
    expect(entry.map((row) => row.range), dump).not.toContain(`1-${lineCount("entry/entry.go")}`);
    expect(bodyOf(entry)).toContain("// Side says which column of the ledger an entry posts to.\ntype Side int\n\nconst (\n\tDebit  Side = 1 // left column\n\tCredit Side = 2 // right column\n)");
    expect(bodyOf(entry)).toContain("// Entry is one posting of an amount to an account.\ntype Entry struct {");
    expect(bodyOf(entry)).not.toContain("func Sorted(");

    // s.Left.Minus(…): a method of amount.Amount, Sheet's field type, the one
    // Minus there is, with its doc. String is declared on Amount and on Side,
    // both types Tally handles: no guess, so neither rides.
    expect(bytesOf("amount/amount.go") - span("amount/amount.go", "// Amount is a quantity", "Unit  string\n}") - span("amount/amount.go", "// Minus returns", "a.Milli - b.Milli, Unit: a.Unit}, nil\n}")).toBeGreaterThan(1_600);
    const amount = rowsOf(body, "amount/amount.go");
    expect(amount.map((row) => row.range), dump).not.toContain(`1-${lineCount("amount/amount.go")}`);
    expect(bodyOf(amount)).toContain("// Minus returns a - b, or ErrMismatch if the units differ.\nfunc (a Amount) Minus(b Amount) (Amount, error) {");
    expect(bodyOf(contextRows(body))).not.toContain("String() string {");
    expect(bodyOf(amount)).not.toContain("func Parse(");

    // A small file is still served whole.
    expect(rowsOf(body, "ledger/account.go").map((row) => row.range)).toEqual([`1-${lineCount("ledger/account.go")}`]);

    // Bounded as before: six windows, 6,000 body bytes; review-only.
    expect(contextRows(body).length).toBeLessThanOrEqual(6);
    expect(contextRows(body).reduce((sum, row) => sum + Buffer.byteLength(String(row.body ?? ""), "utf8"), 0)).toBeLessThanOrEqual(6_000);
    expect((body.decision?.frontier ?? []).map((entry: { path: string }) => entry.path)).not.toContain("sheet/sheet.go");
  });

  it("serves none of it to a read-only question about the same function", async () => {
    const body = await pack({ cwd: tallyWorkspace(), query: "How does Tally in sheet/tally.go sign Net for a credit-normal account?", task: { epoch: "new", profile: "answer" } });
    expect(contextRows(body), JSON.stringify(body).slice(0, 800)).toEqual([]);
  });
});
