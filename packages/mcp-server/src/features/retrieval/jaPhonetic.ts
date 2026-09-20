// jaPhonetic.ts — katakana <-> English consonant-class phonetic skeletons,
// for jaQueryBridge.ts (TL_JA_QUERY_BRIDGE; (S) supported first-pack policy,
// default ON since 2026-09-19 (USER ruling); explicit `=0` is the rollback
// path). Pure, deterministic,
// zero I/O: every export here is a plain string -> string/array function
// with no filesystem/network access and no shared mutable state.
//
// The core idea (a standard Soundex/NYSIIS-style approach applied to a
// cross-script loanword pair): reduce a word to the ORDERED SEQUENCE of
// consonant SOUND CLASSES it contains, dropping every vowel and glide.
// Japanese katakana loanwords are systematically de-voiced/simplified
// transliterations of English words (each katakana mora is consonant+vowel,
// so the vowels carry little of the original English signal and the
// CONSONANT skeleton is what survives most reliably across the two
// orthographies) -- "キャンセル" and "cancel" reduce to the same consonant
// skeleton (K-N-S-R) even though neither spelling nor pronunciation lines
// up character-for-character.
//
// Consonant classes (from the design):
//   K  = k, hard c, q, ck
//   G  = g
//   S  = s, z, sh, j, soft c, ts (English "ts"), th, JA ザ/ジ-row, -tion/
//        -sion, -ture, -dge/-ge
//   T  = t, JA ツ (ツ is its own class, distinct from the English "ts"
//        digraph which the design places in S -- see katakana rules below)
//   D  = d
//   N  = n, JA ン
//   M  = m
//   R  = r, l
//   B  = b, v, JA ヴ
//   P  = p
//   FH = f, ph, h, JA ハ-row, フ
// Vowels and glides (y, w) are dropped entirely; adjacent repeats of the
// same class collapse to one (this is what makes sokuon gemination on the
// katakana side and doubled letters on the English side phonetically inert
// for matching purposes, by construction rather than as a special case).
export type ConsonantClass = "K" | "G" | "S" | "T" | "D" | "N" | "M" | "R" | "B" | "P" | "FH";

/** One position in a class sequence: usually one fixed class, but a few rules are genuinely ambiguous (e.g. "ch", JA チ) and branch into alternatives. */
interface ClassStep {
  readonly alternatives: readonly ConsonantClass[];
}

const VOWELS: ReadonlySet<string> = new Set(["a", "e", "i", "o", "u"]);

function collapseAdjacent(classes: readonly ConsonantClass[]): ConsonantClass[] {
  const out: ConsonantClass[] = [];
  for (const c of classes) {
    if (out.length === 0 || out[out.length - 1] !== c) out.push(c);
  }
  return out;
}

/** Cartesian-expand branch points into concrete sequences, capped early to avoid blowup on a long word with several ambiguous digraphs. */
function expandSteps(steps: readonly ClassStep[], cap: number): ConsonantClass[][] {
  let sequences: ConsonantClass[][] = [[]];
  for (const step of steps) {
    const next: ConsonantClass[][] = [];
    outer: for (const seq of sequences) {
      for (const alt of step.alternatives) {
        next.push([...seq, alt]);
        if (next.length >= cap * 4) break outer;
      }
    }
    sequences = next;
  }
  return sequences;
}

function keysFromSteps(steps: readonly ClassStep[], cap: number): string[] {
  const raw = expandSteps(steps, cap);
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const seq of raw) {
    const collapsed = collapseAdjacent(seq);
    if (collapsed.length === 0) continue;
    const key = collapsed.join(".");
    if (seen.has(key)) continue;
    seen.add(key);
    keys.push(key);
    if (keys.length >= cap) break;
  }
  return keys;
}

/** Also exposes the raw (uncollapsed-key, single primary variant) token array, for jaQueryBridge.ts's compound DP segmentation, which needs to slice an arbitrary sub-range of a whole run's classes -- a joined "A.B.C" string cannot be sliced safely once any class label is itself multi-character (FH). */
function primaryTokens(steps: readonly ClassStep[]): ConsonantClass[] {
  return collapseAdjacent(steps.map((s) => s.alternatives[0]!));
}

