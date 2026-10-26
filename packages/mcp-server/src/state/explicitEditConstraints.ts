import { posix } from "node:path";

/** Explicit path prohibitions are independent of a certificate's writable frontier. */
export interface ExplicitEditConstraint {
  query: string;
  paths: string[];
}

const NEGATED_EDIT_EN = /\b(?:do\s+not|don['’]?t|never)\s+(?:(?:please|ever|also|directly)\s+)*(?:change|modify|touch|alter|edit|rename|remove|delete)\b/iu;
const NEGATED_EDIT_JA = /(?:変更|修正|編集|更新|削除|改変)(?:は|を)?しない(?:で|よう)|触(?:れ|ら)?ないで/u;
const PATH_RE = /(?:\.{0,2}[\\/])?(?:[\p{L}\p{N}_$@.-]+[\\/])*[\p{L}\p{N}_$@-]+\.[A-Za-z][A-Za-z0-9.-]*|(?:[\p{L}\p{N}_$@.-]+[\\/])+[A-Za-z0-9_$@.-]*(?![A-Za-z0-9_$@.\\/-])/gu;

/** Only paths in a negated edit clause count; ordinary context reads do not. */
export function explicitEditConstraintPaths(query: string): string[] {
  const prose = query.replace(/```[\s\S]*?```/gu, "")
    .replace(/`[^`\n]*`|"[^"\n]*"|\x27[^\x27\n]*\x27|「[^」]*」|『[^』]*』/gu, (span) =>
      NEGATED_EDIT_EN.test(span) || NEGATED_EDIT_JA.test(span) ? " ".repeat(span.length) : span);
  const paths = new Set<string>();
  // Commas and Japanese commas also join path lists. Only break them when
  // they introduce an independent command (or follow a completed Japanese one).
  const clauses = prose.split(/[;\n。！？!?]|(?<=\.)\s+|[,、]\s*(?=(?:(?:and|or|but|then)\s+)*(?:please\s+)?(?:(?:do\s+not|don['’]?t|never)\s+)?(?:read|explain|change|modify|touch|alter|edit|update|rename|remove|delete)\s)|(?<=(?:変更|修正|編集|更新|削除|改変)(?:し|して|する|してください|しないで|しないでください))[,、]/iu);
  for (const clause of clauses) {
    const en = NEGATED_EDIT_EN.exec(clause);
    const ja = NEGATED_EDIT_JA.exec(clause);
    if (en === null && ja === null) continue;
    const targets = en !== null
      ? clause.slice(en.index + en[0].length).split(/\b(?:and|or|but|then)\s+(?:(?:then|please)\s+)*(?:read|explain|change|modify|touch|alter|edit|update|rename|remove|delete)\s/iu)[0]!
      : clause.slice(0, ja!.index);
    // A Japanese coordinator after an extension is prose, unless quoted as a path.
    const pathList = targets.replace(/`[^`\n]*`|"[^"\n]*"|\x27[^\x27\n]*\x27|「[^」]*」|『[^』]*』|(\.[A-Za-z][A-Za-z0-9.-]*)(?:と|および|及び)(?=[\p{L}\p{N}_$@./\\-])/gu,
      (span, extension: string | undefined) => extension === undefined ? span : extension + " ");
    for (const match of pathList.matchAll(PATH_RE)) paths.add(match[0].replace(/\.+$/u, ""));
  }
  return [...paths];
}

function relativeConstraintPath(workspaceRoot: string, candidate: string): string {
  const root = posix.normalize(workspaceRoot.replace(/\\/gu, "/")).replace(/\/$/u, "");
  const normalized = posix.normalize(candidate.replace(/\\/gu, "/")).replace(/^\.\//u, "");
  const rel = normalized.startsWith(root + "/") ? normalized.slice(root.length + 1) : normalized;
  return process.platform === "win32" ? rel.toLowerCase() : rel;
}

export function violatesExplicitEditConstraint(workspaceRoot: string, path: string, constraint: ExplicitEditConstraint): boolean {
  const target = relativeConstraintPath(workspaceRoot, path);
  return constraint.paths.some((entry) => {
    const forbidden = relativeConstraintPath(workspaceRoot, entry);
    return target === forbidden || (/[\\/]$/u.test(entry) && target.startsWith(forbidden.replace(/\/$/u, "") + "/"));
  });
}
