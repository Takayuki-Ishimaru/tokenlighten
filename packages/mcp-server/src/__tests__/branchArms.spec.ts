/**
 * branchArms.spec.ts — TL_EFF_MAP_ANSWER_FIRST (2026-10-23): the ARMS of a body of
 * source (features/task-pack/branchArms.ts) as pure units — the cases of a switch and
 * the arms of an if / else if / else chain, which the answer-first call index uses to
 * say that two calls are alternatives (`notifyFulfilled` in `case FULFILLED`,
 * `release` in `case DELIVERED`) and not a sequence. The index itself is
 * answerFirstFacts.spec.ts; the T03 class is t03AnswerFirst.spec.ts.
 */
import { describe, expect, it } from "vitest";

import {
  BRANCH_ARM_LABEL_WIDTH,
  alternativeArms,
  armsAt,
  braceBlocks,
  branchArms,
  type BranchArm,
} from "../features/task-pack/branchArms.js";
import { maskCommentsAndStrings } from "../features/task-pack/sfCodeMask.js";

/** The arms of `source` and a way to ask which arms hold the first occurrence of a word. */
function read(source: string): { arms: BranchArm[]; path: (word: string, nth?: number) => string[] } {
  const masked = maskCommentsAndStrings(source);
  const arms = branchArms(masked, source, 0, source.length);
  const offsetOf = (word: string, nth = 1): number => {
    let at = -1;
    for (let seen = 0; seen < nth; seen += 1) {
      at = masked.indexOf(word, at + 1);
      if (at < 0) throw new Error(`no ${nth}th ${word}`);
    }
    return at;
  };
  return { arms, path: (word, nth = 1) => armsAt(arms, offsetOf(word, nth)).map((arm) => arm.label) };
}

const SWITCH = `
switch (newState) {

    case FULFILLED:
        // notify the warehouse
        try {
            shippingService.notifyFulfilled(orderId);
        } catch (RuntimeException ex) {
            log.warn("failed");
        }
        break;

    case SHIPPED:
        order.setShippedAt(Instant.now());
        break;

    case DELIVERED:
        for (OrderItem item : order.getItems()) {
            inventoryService.release(item.getSku(), 0);
        }
        break;

    default:
        break;
}
after.call();
`;

describe("braceBlocks — the languages whose blocks are read", () => {
  it.each(["java", "kotlin", "typescript", "typescriptreact", "javascript", "javascriptreact", "go", "rust", "c", "cpp", "csharp", "php", undefined])("%s", (lang) => {
    expect(braceBlocks(lang)).toBe(true);
  });
  it.each(["python", "ruby", "shell", "yaml", "json", "html"])("%s is not read", (lang) => {
    expect(braceBlocks(lang)).toBe(false);
  });
});