// ---------------------------------------------------------------------------
// English side
// ---------------------------------------------------------------------------

const ENGLISH_CONSONANT_CLASS: ReadonlyMap<string, ConsonantClass> = new Map([
  ["b", "B"], ["d", "D"], ["f", "FH"], ["h", "FH"], ["j", "S"], ["k", "K"],
  ["l", "R"], ["m", "M"], ["n", "N"], ["p", "P"], ["q", "K"], ["s", "S"],
  ["t", "T"], ["v", "B"], ["z", "S"],
]);

function englishSteps(wordLower: string): ClassStep[] {
  const w = wordLower;
  const n = w.length;
  const steps: ClassStep[] = [];
  let i = 0;

  // Word-initial silent digraphs: "kn" (know, knight) / "wr" (write, wrap).
  if (w.startsWith("kn")) { steps.push({ alternatives: ["N"] }); i = 2; }
  else if (w.startsWith("wr")) { steps.push({ alternatives: ["R"] }); i = 2; }

  while (i < n) {
    const c = w[i]!;

    // Word-final silent "b" after "m" (climb, comb, thumb).
    if (c === "m" && i === n - 2 && w.slice(i, i + 2) === "mb") {
      steps.push({ alternatives: ["M"] });
      i += 2;
      continue;
    }
    if (w.startsWith("sch", i)) {
      steps.push({ alternatives: ["S"] });
      steps.push({ alternatives: ["K"] });
      i += 3;
      continue;
    }
    // "-tion"/"-sion" (nation, notification, session, decision): the whole
    // 4-letter span is one "shun" sound -- S then N -- not t/s + i + o + n
    // classified individually (which would wrongly keep the literal T from
    // "-tion", e.g. "notification" would otherwise mismatch its own
    // katakana "-ション" ending, whose ショ syllable is S).
    if (w.startsWith("tion", i) || w.startsWith("sion", i)) {
      steps.push({ alternatives: ["S"] });
      steps.push({ alternatives: ["N"] });
      i += 4;
      continue;
    }
    // "-ture" (feature, picture, nature): one "cher" sound -- S -- not
    // t + u + r + e classified individually (which would wrongly keep a
    // trailing R from the "ure" that this suffix's own r is part of).
    if (w.startsWith("ture", i)) {
      steps.push({ alternatives: ["S"] });
      i += 4;
      continue;
    }
    // "-dge" (bridge, badge, edge): one /dʒ/ sound -- S -- not D + G/S-branch.
    if (w.startsWith("dge", i)) {
      steps.push({ alternatives: ["S"] });
      i += 3;
      continue;
    }
    if (w.startsWith("qu", i)) {
      steps.push({ alternatives: ["K"] });
      i += 2;
      continue;
    }
    if (w.startsWith("gh", i)) {
      if (i === 0) steps.push({ alternatives: ["G"] }); // ghost, ghetto
      else if (i >= 2 && (w.slice(i - 2, i) === "ou" || w.slice(i - 2, i) === "au")) {
        steps.push({ alternatives: ["FH"] }); // laugh, enough, tough, rough, cough
      }
      // else: silent (light, though, high) -- emit nothing.
      i += 2;
      continue;
    }
    if (w.startsWith("ch", i)) {
      const after = w[i + 2];
      // Default "ch" -> S (check, feature); bounded K variant before r/l/o
      // (chrome, chlorine, echo-shaped borrowings).
      const alternatives: ConsonantClass[] = after === "r" || after === "l" || after === "o" ? ["S", "K"] : ["S"];
      steps.push({ alternatives });
      i += 2;
      continue;
    }
    // "sh" (shipping, cash) and "th" (both are S per the design's class
    // table) -- without these, the individual letters would wrongly
    // contribute an extra FH (from "h") that the katakana loanword's
    // sho/shi syllable never produces.
    if (w.startsWith("sh", i) || w.startsWith("th", i)) {
      steps.push({ alternatives: ["S"] });
      i += 2;
      continue;
    }
    if (c === "x") {
      // "x" is /ks/ -- two classes in sequence, not a branch.
      steps.push({ alternatives: ["K"] });
      steps.push({ alternatives: ["S"] });
      i += 1;
      continue;
    }
    if (c === "c") {
      const next = w[i + 1];
      steps.push({ alternatives: [next === "e" || next === "i" || next === "y" ? "S" : "K"] });
      i += 1;
      continue;
    }
    if (c === "g") {
      const next = w[i + 1];
      if (next === "e" || next === "i" || next === "y") steps.push({ alternatives: ["G", "S"] });
      else steps.push({ alternatives: ["G"] });
      i += 1;
      continue;
    }
    if (c === "r") {
      const prevVowel = i > 0 && VOWELS.has(w[i - 1]!);
      const nextChar = w[i + 1];
      const nextIsR = nextChar === "r";
      // "y" acts as a vowel sound in this position (repositor-y,
      // invento-ry's own "y" doesn't apply, but the word-final "-ory"/
      // "-ary"/"-ery" pattern does: "repository", "inventory") -- treat it
      // as vowel-like for the "is the NEXT letter a consonant" half of the
      // postvocalic-r test only; it is still dropped as a glide by the
      // vowel/glide branch below when actually reached.
      const nextIsVowelLike = nextChar !== undefined && (VOWELS.has(nextChar) || nextChar === "y");
      // Postvocalic r (order -> D, server -> S.B) is dropped when the next
      // letter is a true consonant or this is the word's last letter,
      // UNLESS the next letter is also "r": a doubled "rr" (error) is one
      // consonant sound, not two independent postvocalic contexts, so at
      // least one of the pair must survive to be classified --
      // collapseAdjacent then merges the pair into a single R, giving
      // "error" -> R rather than silently dropping the whole cluster.
      const postvocalicDrop = prevVowel && !nextIsR && (i === n - 1 || !nextIsVowelLike);
      if (postvocalicDrop) { i += 1; continue; }
      steps.push({ alternatives: ["R"] });
      i += 1;
      continue;
    }
    if (VOWELS.has(c) || c === "y" || c === "w") { i += 1; continue; } // vowels & glides: dropped
    const cls = ENGLISH_CONSONANT_CLASS.get(c);
    if (cls) steps.push({ alternatives: [cls] });
    i += 1;
  }
  return steps;
}

