// Citation-output fields describe the answer shape, not workspace symbols.
// Preserve offsets and the complete caller query; mask only the brace list in
// an explicit citation-format instruction before extracting source subjects.
const CITATION_FIELDS_RE = /(^|[.!?;\n。])([ \t]*(?:include|return|report|output)\s+(?:the\s+)?(?:sources?|citations?)\s+(?:as|in)\s+(?:an?\s+)?(?:array|list)\s+of\s*\x60?)(\{[^{}\r\n]*\})/giu;

export function maskCitationFormatFields(query: string): string {
  return query.replace(CITATION_FIELDS_RE, (_match, boundary: string, lead: string, fields: string) =>
    boundary + lead + " ".repeat(fields.length));
}
