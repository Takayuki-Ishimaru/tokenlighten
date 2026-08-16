import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { selectHostProfile } from "../commands/clients.js";

type Profile = "tl" | "native";
type CorpusSource =
  | "synthetic-rule"
  | "small-task-paraphrase"
  | "workflow-shape-paraphrase"
  | "organic";

interface CorpusItem {
  id: string;
  prompt: string;
  context?: {
    explicit_paths?: string[];
    total_bytes?: number;
  };
  expected: Profile;
  rationale: string;
  source: CorpusSource;
}

interface Counts {
  tl: { tl: number; native: number };
  native: { tl: number; native: number };
}

interface ClassMetrics {
  precision: number;
  recall: number;
}

const corpusPath = fileURLToPath(
  new URL("./fixtures/activation-corpus.jsonl", import.meta.url),
);
const corpus = readFileSync(corpusPath, "utf8")
  .trim()
  .split(/\r?\n/u)
  .map((line) => JSON.parse(line) as CorpusItem);

const emptyCounts = (): Counts => ({
  tl: { tl: 0, native: 0 },
  native: { tl: 0, native: 0 },
});

function classify(item: CorpusItem): Profile {
  const paths = item.context?.explicit_paths ?? [];
  const totalBytes = item.context?.total_bytes;
  const baseSize = totalBytes === undefined || paths.length === 0
    ? undefined
    : Math.floor(totalBytes / paths.length);
  const sizes = new Map(paths.map((path, index) => [
    path,
    index === 0 && baseSize !== undefined
      ? totalBytes! - baseSize * (paths.length - 1)
      : baseSize!,
  ]));
  return selectHostProfile({
    request: item.prompt,
    paths,
    fileProbe: (path) => {
      const size = sizes.get(path);
      return size === undefined ? undefined : { isFile: true, size };
    },
  }).profile;
}

function metrics(counts: Counts): Record<Profile, ClassMetrics> {
  const forClass = (profile: Profile): ClassMetrics => {
    const tp = counts[profile][profile];
    const predicted = counts.tl[profile] + counts.native[profile];
    const actual = counts[profile].tl + counts[profile].native;
    return {
      precision: predicted === 0 ? 0 : tp / predicted,
      recall: actual === 0 ? 0 : tp / actual,
    };
  };
  return { tl: forClass("tl"), native: forClass("native") };
}

function evaluate(items: readonly CorpusItem[]) {
  const confusion = emptyCounts();
  const bySource = new Map<CorpusSource, Counts>();
  for (const item of items) {
    const selected = classify(item);
    confusion[item.expected][selected] += 1;
    const source = bySource.get(item.source) ?? emptyCounts();
    source[item.expected][selected] += 1;
    bySource.set(item.source, source);
  }
  return {
    total: items.length,
    confusion,
    classes: metrics(confusion),
    bySource: Object.fromEntries(
      [...bySource].map(([source, counts]) => [
        source,
        { confusion: counts, classes: metrics(counts) },
      ]),
    ),
  };
}

describe("host activation offline corpus", () => {
  it("keeps the registered-rule corpus balanced, bilingual, and source-diverse", () => {
    expect(corpus.length).toBeGreaterThanOrEqual(80);
    expect(new Set(corpus.map(({ id }) => id)).size).toBe(corpus.length);

    const tl = corpus.filter(({ expected }) => expected === "tl").length;
    const native = corpus.length - tl;
    expect(Math.abs(tl - native)).toBeLessThanOrEqual(4);

    const japanese = corpus.filter(({ prompt }) => /[\u3040-\u30ff\u3400-\u9fff]/u.test(prompt)).length;
    expect(japanese).toBeGreaterThanOrEqual(30);
    expect(corpus.length - japanese).toBeGreaterThanOrEqual(30);

    const sources = new Set(corpus.map(({ source }) => source));
    expect(sources).toEqual(new Set<CorpusSource>([
      "synthetic-rule",
      "small-task-paraphrase",
      "workflow-shape-paraphrase",
      "organic",
    ]));

    for (const item of corpus.filter(({ expected }) => expected === "native")) {
      const paths = item.context?.explicit_paths ?? [];
      expect(paths.length, item.id).toBeGreaterThanOrEqual(1);
      expect(paths.length, item.id).toBeLessThanOrEqual(2);
      expect(item.context?.total_bytes, item.id).toBeLessThanOrEqual(16 * 1024);
    }
  });

  it("reports class precision/recall, confusion matrix, and source breakdown", () => {
    const report = evaluate(corpus);
    console.info("activation-corpus metrics\n" + JSON.stringify(report, null, 2));

    // Pre-M2 baseline, measured on 2026-08-14: TL 40/59 precision and
    // 40/40 recall; native 21/21 precision and 21/40 recall.
    const preM2Baseline = {
      tl: { precision: 40 / 59, recall: 1 },
      native: { precision: 1, recall: 21 / 40 },
    } as const;
    // Regression floor, re-pinned 2026-08-14 after closing the JA 更新 gap in
    // LOCAL_OPERATION_SIGNAL: TL and native precision/recall are now all 1.0.
    const regressionFloor = {
      tl: { precision: 1, recall: 1 },
      native: { precision: 1, recall: 1 },
    } as const;

    expect(report.classes.tl.precision).toBeGreaterThanOrEqual(regressionFloor.tl.precision);
    expect(report.classes.tl.recall).toBeGreaterThanOrEqual(regressionFloor.tl.recall);
    expect(report.classes.native.precision).toBeGreaterThanOrEqual(regressionFloor.native.precision);
    expect(report.classes.native.recall).toBeGreaterThanOrEqual(regressionFloor.native.recall);
    expect(report.classes.tl.precision).toBeGreaterThan(preM2Baseline.tl.precision);
    expect(report.classes.tl.recall).toBeGreaterThanOrEqual(preM2Baseline.tl.recall);
    expect(report.classes.native.precision).toBeGreaterThanOrEqual(preM2Baseline.native.precision);
    expect(report.classes.native.recall).toBeGreaterThan(preM2Baseline.native.recall);
  });

  it("routes uncertainty to TL instead of speculating about native eligibility", () => {
    expect(selectHostProfile({
      request: "Please improve this behavior",
      paths: [],
      fileProbe: () => undefined,
    })).toEqual({ profile: "tl", reason: "path-unknown" });
    expect(selectHostProfile({
      request: "",
      paths: ["src/known.ts"],
      fileProbe: () => ({ isFile: true, size: 100 }),
    })).toEqual({ profile: "tl", reason: "ambiguous-request" });
  });
});