describe("branchArms — a switch", () => {
  it("makes one arm per case and one for default, each running from its label to the next", () => {
    const { arms, path } = read(SWITCH);
    expect(arms.map((arm) => arm.label)).toEqual(["case FULFILLED", "case SHIPPED", "case DELIVERED", "default"]);
    expect(new Set(arms.map((arm) => arm.construct)).size, "one switch").toBe(1);
    expect(path("notifyFulfilled")).toEqual(["case FULFILLED"]);
    expect(path("setShippedAt")).toEqual(["case SHIPPED"]);
    expect(path("release")).toEqual(["case DELIVERED"]);
    expect(path("after.call"), "after the switch is in no arm").toEqual([]);
  });

  it("two cases of one switch are alternatives; a call before or after it is in sequence with both", () => {
    const { arms } = read(SWITCH);
    const [fulfilled, , delivered] = arms;
    expect(alternativeArms([fulfilled!], [delivered!])).toBe(true);
    expect(alternativeArms([fulfilled!], [fulfilled!])).toBe(false);
    expect(alternativeArms([], [delivered!])).toBe(false);
  });

  it("a run of labels over one body is one arm: case A: case B: stmt", () => {
    const { arms, path } = read(`switch (x) {
        case A:
        case B:
            first();
            break;
        case C: second(); break;
        default:
        case D:
            third();
    }`);
    expect(arms.map((arm) => arm.label)).toEqual(["case A, B", "case C", "case default, D"]);
    expect(path("first")).toEqual(["case A, B"]);
    expect(path("third")).toEqual(["case default, D"]);
  });

  it("reads the arrow form, including a label with several constants", () => {
    const { arms, path } = read(`switch (event) {
        case LABEL_CREATED, PACKED -> first();
        case SHIPPED -> { second(); }
        default -> third();
    }`);
    expect(arms.map((arm) => arm.label)).toEqual(["case LABEL_CREATED, PACKED", "case SHIPPED", "default"]);
    expect(path("first")).toEqual(["case LABEL_CREATED, PACKED"]);
    expect(path("second")).toEqual(["case SHIPPED"]);
    expect(path("third")).toEqual(["default"]);
  });

  it("writes a string label without its quotes (`case \"FAILED\":` is `case FAILED`)", () => {
    const { arms } = read(`switch (event) {
        case "LABEL_CREATED": a(); break;
        case "FAILED": b(); break;
        case 'x': c(); break;
    }`);
    expect(arms.map((arm) => arm.label)).toEqual(["case LABEL_CREATED", "case FAILED", "case x"]);
  });

  it("cuts a long case expression to the label width", () => {
    const { arms } = read(`switch (x) { case SOME_VERY_LONG_CONSTANT_NAME_HERE: a(); break; case B: b(); }`);
    expect(arms[0]!.label).toBe(`case ${"SOME_VERY_LONG_CONSTANT_NAME_HERE".slice(0, BRANCH_ARM_LABEL_WIDTH - 2)}..`);
    expect(arms[0]!.label.length).toBe("case ".length + BRANCH_ARM_LABEL_WIDTH);
  });

  it("a scope-resolution colon is no label terminator (C++ `case Color::Red:`)", () => {
    const { arms } = read(`switch (c) { case Color::Red: a(); break; case Color::Blue: b(); }`);
    expect(arms.map((arm) => arm.label)).toEqual(["case Color::Red", "case Color::Blue"]);
  });

  it("a `case` or `default` in a nested switch belongs to that switch, and the nested arms nest in the outer ones", () => {
    const { arms, path } = read(`switch (a) {
        case ONE:
            switch (b) {
                case X: inner1(); break;
                case Y: inner2(); break;
            }
            break;
        case TWO:
            outer2();
    }`);
    expect(arms.map((arm) => arm.label).sort()).toEqual(["case ONE", "case TWO", "case X", "case Y"]);
    expect(new Set(arms.map((arm) => arm.construct)).size, "two switches").toBe(2);
    expect(path("inner1")).toEqual(["case ONE", "case X"]);
    expect(path("inner2")).toEqual(["case ONE", "case Y"]);
    expect(path("outer2")).toEqual(["case TWO"]);
  });

  it("a `default` that is not a label (an interface's default method) is no arm", () => {
    const { arms } = read(`switch (x) { case A: new Object() { default void m() {} }; break; case B: b(); }`);
    expect(arms.map((arm) => arm.label)).toEqual(["case A", "case B"]);
  });
});

describe("branchArms — a case that can fall into the next is not an alternative of it", () => {
  it("a colon-form body that does not leave the switch records no arms for that switch: two calls that may both run are not alternatives", () => {
    expect(read("switch (x) { case A: a(); case B: b(); break; }").arms).toEqual([]);
    // …not even the cases around the one that falls through
    expect(read("switch (x) { case A: a(); break; case B: b(); case C: c(); break; }").arms).toEqual([]);
  });

  it("the last case needs no jump, and a body may leave the switch by break, return, throw, continue or yield", () => {
    expect(read("switch (x) { case A: a(); break; case B: b(); }").arms.map((arm) => arm.label)).toEqual(["case A", "case B"]);
    expect(read("switch (x) { case A: return 1; case B: throw new Failure(); case C: continue; case D: yield 2; default: z(); }").arms).toHaveLength(5);
  });

  it("a braced case body is a jump when the block ends in one", () => {
    expect(read("switch (x) { case A: { a(); break; } case B: b(); }").arms.map((arm) => arm.label)).toEqual(["case A", "case B"]);
    expect(read("switch (x) { case A: { a(); } case B: b(); }").arms).toEqual([]);
  });

  it("a body that ends in a nested block with no jump after it is taken for a fall-through (the safe reading)", () => {
    expect(read("switch (x) { case A: if (c) { a(); break; } case B: b(); }").arms).toEqual([]);
  });

  it("the arrow form never falls through", () => {
    expect(read("switch (x) { case A -> a(); case B -> b(); }").arms.map((arm) => arm.label)).toEqual(["case A", "case B"]);
  });

  it("the other switches and chains of the same text are read: an inner switch falling through leaves the outer arms alone", () => {
    const { arms } = read(`switch (outer) {
        case ONE:
            switch (inner) { case X: x(); case Y: y(); break; }
            break;
        case TWO:
            if (c) { p(); } else { q(); }
    }`);
    expect(arms.map((arm) => arm.label).sort()).toEqual(["case ONE", "case TWO", "else", "if c"]);
  });
});