/** Consonant-class key variants for an English word (dot-joined, e.g. "K.N.S.R" for "cancel"), capped at `cap` variants (default 4 per the design). */
export function englishToClassKeys(word: string, cap = 4): string[] {
  return keysFromSteps(englishSteps(word.toLowerCase()), cap);
}

/** First vowel LETTER in `word`'s spelling (a/e/i/o/u), or null if none. Spelling-based by design -- see jaQueryBridge.ts's ranking step, which relies on the same loose spelling-vowel convention on both sides (e.g. "coupon"'s spelling-first-vowel is "o", matching its katakana-derived "u" only via the loose table, not exactly). */
export function englishFirstVowel(word: string): string | null {
  const w = word.toLowerCase();
  for (const c of w) if (VOWELS.has(c)) return c;
  return null;
}

// ---------------------------------------------------------------------------
// Katakana side: katakana -> romaji, then romaji -> consonant-class keys.
// ---------------------------------------------------------------------------

/** Base + combining-small-kana table -> romaji syllable. Longest match first (the lookup helper below always tries a 2-character slice before a 1-character one), so no separate combining algorithm is needed -- the finite, well-known set of valid two-character loanword digraphs is simply listed here. */
const KANA_TABLE: ReadonlyMap<string, string> = new Map([
  // Seion
  ["ア", "a"], ["イ", "i"], ["ウ", "u"], ["エ", "e"], ["オ", "o"],
  ["カ", "ka"], ["キ", "ki"], ["ク", "ku"], ["ケ", "ke"], ["コ", "ko"],
  ["サ", "sa"], ["シ", "shi"], ["ス", "su"], ["セ", "se"], ["ソ", "so"],
  ["タ", "ta"], ["チ", "chi"], ["ツ", "tsu"], ["テ", "te"], ["ト", "to"],
  ["ナ", "na"], ["ニ", "ni"], ["ヌ", "nu"], ["ネ", "ne"], ["ノ", "no"],
  ["ハ", "ha"], ["ヒ", "hi"], ["フ", "fu"], ["ヘ", "he"], ["ホ", "ho"],
  ["マ", "ma"], ["ミ", "mi"], ["ム", "mu"], ["メ", "me"], ["モ", "mo"],
  ["ヤ", "ya"], ["ユ", "yu"], ["ヨ", "yo"],
  ["ラ", "ra"], ["リ", "ri"], ["ル", "ru"], ["レ", "re"], ["ロ", "ro"],
  ["ワ", "wa"], ["ヲ", "o"], ["ン", "n"],
  // Dakuten / handakuten
  ["ガ", "ga"], ["ギ", "gi"], ["グ", "gu"], ["ゲ", "ge"], ["ゴ", "go"],
  ["ザ", "za"], ["ジ", "ji"], ["ズ", "zu"], ["ゼ", "ze"], ["ゾ", "zo"],
  ["ダ", "da"], ["ヂ", "ji"], ["ヅ", "zu"], ["デ", "de"], ["ド", "do"],
  ["バ", "ba"], ["ビ", "bi"], ["ブ", "bu"], ["ベ", "be"], ["ボ", "bo"],
  ["パ", "pa"], ["ピ", "pi"], ["プ", "pu"], ["ペ", "pe"], ["ポ", "po"],
  // Yoon (base + small ya/yu/yo)
  ["キャ", "kya"], ["キュ", "kyu"], ["キョ", "kyo"],
  ["ギャ", "gya"], ["ギュ", "gyu"], ["ギョ", "gyo"],
  ["シャ", "sha"], ["シュ", "shu"], ["ショ", "sho"],
  ["ジャ", "ja"], ["ジュ", "ju"], ["ジョ", "jo"],
  ["チャ", "cha"], ["チュ", "chu"], ["チョ", "cho"],
  ["ニャ", "nya"], ["ニュ", "nyu"], ["ニョ", "nyo"],
  ["ヒャ", "hya"], ["ヒュ", "hyu"], ["ヒョ", "hyo"],
  ["ビャ", "bya"], ["ビュ", "byu"], ["ビョ", "byo"],
  ["ピャ", "pya"], ["ピュ", "pyu"], ["ピョ", "pyo"],
  ["ミャ", "mya"], ["ミュ", "myu"], ["ミョ", "myo"],
  ["リャ", "rya"], ["リュ", "ryu"], ["リョ", "ryo"],
  // Extended (gairaigo) digraphs
  ["ファ", "fa"], ["フィ", "fi"], ["フェ", "fe"], ["フォ", "fo"],
  ["ウィ", "wi"], ["ウェ", "we"], ["ウォ", "wo"],
  ["ヴァ", "va"], ["ヴィ", "vi"], ["ヴ", "vu"], ["ヴェ", "ve"], ["ヴォ", "vo"],
  ["ティ", "ti"], ["トゥ", "tu"], ["ディ", "di"], ["ドゥ", "du"],
  ["シェ", "she"], ["ジェ", "je"], ["チェ", "che"], ["イェ", "ye"],
  ["ツァ", "tsa"], ["ツィ", "tsi"], ["ツェ", "tse"], ["ツォ", "tso"],
  ["クァ", "kwa"], ["クヮ", "kwa"],
]);

