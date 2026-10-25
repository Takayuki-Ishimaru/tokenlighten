/**
 * Member names a request spells with member-access or empty-call syntax:
 * `Service.Post`, `posting.Apply`, `EKF::isHealthy`, `Model#save`,
 * `node->next`, `Post()`. Returned lowercased.
 *
 * The casing rules in `explicitCodeIdentifiers` (readCodeTaskPack.ts) and
 * `explicitIdentifiersIn` (requestFacets.ts) cannot tell a one-word member
 * (`Post`, `Apply`, `save`) from prose, so a query naming `Service.Post`
 * used to contribute no identifier at all: the pack ranked `Service.List` on
 * lexical overlap and certified an answer that never contained `Post`
 * (2026-10-16 Claude simple bench, ledgerd M1). The access syntax itself is
 * the evidence that the word is code.
 *
 * Only a CAPITALIZED member counts through access syntax (`Service.Post`,
 * `posting.Apply`, `Repo::Save`): a capital right after a dot with no space
 * is not prose. A lowercase one-word member (`Cache.get`, `Model#save`) still
 * reads like an English verb and keeps the casing rules' verdict; making it
 * explicit narrowed a three-point request to the one method and dropped its
 * tests point (requestItemCompletion.spec.ts). An empty call (`get()`) is code
 * whatever its case.
 *
 * Dotted file names (`rules.go`, `package.json`), domains (`github.com`,
 * `ASP.NET`) and one-letter segments (`e.g.`, `i.e.`) are not member
 * references. Callers apply their own path stripping and protocol-name
 * exclusions first/after; this helper only reads the spelling.
 */

const MEMBER_CHAIN_RE = /(?<![A-Za-z0-9_$./\\:#-])[A-Za-z_$][A-Za-z0-9_$]*(?:(?:\.|::|#|->)[A-Za-z_$][A-Za-z0-9_$]*)+(?![A-Za-z0-9_$])/g;
const MEMBER_SEPARATOR_RE = /\.|::|#|->/;
const EMPTY_CALL_RE = /(?<![A-Za-z0-9_$])([A-Za-z_$][A-Za-z0-9_$]*)\(\s*\)/g;

const FILE_LIKE_TAILS = new Set([
  "ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs", "py", "pyi", "go", "rs", "java", "kt", "kts", "cs",
  "php", "rb", "c", "h", "cc", "cpp", "cxx", "hpp", "hh", "hxx", "m", "mm", "swift", "scala", "sh", "bash",
  "zsh", "ps1", "md", "mdx", "txt", "rst", "json", "jsonl", "yaml", "yml", "toml", "ini", "cfg", "conf", "xml",
  "html", "htm", "css", "scss", "less", "sql", "lock", "env", "log", "csv", "tsv", "xlsx", "xls", "docx", "doc",
  "pptx", "pdf", "zip", "tar", "gz", "tgz", "png", "jpg", "jpeg", "gif", "svg", "wasm", "proto", "graphql",
  "gql", "vue", "svelte", "dart", "lua", "pl", "jl", "ex", "exs", "erl", "hs", "ml", "fs", "vb", "gradle",
  "mod", "sum", "tf", "tfvars", "dockerfile", "tmpl", "spec", "test",
]);
const DOMAIN_TAILS = new Set(["com", "org", "net", "io", "dev", "app", "co", "jp", "ai", "gov", "edu", "info", "biz", "us", "uk", "de"]);

function isDomainLike(chain: string, tail: string): boolean {
  if (!DOMAIN_TAILS.has(tail.toLowerCase())) return false;
  return chain === chain.toLowerCase() || tail === tail.toUpperCase();
}

/**
 * `foo.test.ts`, `rules.go`: a file name, whatever precedes the extension.
 * An extension is spelled in one case (`go.sum`, `NOTES.TXT`); a capitalized
 * tail is a member (`meter.Sum`, `t.Log`, `mu.Lock`).
 */
function isFileNameChain(chain: string, tail: string): boolean {
  return chain.includes(".") && FILE_LIKE_TAILS.has(tail.toLowerCase()) && !/^[A-Z][a-z0-9]/.test(tail);
}

export function memberReferenceNames(text: string): Set<string> {
  const out = new Set<string>();
  for (const match of text.matchAll(MEMBER_CHAIN_RE)) {
    const chain = match[0];
    const segments = chain.split(MEMBER_SEPARATOR_RE);
    const tail = segments[segments.length - 1]!;
    if (isFileNameChain(chain, tail)) continue;
    if (isDomainLike(chain, tail)) continue;
    for (const member of segments.slice(1)) {
      if (member.length >= 2 && /^[A-Z]/.test(member)) out.add(member.toLowerCase());
    }
  }
  for (const match of text.matchAll(EMPTY_CALL_RE)) {
    const name = match[1]!;
    if (name.length >= 2) out.add(name.toLowerCase());
  }
  return out;
}

export interface PackageMemberPair {
  readonly owner: string;
  readonly member: string;
}

/**
 * `meter.Sum`, `rules.Check`: a capitalized member qualified through `.` by a
 * lowercase owner — a Go package, or a module a file or directory names. The
 * owner says WHERE the member is declared, which `memberReferenceNames`
 * alone drops: two packages that both declare `Sum` are told apart only by
 * it. A capitalized owner (`Service.Post`) is a type, not a package; file
 * names and domains are excluded as above. Capped at two pairs, like the
 * locator's `Class.method` anchor.
 */
export function packageMemberPairs(text: string): PackageMemberPair[] {
  const out: PackageMemberPair[] = [];
  for (const match of text.matchAll(MEMBER_CHAIN_RE)) {
    const chain = match[0];
    if (/::|#|->/.test(chain)) continue;
    const segments = chain.split(".");
    const tail = segments[segments.length - 1]!;
    if (isFileNameChain(chain, tail) || isDomainLike(chain, tail)) continue;
    for (let index = 0; index + 1 < segments.length; index++) {
      const owner = segments[index]!;
      const member = segments[index + 1]!;
      if (!/^[a-z][a-z0-9_]+$/.test(owner) || !/^[A-Z][A-Za-z0-9_]+$/.test(member)) continue;
      if (out.some((pair) => pair.owner === owner && pair.member === member)) continue;
      out.push({ owner, member });
      if (out.length >= 2) return out;
    }
  }
  return out;
}
