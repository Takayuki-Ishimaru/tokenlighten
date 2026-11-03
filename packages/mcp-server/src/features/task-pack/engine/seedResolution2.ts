// seedResolution — extracted implementation; imports point to the owning modules.
import * as fs from "fs";
import { lightAnswerHasWholeIdentifier } from "../lightAnswer.js";
import { maskCommentsAndStrings } from "../sfCodeMask.js";
import { readFileForRequest } from "../../../util/requestFileCache.js";
import { walkCodeFiles } from "../../../tools/walkRepo.js";

/** The other-file scan gives up (and the light path with it) past this many code files. */
export const LIGHT_ANSWER_MAX_SCAN_FILES = 5000;

/**
 * `name@path` for the first subject name with a whole-identifier occurrence in
 * the code (comments and string literals masked) of a workspace file other
 * than `relPath`, over the same walk the find universe uses; `"scan-bound"` when
 * the walk is too large to scan; undefined when no other file names any.
 */
export function lightAnswerSubjectElsewhere(workspace: string, relPath: string, names: readonly string[]): string | undefined {
  const files = walkCodeFiles(workspace, {});
  if (files.length > LIGHT_ANSWER_MAX_SCAN_FILES) return "scan-bound";
  for (const file of files) {
    if (file.relPath === relPath || file.kind === "artifact") continue;
    let content: string;
    try {
      const stat = fs.statSync(file.absPath);
      if (!stat.isFile() || stat.size > 2 * 1024 * 1024) continue;
      // served-bytes: not-served (TL_EFF_LIGHT_ANSWER applicability scan: only tested for a subject name's whole-identifier occurrence; the light path serves the one target file through readServedText, never these)
      content = readFileForRequest(file.absPath).toString("utf8");
    } catch {
      continue;
    }
    const present = names.filter((name) => content.includes(name));
    if (present.length === 0) continue;
    const masked = maskCommentsAndStrings(content, { language: file.language });
    for (const name of present) {
      if (lightAnswerHasWholeIdentifier(masked, name)) return `${name}@${file.relPath}`;
    }
  }
  return undefined;
}

/** Files one listed item's discharge scan reads at most. */
export const LISTED_ITEM_SCAN_MAX_FILES = 400;

/** A discharge row spans its declaration's head to the derived line when that is at most this many lines. */
export const LISTED_ITEM_WINDOW_MAX_LINES = 8;

/** The listed item's text is quoted in the row's `why` up to this many characters. */
export const LISTED_ITEM_WHY_MAX_CHARS = 80;