function unitRomajiAt(kana: string, i: number): { romaji: string; length: number } | null {
  const two = kana.slice(i, i + 2);
  const twoHit = KANA_TABLE.get(two);
  if (twoHit !== undefined) return { romaji: twoHit, length: 2 };
  const one = kana.slice(i, i + 1);
  const oneHit = KANA_TABLE.get(one);
  if (oneHit !== undefined) return { romaji: oneHit, length: 1 };
  return null;
}

/** Deterministic katakana -> romaji transliteration (lowercase ascii). Sokuon (small tsu) doubles the following consonant letter; chōon (ー) is dropped (we drop vowel length distinctions anyway downstream). Unknown characters are skipped rather than throwing -- this only ever runs on text already matched by cjkSpans.ts's KATAKANA_RUN_RE. */
export function katakanaToRomaji(kana: string): string {
  let out = "";
  let i = 0;
  while (i < kana.length) {
    const ch = kana[i]!;
    if (ch === "ー") {
      // Chōon: repeats the PRECEDING vowel sound (Hepburn convention) --
      // "コード" -> "koodo", not "kodo". Downstream class extraction drops
      // vowels regardless of length, so this only matters for
      // katakanaToRomaji's own output being a recognizable transliteration
      // in its own right (e.g. for TL_TRACE's ja_bridge event).
      const lastChar = out.length > 0 ? out[out.length - 1] : undefined;
      if (lastChar && "aeiou".includes(lastChar)) out += lastChar;
      i += 1;
      continue;
    }
    if (ch === "ッ" || ch === "っ") {
      const next = unitRomajiAt(kana, i + 1);
      if (next && /^[bcdfghjkmnpqrstvwyz]/.test(next.romaji)) out += next.romaji[0];
      i += 1;
      continue;
    }
    const unit = unitRomajiAt(kana, i);
    if (unit) { out += unit.romaji; i += unit.length; continue; }
    i += 1; // not a recognized kana unit (shouldn't happen on a real katakana run) -- skip
  }
  return out;
}

