import type { ToolCallResult } from "../../../protocol/result.js";
import { recordReadMode } from "../../../state/session.js";
import { isMarkdownPath, parseMarkdownHeadings } from "../../../util/markdownSections.js";
import { toolError, toolOk } from "../../../protocol/result.js";
import { shaOfText, handleTable, shortSha } from "../../../util/handles.js";
import { buildOverview } from "../../../tools/readCodeOverview.js";
import { servedTextForRoute, undecodableTextMessage, capEnvelopeArray, DOC_HEADINGS_CAP_ENTRIES, DOC_HEADINGS_CAP_BYTES } from "../../../serverOwned/read-admission2.js";

export interface read_overviewPort {
  "mode": string;
  "workspace": string;
  "resolvedPath": string | undefined;
  "args": Record<string, unknown>;
}
export async function read_overview(port: read_overviewPort): Promise<ToolCallResult | undefined> {
  const { mode, workspace, resolvedPath, args } = port;
if (mode === "overview") {
        recordReadMode(workspace, "map");
        if (resolvedPath && isMarkdownPath(resolvedPath)) {
          // served-bytes: readServedText
          const mdOverviewVerdict = await servedTextForRoute(resolvedPath, workspace);
          if (mdOverviewVerdict !== null && mdOverviewVerdict.kind === "undecodable") {
            return toolError(undecodableTextMessage(resolvedPath, mdOverviewVerdict), { code: "read-error" });
          }
          const markdown = mdOverviewVerdict === null ? null : mdOverviewVerdict.text;
          if (markdown === null) return toolError(`File not found or outside workspace: ${resolvedPath}`, { code: "not-found" });
          const headings = parseMarkdownHeadings(markdown);
          const fullSha = shaOfText(markdown);
          const fileHandle = handleTable.upsert({
            kind: "file",
            path: resolvedPath,
            workspaceRoot: workspace,
            sha: fullSha,
          });
          const summary = markdown
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter((line) => line && !/^#{1,6}\s/.test(line) && !/^(```|---$|<!--)/.test(line))
            .slice(0, 3)
            .join(" ")
            .slice(0, 600);
          // Entry cap alone is not enough (see DOC_HEADINGS_CAP_* — the
          // md_4800kb envelope regression): pathological generated headings
          // can still bloat a fixed entry count, so the serialized sections
          // list shares the outline byte cap.
          const sections = capEnvelopeArray(
            headings.slice(0, DOC_HEADINGS_CAP_ENTRIES).map((heading) => ({
              heading: heading.text,
              section: heading.path,
              level: heading.level,
              range: `${heading.line}-${heading.endLine}`,
            })),
            DOC_HEADINGS_CAP_ENTRIES,
            DOC_HEADINGS_CAP_BYTES,
          );
          const firstSection = sections.find((section) => section.level > 1) ?? sections[0];
          return toolOk({
            mode: "overview",
            kind: "markdown",
            path: resolvedPath,
            handle: fileHandle.id,
            sha: shortSha(fullSha),
            ...(headings[0] ? { title: headings[0].text } : {}),
            ...(summary ? { summary } : {}),
            sections,
            truncated: headings.length > sections.length,
            ...(headings.length > sections.length ? { sections_total: headings.length } : {}),
            ...(firstSection ? {
              next_call: { tool: "tl_read_file", arguments: { path: resolvedPath, sections: [firstSection.section] } },
            } : {}),
          });
        }
        return toolOk(buildOverview(workspace, {
          ...(args["maxTokens"] !== undefined ? { maxTokens: Number(args["maxTokens"]) } : {}),
          ...(Array.isArray(args["sections"]) ? { sections: (args["sections"] as unknown[]).map(String) } : {}),
          ...(resolvedPath ? { path: resolvedPath } : {}),
        }));
      }
  return undefined;
}