describe("branchArms — an if / else if / else chain", () => {
  const CHAIN = `
if (from == OrderStatus.PAID) {
    first();
} else if (from == OrderStatus.FULFILLED) {
    second();
} else {
    third();
}
tail();
`;

  it("makes one arm per branch: if, else if, else, with the condition as its head, cut to the label width", () => {
    const { arms, path } = read(CHAIN);
    // `from == OrderStatus.PAID` is 24 characters and stays whole; the longer second condition is cut to 22 and "..".
    expect(arms.map((arm) => arm.label)).toEqual(["if from == OrderStatus.PAID", "else if from == OrderStatus.FU..", "else"]);
    expect(new Set(arms.map((arm) => arm.construct)).size, "one chain").toBe(1);
    expect(path("first")).toEqual(["if from == OrderStatus.PAID"]);
    expect(path("second")).toEqual(["else if from == OrderStatus.FU.."]);
    expect(path("third")).toEqual(["else"]);
    expect(path("tail")).toEqual([]);
  });

  it("keeps a short condition whole and collapses its whitespace", () => {
    const { arms } = read(`if (a &&
        b) { x(); } else { y(); }`);
    expect(arms.map((arm) => arm.label)).toEqual(["if a && b", "else"]);
  });

  it("an `if` with no `else` is the alternative of nothing and is no arm", () => {
    const { arms, path } = read(`if (payment != null) { refund(); }
        if (label != null) { voidLabel(); }`);
    expect(arms).toEqual([]);
    expect(path("refund")).toEqual([]);
  });

  it("an `if` / `else` nested in a lone `if` is found; the lone `if` still is no arm", () => {
    const { arms, path } = read(`if (outer) {
        if (inner) { a(); } else { b(); }
    }`);
    expect(arms.map((arm) => arm.label)).toEqual(["if inner", "else"]);
    expect(path("a")).toEqual(["if inner"]);
    expect(path("b")).toEqual(["else"]);
  });

  it("reads a single simple statement as an arm", () => {
    const { arms, path } = read(`if (a) first(); else second();
        tail();`);
    expect(arms.map((arm) => arm.label)).toEqual(["if a", "else"]);
    expect(path("first")).toEqual(["if a"]);
    expect(path("second")).toEqual(["else"]);
    expect(path("tail")).toEqual([]);
  });

  it("a call inside a case that has its own if/else sits in both arms, the outer one first", () => {
    const { path } = read(`switch (event) {
        case RETURNED:
            if (from == SHIPPED) {
                refund();
            } else {
                warn();
            }
            break;
        case FAILED:
            reship();
    }`);
    expect(path("refund")).toEqual(["case RETURNED", "if from == SHIPPED"]);
    expect(path("warn")).toEqual(["case RETURNED", "else"]);
    expect(path("reship")).toEqual(["case FAILED"]);
  });

  it("does not follow an arm whose body is a statement with a body of its own, and does not guess", () => {
    const { arms } = read(`if (a) for (int i = 0; i < n; i++) { x(); } else { y(); }
        if (b) { p(); } else { q(); }`);
    // The first chain is not read (a missing arm costs only a label); the second is.
    expect(arms.map((arm) => arm.label)).toEqual(["if b", "else"]);
  });
});

describe("branchArms — what is no arm, and what must not throw", () => {
  it("keywords inside a comment or a string are not read", () => {
    const { arms } = read(`// switch (x) { case A: }
        log.info("if (a) { } else { } case B: default:");
        /* if (c) { x(); } else { y(); } */
        plain();`);
    expect(arms).toEqual([]);
  });

  it("a method body without its opening brace (the signature line is not part of the body) is read", () => {
    const body = `    if (a) {
            one();
        } else {
            two();
        }
    }`;
    const { arms, path } = read(body);
    expect(arms.map((arm) => arm.label)).toEqual(["if a", "else"]);
    expect(path("two")).toEqual(["else"]);
  });

  it("unbalanced brackets end the construct they are in without throwing", () => {
    for (const source of ["switch (x) { case A: a();", "if (a) { b(); } else {", "if (a { b(); } else { c(); }", "switch (x) case A: a();", "}}} if (", "case A: default:", ""]) {
      expect(() => read(source), source).not.toThrow();
    }
  });

  it("a long body is read once, in time linear in its size", () => {
    const source = `switch (x) {\n${Array.from({ length: 2000 }, (_, i) => `    case C${i}:\n        call${i}();\n        break;`).join("\n")}\n}`;
    const started = Date.now();
    const { arms } = read(source);
    expect(arms).toHaveLength(2000);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe("armsAt / alternativeArms", () => {
  it("armsAt lists the arms holding an offset, outermost first, and none outside every arm", () => {
    const { arms } = read(SWITCH);
    const masked = maskCommentsAndStrings(SWITCH);
    expect(armsAt(arms, masked.indexOf("release")).map((arm) => arm.label)).toEqual(["case DELIVERED"]);
    expect(armsAt(arms, 0)).toEqual([]);
    expect(armsAt([], 5)).toEqual([]);
  });

  it("arms of different constructs are not alternatives of one another", () => {
    const { arms } = read(`switch (a) { case A: x(); break; case B: y(); }
        if (c) { p(); } else { q(); }`);
    const [caseA, , ifArm] = arms;
    expect(alternativeArms([caseA!], [ifArm!])).toBe(false);
  });
});
