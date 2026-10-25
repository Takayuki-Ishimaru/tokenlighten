import {isCopilotCliClient} from "./clientAdvertisement.js";

/** Explicit gutter settings retain their existing meaning. */
export function preferExactAnswerBody(clientId: string | undefined): boolean {
  return process.env["TL_ANSWER_LINE_GUTTER"] === undefined && isCopilotCliClient(clientId);
}

function logicalLines(text: string): string[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (text.endsWith("\n")) lines.pop();
  return lines;
}

/** Only an exact, contiguous source slice can use range-relative line positions. */
export function isExactContiguousBody(body: string, source: string, start: number, end: number): boolean {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start) return false;
  const lines = logicalLines(source), shown = logicalLines(body);
  return end <= lines.length && shown.length === end - start + 1
    && shown.every((line, index) => line === lines[start - 1 + index]);
}

/** Use the same host policy for admission estimates and final body rendering. */
export function estimateAnswerBody(lines: readonly string[], start: number, clientId: string | undefined): string {
  const source = lines.join("\n");
  if (preferExactAnswerBody(clientId) && isExactContiguousBody(source, source, 1, lines.length)) return source;
  return lines.map((line, index) => (start + index) + "|" + line).join("\n");
}