const ROMAJI_CONSONANT_CLASS: ReadonlyMap<string, ConsonantClass> = new Map([
  ["k", "K"], ["g", "G"], ["z", "S"], ["j", "S"], ["d", "D"], ["n", "N"],
  ["m", "M"], ["r", "R"], ["b", "B"], ["v", "B"], ["p", "P"], ["f", "FH"],
  ["h", "FH"], ["s", "S"], ["t", "T"],
]);

function romajiSteps(romajiLower: string): ClassStep[] {
  const s = romajiLower;
  const steps: ClassStep[] = [];
  let i = 0;
  while (i < s.length) {
    if (s.startsWith("ch", i)) {
      // JA チ (chi/cha/chu/cho/che): ambiguous between English "t" (ticket)
      // and English "ch"/soft "s" (check) -- branch, per the design.
      steps.push({ alternatives: ["T", "S"] });
      i += 2;
      continue;
    }
    if (s.startsWith("tsu", i) || s.startsWith("ts", i)) {
      // JA ツ is its own T-class member (distinct from English "ts" -> S).
      steps.push({ alternatives: ["T"] });
      i += s.startsWith("tsu", i) ? 3 : 2;
      continue;
    }
    if (s.startsWith("sh", i)) { steps.push({ alternatives: ["S"] }); i += 2; continue; }
    const c = s[i]!;
    const cls = ROMAJI_CONSONANT_CLASS.get(c);
    if (cls) steps.push({ alternatives: [cls] });
    // vowels a/e/i/o/u and glide y/w: dropped.
    i += 1;
  }
  return steps;
}

/** Consonant-class key variants for a romaji string derived from a katakana run (dot-joined, capped at `cap` variants). */
export function romajiToClassKeys(romaji: string, cap = 4): string[] {
  return keysFromSteps(romajiSteps(romaji.toLowerCase()), cap);
}

/** Primary (first-alternative) class TOKEN ARRAY for a romaji string -- used by jaQueryBridge.ts's compound DP segmentation, which needs to slice sub-ranges rather than compare whole joined keys. */
export function romajiPrimaryClassTokens(romaji: string): ConsonantClass[] {
  return primaryTokens(romajiSteps(romaji.toLowerCase()));
}

/** First vowel SOUND in a romaji string (a/e/i/o/u), or null if none. */
export function romajiFirstVowel(romaji: string): string | null {
  const s = romaji.toLowerCase();
  for (const c of s) if (VOWELS.has(c)) return c;
  return null;
}

// ---------------------------------------------------------------------------
// Loose first-vowel compatibility (design table), used to rank/filter
// candidate English words that share a consonant-class key with a katakana
// run -- see jaQueryBridge.ts's rankByVowelCompatibility for how the tiered
// (exact-first, then-loose) filter that actually discriminates real minimal
// pairs (cancel vs console, token vs taken) is built on top of this table.
// ---------------------------------------------------------------------------
export const VOWEL_COMPAT: Readonly<Record<string, ReadonlySet<string>>> = {
  a: new Set(["a", "e"]),
  e: new Set(["e", "i"]),
  i: new Set(["i", "a"]),
  o: new Set(["o", "a", "u"]),
  u: new Set(["a", "u"]),
};

