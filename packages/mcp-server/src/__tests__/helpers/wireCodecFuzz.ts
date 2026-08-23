// ---------------------------------------------------------------------------
// Hand-rolled, seeded generators for protocol/codec/*.spec.ts's property
// tests. NOT fast-check (AGENTS.md: fast-check is not a dependency) -- a
// small deterministic PRNG (mulberry32) plus a handful of purpose-built
// generators that deliberately over-sample the characters that break naive
// text-wire formats: CJK, astral-plane emoji, C0 controls, newlines, tabs,
// backslashes, quotes.
// ---------------------------------------------------------------------------

export type Rng = () => number; // float in [0, 1)

/** mulberry32 -- tiny, deterministic, good enough distribution for fuzzing. */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pick<T>(rng: Rng, items: readonly T[]): T {
  return items[Math.floor(rng() * items.length)]!;
}

export function int(rng: Rng, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

// Built via fromCharCode/fromCodePoint (decimal code points, no `\u` escape
// text) so no literal C0-control byte, and no escape sequence a transport
// layer might re-interpret, ever appears in this file's own source.
const NUL = String.fromCharCode(0);
const SOH = String.fromCharCode(1);
const UNIT_SEP = String.fromCharCode(0x1f);
const DEL = String.fromCharCode(0x7f);
const EMOJI_ASTRAL = String.fromCodePoint(0x1f600); // outside the BMP: a real surrogate pair

/** "spicy" code points this suite deliberately over-samples relative to
 *  their real-world frequency, precisely because they are the ones a naive
 *  delimiter/escaping scheme gets wrong. */
const SPICE_POOL: readonly string[] = [
  "\\", '"', "\t", "\n", "\r",
  NUL, SOH, UNIT_SEP, DEL,
  "日本語", "漢字", "テスト",
  "🎉", "🚀", EMOJI_ASTRAL,
  ",", "|", "[", "]", "{", "}", ":", "#", "-",
];

export function randomString(
  rng: Rng,
  opts?: { minLen?: number; maxLen?: number; spiceRate?: number },
): string {
  const minLen = opts?.minLen ?? 0;
  const maxLen = opts?.maxLen ?? 12;
  const spiceRate = opts?.spiceRate ?? 0.35;
  const len = int(rng, minLen, maxLen);
  let out = "";
  for (let i = 0; i < len; i++) {
    if (rng() < spiceRate) {
      out += pick(rng, SPICE_POOL);
    } else {
      out += String.fromCharCode(int(rng, 0x20, 0x7e)); // printable ASCII
    }
  }
  return out;
}

export function randomNumber(rng: Rng): number {
  const kind = int(rng, 0, 4);
  switch (kind) {
    case 0: return int(rng, -1000, 1000);
    case 1: return 0;
    case 2: return -0;
    case 3: return Math.round((rng() - 0.5) * 200000) / 100;
    default: return int(rng, 0, 1) === 0 ? 1e-7 : 1e21 * (rng() < 0.5 ? -1 : 1);
  }
}

export function randomScalar(rng: Rng): string | number | boolean | null {
  const kind = int(rng, 0, 3);
  switch (kind) {
    case 0: return randomString(rng);
    case 1: return randomNumber(rng);
    case 2: return rng() < 0.5;
    default: return null;
  }
}

/**
 * D1 (F-C2b) -- a `read.text`-shaped payload (protocol/readFamily.ts's
 * `ReadTextResult`) with its dominant body at `evidence[i].body`, the shape
 * tlRaw1.ts's nested-body support targets. `evidenceCount` entries total;
 * exactly ONE (at a random index) carries the `body` string -- every other
 * entry is a `remaining`-only window, matching a real multi-window serve
 * where only one window's bytes are actually attached. `spiceRate` (default
 * high) over-samples the quotes/backslashes/CJK/emoji class of content
 * tl-raw-1's no-JSON-escaping format is designed to win on.
 */
export function randomReadTextEvidencePayload(
  rng: Rng,
  opts?: { minBodyLen?: number; maxBodyLen?: number; spiceRate?: number; evidenceCount?: number },
): Record<string, unknown> {
  const evidenceCount = opts?.evidenceCount ?? int(rng, 1, 3);
  const bodyIndex = int(rng, 0, evidenceCount - 1);
  const evidence = Array.from({ length: evidenceCount }, (_, i) => {
    const handle = `tlh_${randomString(rng, { minLen: 8, maxLen: 8, spiceRate: 0 }).replace(/[^a-zA-Z0-9]/g, "x")}`;
    const path = `src/file${i}.ts`;
    const range = `${int(rng, 1, 5)}-${int(rng, 6, 40)}`;
    if (i === bodyIndex) {
      return {
        handle,
        path,
        range,
        body: randomString(rng, {
          minLen: opts?.minBodyLen ?? 0,
          maxLen: opts?.maxBodyLen ?? 400,
          spiceRate: opts?.spiceRate ?? 0.5,
        }),
      };
    }
    return { handle, path, range, remaining: [range] };
  });
  return { v: 1, kind: "read.text", evidence };
}
