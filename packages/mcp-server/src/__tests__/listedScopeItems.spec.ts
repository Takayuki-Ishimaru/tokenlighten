/**
 * listedScopeItems.ts's text halves (2026-10-19, v016 decision 6t-4 T09 rep 1).
 * The pack-level rule they serve — every place a request lists maps to a served
 * surface or to a row that discharges it before the pack claims coverage
 * "complete" — is pinned end to end by rc/listedScopeItems.rc.spec.ts and by
 * the replay corpus's v016ls group.
 */
import { describe, expect, it } from "vitest";
import {
  enclosingDeclaration,
  enumNamesDeclaredWith,
  listedScopeItems,
  wholeEnumAccessor,
} from "../features/task-pack/listedScopeItems.js";

// Verbatim from the recorded transcripts.
const T09_QUERY = "[実業務 新規要望] trackerly の Issue priority に 'CRITICAL' を追加したい (現状 LOW/MEDIUM/HIGH/URGENT 想定)。\n- shared enum (どこか packages/shared 配下)\n- フロントエンドの PriorityBadge コンポーネント\n- バックエンドの issue create 経路 (バリデーション含む)\npriority ごとに集計している統計/集計箇所 (per-priority の件数マップなど) もスコープ内。\n全部漏れなく対応して。どこを修正したか箇条書きで報告して。";

describe("listedScopeItems", () => {
  it("returns the T09 request's three list lines, verbatim without their markers", () => {
    expect(listedScopeItems(T09_QUERY)).toEqual([
      "shared enum (どこか packages/shared 配下)",
      "フロントエンドの PriorityBadge コンポーネント",
      "バックエンドの issue create 経路 (バリデーション含む)",
    ]);
  });

  it("needs two list lines: a lone '- x' line, or none, is prose", () => {
    expect(listedScopeItems("Add ARCHIVED to TicketState.\n- the badge component")).toEqual([]);
    expect(listedScopeItems(T09_QUERY.replace(/\n- /gu, "、"))).toEqual([]);
  });

  it("drops list lines that ask for an action or forbid one", () => {
    const query = [
      "Add ARCHIVED to TicketState.",
      "- the StateBadge component",
      "- Report what you changed",
      "- 修正箇所を箇条書きで報告して",
      "- テストも追加",
      "- do not touch the migrations",
    ].join("\n");
    expect(listedScopeItems(query)).toEqual(["the StateBadge component"]);
  });

  it("reads numbered and circled markers and skips fenced blocks", () => {
    expect(listedScopeItems("Scope:\n1. the enum\n2) the badge\n③ the report service")).toEqual([
      "the enum",
      "the badge",
      "the report service",
    ]);
    expect(listedScopeItems("Logs:\n```\n- not an item\n- nor this\n```\nThat is all.")).toEqual([]);
  });
});

describe("enumNamesDeclaredWith", () => {
  const values = new Set(["CRITICAL", "LOW", "MEDIUM", "HIGH", "URGENT"]);

  it("names the declaration whose member block holds two or more of the request's values", () => {
    const code = [
      "export const IssueStatus = {",
      "  OPEN: 'OPEN',",
      "  DONE: 'DONE',",
      "} as const;",
      "export const IssuePriority = {",
      "  NONE: 'NONE',",
      "  LOW: 'LOW',",
      "  HIGH: 'HIGH',",
      "  URGENT: 'URGENT',",
      "} as const;",
      "export type IssuePriority = (typeof IssuePriority)[keyof typeof IssuePriority];",
    ].join("\n");
    expect(enumNamesDeclaredWith(code, values)).toEqual(["IssuePriority"]);
  });

  it("reads a Python enum class and a one-line enum, and needs two members", () => {
    expect(enumNamesDeclaredWith("class Priority(Enum):\n    LOW = 'low'\n    HIGH = 'high'\n\nOTHER = 1\n", values)).toEqual(["Priority"]);
    expect(enumNamesDeclaredWith("enum Priority { LOW, MEDIUM, HIGH }", values)).toEqual(["Priority"]);
    expect(enumNamesDeclaredWith("export const Level = {\n  LOW: 1,\n  TOP: 2,\n};\n", values)).toEqual([]);
  });
});

describe("wholeEnumAccessor", () => {
  it.each([
    ["  priority: z.enum(Object.values(IssuePriority) as [IssuePriority, ...IssuePriority[]]).optional(),", "Object.values(IssuePriority)"],
    ["  priority: z.nativeEnum(IssuePriority).optional(),", "nativeEnum(IssuePriority)"],
    ["  private coercePriority(raw: string): typeof IssuePriority[keyof typeof IssuePriority] | undefined {", "keyof typeof IssuePriority"],
    ["    for (IssuePriority p : IssuePriority.values()) {", "IssuePriority.values()"],
    ["  @IsEnum(IssuePriority)", "IsEnum(IssuePriority)"],
    ["    allowed = list(IssuePriority)", "list(IssuePriority)"],
  ])("finds the accessor in %s", (line, accessor) => {
    expect(wholeEnumAccessor(line, "IssuePriority")).toBe(accessor);
  });

  it("ignores a single member, a literal list, another enum and a comment", () => {
    expect(wholeEnumAccessor("  priority: input.priority ?? IssuePriority.NONE,", "IssuePriority")).toBeUndefined();
    expect(wholeEnumAccessor("  priority: z.enum(['LOW', 'HIGH']),", "IssuePriority")).toBeUndefined();
    expect(wholeEnumAccessor("  status: z.enum(Object.values(IssueStatus)),", "IssuePriority")).toBeUndefined();
    expect(wholeEnumAccessor("  // Object.values(IssuePriority) feeds the select", "IssuePriority")).toBeUndefined();
  });
});

describe("enclosingDeclaration", () => {
  it("climbs from an object field to the schema it sits in", () => {
    const lines = [
      "export const IssueCreateSchema = z.object({",
      "  projectId: z.string().uuid(),",
      "  priority: z.enum(Object.values(IssuePriority) as [IssuePriority, ...IssuePriority[]]).optional(),",
      "});",
    ];
    expect(enclosingDeclaration(lines, 2)).toEqual({ name: "IssueCreateSchema", line: 1 });
  });

  it("climbs past a control block to the method it sits in", () => {
    const lines = [
      "export class IssueService {",
      "  /** Lists issues. */",
      "  list(query: ListIssuesQuery = {}): Paginated<IssueDto> {",
      "    if (query.priority !== undefined) {",
      "      const validPriorities = Object.values(IssuePriority);",
      "    }",
      "  }",
      "}",
    ];
    expect(enclosingDeclaration(lines, 4)).toEqual({ name: "list", line: 3 });
  });

  it("names a method declared on the line itself, and nothing for a top-level statement", () => {
    const method = ["export class IssueService {", "  private coercePriority(raw: string): typeof IssuePriority[keyof typeof IssuePriority] | undefined {"];
    expect(enclosingDeclaration(method, 1)).toEqual({ name: "coercePriority", line: 2 });
    expect(enclosingDeclaration(["router.post('/api/issues', validateBody(IssueCreateSchema), createIssue);"], 0)).toBeUndefined();
  });
});