// ---------------------------------------------------------------------------
// Secondary tiebreak (orchestrator Phase 2, 2026-09-19): the consonant-class
// skeleton plus first-vowel tiering (above) cannot separate two candidates
// that share BOTH a key and a (non-matching) vowel tier -- "status" and
// "charts" both reduce to S.T.S with first vowel "a", so a query whose own
// first vowel is "u" (ステータス -> "su...") fails the exact tier for both
// and the loose table for both, leaving them tied. A cheap ORTHOGRAPHIC
// similarity between the romaji and the candidate spelling breaks the tie
// without a dictionary: strip the epenthetic vowels Japanese transliteration
// inserts (a consonant-flanked u/o, plus a chōon-doubled vowel collapsed to
// one -- neither carries any of the original English signal) and compare
// what's left to the candidate by plain Levenshtein distance.
// ---------------------------------------------------------------------------

const EPENTHETIC_VOWELS = new Set(["u", "o"]);

/**
 * Strip Japanese-transliteration vowel noise from a romaji string, cheaply
 * approximating "what did the original English consonant skeleton look
 * like": (1) collapse a run of 2+ identical adjacent vowels to one (a
 * chōon-doubled vowel is a LENGTH artifact, not new information -- see
 * katakanaToRomaji's own doc); (2) drop a "u" or "o" that sits between two
 * consonants, or between a consonant and the end of the string (the
 * epenthetic vowel every consonant-final English loanword needs under
 * Japanese phonotactics, e.g. "status" -> "sutetasu" needs a vowel after
 * both the initial "s" cluster point and the final "s"). Other vowels are
 * left alone -- only u/o are epenthetic in this sense; an "a"/"e"/"i" in
 * the same position is typically part of the real transliterated vowel
 * (kya, no, te, ...), not filler.
 */
export function stripEpentheticVowels(romaji: string): string {
  const s = romaji.toLowerCase();
  let collapsed = "";
  for (const c of s) {
    if (collapsed.length > 0 && collapsed[collapsed.length - 1] === c && VOWELS.has(c)) continue;
    collapsed += c;
  }
  const isConsonant = (c: string | undefined): boolean => c !== undefined && !VOWELS.has(c) && c !== "y" && c !== "w";
  let out = "";
  for (let i = 0; i < collapsed.length; i++) {
    const c = collapsed[i]!;
    if (EPENTHETIC_VOWELS.has(c) && isConsonant(collapsed[i - 1]) && (i === collapsed.length - 1 || isConsonant(collapsed[i + 1]))) {
      continue; // epenthetic: drop
    }
    out += c;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Whole-run plausibility gate (orchestrator Phase 4, 2026-09-19): the
// consonant-class key alone can accidentally equate two unrelated words
// whose vowels carry very different information -- "erakoodo" (エラーコード
// as ONE run) shares a key with "record", and the vowel-tier/Levenshtein
// tiebreak above (built for a genuine tie between similarly-shaped
// candidates) does not reliably reject a totally unrelated word this far
// off. A cheap, independent signal: count VOWEL GROUPS (a maximal run of
// consecutive vowel letters = one group; a chōon-doubled vowel is already
// one letter run via katakanaToRomaji's own repeat, so it is naturally one
// group here too) on both sides and require an EXACT match, not just a
// close one -- "record" (e|o = 2 groups) against エラーコード's stripped
// romaji (3 groups) differs, so it is rejected; a real transliteration
// pair's group counts line up exactly far more often than a coincidental
// key collision's do (see the report's full 30+-pair table).
// ---------------------------------------------------------------------------

/** Count maximal runs of consecutive vowel letters (a/e/i/o/u) in `text` -- each run, however long, is ONE group. */
export function vowelGroupCount(text: string): number {
  const s = text.toLowerCase();
  let groups = 0;
  let inGroup = false;
  for (const c of s) {
    if (VOWELS.has(c)) {
      if (!inGroup) groups += 1;
      inGroup = true;
    } else {
      inGroup = false;
    }
  }
  return groups;
}

/** Plain Levenshtein edit distance (insert/delete/substitute, unit cost). Cheap on the short strings (a few characters) this module ever compares. */
export function levenshteinDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = new Array<number>(n + 1);
  let curr = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n]!;
}
