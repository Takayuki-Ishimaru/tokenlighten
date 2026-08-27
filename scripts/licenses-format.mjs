/** Escape untrusted metadata for one physical Markdown table or heading line. */
export function markdownCell(value) {
  return String(value ?? "")
    .split(/\r\n|\r|\n|\u2028|\u2029/)
    .join(" ")
    .replaceAll("|", "&#124;")
    .trim();
}
