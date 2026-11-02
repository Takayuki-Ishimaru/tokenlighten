import { describe, expect, it, vi } from "vitest";
import { boundedTextMemo } from "../util/boundedTextMemo.js";
import { inflectionVariants, textHasWordVariant } from "../features/task-pack/salientWordMatch.js";

const longText = (seed: string, chars = 300): string => seed.repeat(Math.ceil(chars / seed.length)).slice(0, chars);

describe("boundedTextMemo", () => {
  it("derives a long text once and returns the same result afterwards", () => {
    const derive = vi.fn((text: string) => text.length);
    const memo = boundedTextMemo(derive);
    const text = longText("abc");
    expect(memo(text)).toBe(300);
    expect(memo(`${text.slice(0, 150)}${text.slice(150)}`)).toBe(300);
    expect(derive).toHaveBeenCalledTimes(1);
  });

  it("never mixes up two texts of the same length", () => {
    const memo = boundedTextMemo((text: string) => text[0]);
    expect(memo(longText("a"))).toBe("a");
    expect(memo(longText("b"))).toBe("b");
    expect(memo(longText("a"))).toBe("a");
  });

  it("derives a short text every time", () => {
    const derive = vi.fn((text: string) => text.length);
    const memo = boundedTextMemo(derive);
    memo("short");
    memo("short");
    expect(derive).toHaveBeenCalledTimes(2);
  });

  it("keeps a falsy or empty result without deriving it again", () => {
    const derive = vi.fn((_text: string) => 0);
    const memo = boundedTextMemo(derive);
    const text = longText("z");
    expect(memo(text)).toBe(0);
    expect(memo(text)).toBe(0);
    expect(derive).toHaveBeenCalledTimes(1);
  });

  it("drops the oldest entries once more than 64 are held", () => {
    const derive = vi.fn((text: string) => text.length);
    const memo = boundedTextMemo(derive);
    const texts = Array.from({ length: 65 }, (_, i) => longText(`${i}-`));
    for (const text of texts) memo(text);
    expect(derive).toHaveBeenCalledTimes(65);
    memo(texts[64]!);
    expect(derive).toHaveBeenCalledTimes(65);
    memo(texts[0]!);
    expect(derive).toHaveBeenCalledTimes(66);
  });

  it("holds at most 8 MiB of text and does not keep a text larger than that", () => {
    const derive = vi.fn((text: string) => text.length);
    const memo = boundedTextMemo(derive);
    const MiB = 1024 * 1024;
    const big = "x".repeat(8 * MiB + 1);
    memo(big);
    memo(big);
    expect(derive).toHaveBeenCalledTimes(2);

    derive.mockClear();
    const first = "a".repeat(5 * MiB);
    const second = "b".repeat(5 * MiB);
    memo(first);
    memo(second);
    memo(second);
    expect(derive).toHaveBeenCalledTimes(2);
    memo(first);
    expect(derive).toHaveBeenCalledTimes(3);
  });
});

describe("textHasWordVariant through the memo", () => {
  const padding = "const unrelated = other_value; ".repeat(20);

  it("answers a long text the way it answers a short one", () => {
    for (const [text, word, expected] of [
      ["function validateCouponCode() {}", "validated", true],
      ["const MAX_RETRIES = 3;", "retry", true],
      ["const invoice = 3;", "retry", false],
      ["const constant = 1;", "const", true],
      ["retryFailedNotifications()", "notification", true],
      ["the constant value", "const", false],
    ] as const) {
      expect(textHasWordVariant(text, word), `short: ${word}`).toBe(expected);
      expect(textHasWordVariant(`${text}\n${"# ".repeat(200)}`, word), `long: ${word}`).toBe(expected);
    }
  });

  it("gives the same answer on a repeated call, whichever word is asked first", () => {
    const text = `${padding}\nfunction validateCouponCode() {}`;
    expect(textHasWordVariant(text, "validated")).toBe(true);
    expect(textHasWordVariant(text, "invoice")).toBe(false);
    expect(textHasWordVariant(text, "validated")).toBe(true);
    expect(textHasWordVariant(text, "coupons")).toBe(true);
  });

  it("does not let a caller change a later answer through the variants it was handed", () => {
    const first = inflectionVariants("validated");
    first.length = 0;
    expect(inflectionVariants("validated")).toContain("validate");
  });
});
