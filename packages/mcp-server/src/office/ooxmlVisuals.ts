import path from "node:path";

import JSZip from "jszip";

import { preflightZip, ZIP_LIMITS } from "./zipPreflight.js";

const MAX_RELEVANT_XML_PARTS = 1_000;
const MAX_CHARTS = 32;
const MAX_SERIES_PER_CHART = 16;
const MAX_POINTS_PER_SERIES = 50;
const MAX_MEDIA = 100;
const MAX_LOCATIONS = 8;
const MAX_INVENTORY_BYTES = 8_192;
// Bounds concurrent zip-entry inflation (async("string")) — defense against
// many-small-entries fan-out; see runPooled below. No p-limit dependency
// (not in the tree).
export const MAX_CONCURRENT_PART_INFLATIONS = 8;

const IMAGE_EXTENSIONS = new Set([
  "bmp", "emf", "gif", "heic", "jpeg", "jpg", "png", "svg", "tif", "tiff", "webp", "wmf",
]);
const VIDEO_EXTENSIONS = new Set([
  "avi", "m4v", "mkv", "mov", "mp4", "mpeg", "mpg", "webm", "wmv",
]);

interface ZipEntry {
  dir: boolean;
  async(type: "string"): Promise<string>;
}

interface ZipArchive {
  files: Record<string, ZipEntry>;
}

interface Relationship {
  id: string;
  type: string;
  target: string;
  external: boolean;
}

export interface OoxmlChartSeries {
  name: string;
  nameFormula?: string;
  categoryFormula?: string;
  categories: Array<string | number>;
  categoryCount: number;
  valueFormula?: string;
  values: Array<string | number>;
  valueCount: number;
}

export interface OoxmlVisualLocation {
  location: string;
  position?: string;
}

export interface OoxmlChartInfo {
  path: string;
  type: string;
  title?: string;
  locations: OoxmlVisualLocation[];
  embeddedWorkbook?: string;
  series: OoxmlChartSeries[];
}

export interface OoxmlMediaUse extends OoxmlVisualLocation {
  name?: string;
  altText?: string;
  title?: string;
  caption?: string;
}

export interface OoxmlMediaInfo {
  path: string;
  kind: "image" | "video";
  format: string;
  external?: boolean;
  uses: OoxmlMediaUse[];
}

export interface OoxmlVisualInventory {
  charts: OoxmlChartInfo[];
  media: OoxmlMediaInfo[];
  truncated: boolean;
  warnings: string[];
}

interface RelationshipReference {
  source: string;
  relationship: Relationship;
  block?: string;
  blockIndex?: number;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function decodeXml(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_match, decimal: string) => String.fromCodePoint(parseInt(decimal, 10)))
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function tagPattern(localName: string): string {
  return `(?:[A-Za-z_][\\w.-]*:)?${escapeRegExp(localName)}`;
}

function tagBlocks(xml: string, localName: string): string[] {
  const tag = tagPattern(localName);
  return [...xml.matchAll(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}\\s*>`, "gi"))]
    .map((match) => match[0]);
}

function openTags(xml: string, localName: string): string[] {
  const tag = tagPattern(localName);
  return [...xml.matchAll(new RegExp(`<${tag}\\b[^>]*\/?>`, "gi"))].map((match) => match[0]);
}

function textNodes(xml: string, localName: string): string[] {
  const tag = tagPattern(localName);
  return [...xml.matchAll(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}\\s*>`, "gi"))]
    .map((match) => decodeXml((match[1] ?? "").replace(/<[^>]+>/g, "")).trim())
    .filter(Boolean);
}

function attribute(tag: string | undefined, name: string): string | undefined {
  if (!tag) return undefined;
  const match = new RegExp(`(?:^|\\s)${escapeRegExp(name)}\\s*=\\s*([\"'])([\\s\\S]*?)\\1`, "i").exec(tag);
  return match?.[2] === undefined ? undefined : decodeXml(match[2]);
}

function extensionOf(target: string): string {
  const clean = target.split(/[?#]/, 1)[0] ?? target;
  return path.posix.extname(clean).slice(1).toLowerCase();
}

function mediaKind(target: string, relationshipType = ""): "image" | "video" | undefined {
  const ext = extensionOf(target);
  if (IMAGE_EXTENSIONS.has(ext) || relationshipType.endsWith("/image")) return "image";
  if (VIDEO_EXTENSIONS.has(ext) || relationshipType.endsWith("/video")) {
    return "video";
  }
  return undefined;
}

function normalizePackagePart(value: string): string {
  const normalized = path.posix.normalize(value.replace(/^\/+/, ""));
  return normalized.startsWith("../") ? "" : normalized;
}

function relationshipSource(relsPath: string): string | undefined {
  if (relsPath === "_rels/.rels") return "";
  const directory = path.posix.dirname(relsPath);
  if (path.posix.basename(directory) !== "_rels") return undefined;
  const filename = path.posix.basename(relsPath, ".rels");
  return normalizePackagePart(path.posix.join(path.posix.dirname(directory), filename));
}

function relationshipTarget(source: string, target: string, external: boolean): string {
  if (external) return target;
  if (target.startsWith("/")) return normalizePackagePart(target);
  return normalizePackagePart(path.posix.join(path.posix.dirname(source), target));
}

function parseRelationships(xml: string, source: string): Relationship[] {
  return openTags(xml, "Relationship").flatMap((tag) => {
    const id = attribute(tag, "Id");
    const type = attribute(tag, "Type");
    const target = attribute(tag, "Target");
    if (!id || !type || !target) return [];
    const external = attribute(tag, "TargetMode")?.toLowerCase() === "external";
    return [{ id, type, target: relationshipTarget(source, target, external), external }];
  });
}

function scalar(value: string): string | number {
  const trimmed = value.trim();
  if (/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(trimmed)) {
    const numeric = Number(trimmed);
    if (Number.isFinite(numeric)) return numeric;
  }
  return trimmed;
}

function cachedValues(block: string | undefined): Array<string | number> {
  if (!block) return [];
  const points = tagBlocks(block, "pt")
    .map((point) => ({
      index: Number(attribute(openTags(point, "pt")[0], "idx") ?? Number.MAX_SAFE_INTEGER),
      value: textNodes(point, "v")[0],
    }))
    .filter((point): point is { index: number; value: string } => point.value !== undefined)
    .sort((a, b) => a.index - b.index)
    .map((point) => scalar(point.value));
  if (points.length > 0) return points;
  return textNodes(block, "v").map(scalar);
}

function firstFormula(block: string | undefined): string | undefined {
  return block ? textNodes(block, "f")[0] : undefined;
}

function chartType(xml: string): string {
  for (const match of xml.matchAll(/<(?:[A-Za-z_][\w.-]*:)?([A-Za-z0-9]+Chart)\b/gi)) {
    const candidate = match[1] ?? "";
    if (!/^chart$/i.test(candidate)) return candidate.replace(/Chart$/i, "").toLowerCase();
  }
  return "unknown";
}

function parseChartSeries(xml: string, truncatedRef: { value: boolean }): OoxmlChartSeries[] {
  const blocks = tagBlocks(xml, "ser");
  if (blocks.length > MAX_SERIES_PER_CHART) truncatedRef.value = true;
  return blocks.slice(0, MAX_SERIES_PER_CHART).map((series, index) => {
    const textBlock = tagBlocks(series, "tx")[0];
    const categoryBlock = tagBlocks(series, "cat")[0] ?? tagBlocks(series, "xVal")[0];
    const valueBlock = tagBlocks(series, "val")[0] ?? tagBlocks(series, "yVal")[0];
    const allCategories = cachedValues(categoryBlock);
    const allValues = cachedValues(valueBlock);
    if (allCategories.length > MAX_POINTS_PER_SERIES || allValues.length > MAX_POINTS_PER_SERIES) {
      truncatedRef.value = true;
    }
    const cachedName = cachedValues(textBlock)[0];
    return {
      name: cachedName === undefined ? `Series ${index + 1}` : String(cachedName),
      ...(firstFormula(textBlock) ? { nameFormula: firstFormula(textBlock) } : {}),
      ...(firstFormula(categoryBlock) ? { categoryFormula: firstFormula(categoryBlock) } : {}),
      categories: allCategories.slice(0, MAX_POINTS_PER_SERIES),
      categoryCount: allCategories.length,
      ...(firstFormula(valueBlock) ? { valueFormula: firstFormula(valueBlock) } : {}),
      values: allValues.slice(0, MAX_POINTS_PER_SERIES),
      valueCount: allValues.length,
    };
  });
}

function contentContainers(source: string, xml: string): string[] {
  if (/^ppt\/slides\/slide\d+\.xml$/i.test(source)) {
    return [...tagBlocks(xml, "pic"), ...tagBlocks(xml, "graphicFrame")];
  }
  if (/^xl\/drawings\/drawing\d+\.xml$/i.test(source)) {
    return [
      ...tagBlocks(xml, "twoCellAnchor"),
      ...tagBlocks(xml, "oneCellAnchor"),
      ...tagBlocks(xml, "absoluteAnchor"),
    ];
  }
  if (/^word\/(?:document|header\d+|footer\d+)\.xml$/i.test(source)) {
    return tagBlocks(xml, "p");
  }
  return [];
}

function relationshipIds(block: string): string[] {
  return [...block.matchAll(/\br:(?:embed|link|id)\s*=\s*["']([^"']+)["']/gi)]
    .map((match) => match[1]!)
    .filter(Boolean);
}

function findReferenceBlock(source: string, xml: string, relationshipId: string): { block?: string; index?: number } {
  const containers = contentContainers(source, xml);
  const index = containers.findIndex((block) => relationshipIds(block).includes(relationshipId));
  return index < 0 ? {} : { block: containers[index], index };
}

function columnLetter(index: number): string {
  let value = index + 1;
  let result = "";
  while (value > 0) {
    value--;
    result = String.fromCharCode(65 + (value % 26)) + result;
    value = Math.floor(value / 26);
  }
  return result;
}

function positionOf(source: string, block: string | undefined): string | undefined {
  if (!block) return undefined;
  if (source.startsWith("xl/drawings/")) {
    const from = tagBlocks(block, "from")[0];
    const to = tagBlocks(block, "to")[0];
    const fromCol = Number(textNodes(from ?? "", "col")[0]);
    const fromRow = Number(textNodes(from ?? "", "row")[0]);
    const toCol = Number(textNodes(to ?? "", "col")[0]);
    const toRow = Number(textNodes(to ?? "", "row")[0]);
    if (Number.isFinite(fromCol) && Number.isFinite(fromRow)) {
      const start = `${columnLetter(fromCol)}${fromRow + 1}`;
      const end = Number.isFinite(toCol) && Number.isFinite(toRow)
        ? `${columnLetter(toCol)}${toRow + 1}`
        : undefined;
      return end ? `cells ${start}:${end}` : `cell ${start}`;
    }
  }

  const off = openTags(block, "off")[0];
  const extent = openTags(block, "ext")[0] ?? openTags(block, "extent")[0];
  const x = attribute(off, "x");
  const y = attribute(off, "y");
  const cx = attribute(extent, "cx");
  const cy = attribute(extent, "cy");
  const parts = [
    x !== undefined ? `x=${x}` : undefined,
    y !== undefined ? `y=${y}` : undefined,
    cx !== undefined ? `width=${cx}` : undefined,
    cy !== undefined ? `height=${cy}` : undefined,
  ].filter((part): part is string => part !== undefined);
  return parts.length > 0 ? `${parts.join(", ")} EMU` : undefined;
}

function labelForPart(part: string): string {
  const slide = /^ppt\/slides\/slide(\d+)\.xml$/i.exec(part);
  if (slide) return `Slide ${slide[1]}`;
  const header = /^word\/header(\d+)\.xml$/i.exec(part);
  if (header) return `Header ${header[1]}`;
  const footer = /^word\/footer(\d+)\.xml$/i.exec(part);
  if (footer) return `Footer ${footer[1]}`;
  if (part === "word/document.xml") return "Document";
  const drawing = /^xl\/drawings\/drawing(\d+)\.xml$/i.exec(part);
  if (drawing) return `Drawing ${drawing[1]}`;
  return part || "Package";
}

function wordCaption(sourceXml: string, block: string | undefined): string | undefined {
  if (!block) return undefined;
  const paragraphs = tagBlocks(sourceXml, "p");
  const index = paragraphs.indexOf(block);
  if (index < 0) return undefined;
  const next = paragraphs[index + 1];
  const styleTag = openTags(next ?? "", "pStyle")[0];
  const style = attribute(styleTag, "w:val") ?? attribute(styleTag, "val");
  if (!style || !/caption/i.test(style)) return undefined;
  const caption = textNodes(next ?? "", "t").join(" ").trim();
  return caption || undefined;
}

function mediaUse(
  reference: RelationshipReference,
  sourceXml: string | undefined,
  labels: Map<string, string>,
): OoxmlMediaUse {
  const metadataTag = reference.block?.match(/<(?:[A-Za-z_][\w.-]*:)?(?:cNvPr|docPr)\b[^>]*>/i)?.[0];
  const base = labels.get(reference.source) ?? labelForPart(reference.source);
  const suffix = reference.blockIndex === undefined ? "" : ` / object ${reference.blockIndex + 1}`;
  return {
    location: `${base}${suffix}`,
    ...(positionOf(reference.source, reference.block) ? { position: positionOf(reference.source, reference.block) } : {}),
    ...(attribute(metadataTag, "name") ? { name: attribute(metadataTag, "name") } : {}),
    ...(attribute(metadataTag, "descr") ? { altText: attribute(metadataTag, "descr") } : {}),
    ...(attribute(metadataTag, "title") ? { title: attribute(metadataTag, "title") } : {}),
    ...(reference.source.startsWith("word/") && sourceXml && wordCaption(sourceXml, reference.block)
      ? { caption: wordCaption(sourceXml, reference.block) }
      : {}),
  };
}

function referencesByTarget(
  relationships: Map<string, Relationship[]>,
  xmlParts: Map<string, string>,
): Map<string, RelationshipReference[]> {
  const result = new Map<string, RelationshipReference[]>();
  for (const [source, rels] of relationships) {
    const sourceXml = xmlParts.get(source);
    for (const relationship of rels) {
      const isChart = relationship.type.endsWith("/chart") || /\/(?:charts)\/chart\d+\.xml$/i.test(relationship.target);
      const isMedia = mediaKind(relationship.target, relationship.type) !== undefined;
      if (!isChart && !isMedia) continue;
      const blockInfo = sourceXml ? findReferenceBlock(source, sourceXml, relationship.id) : {};
      const entries = result.get(relationship.target) ?? [];
      entries.push({ source, relationship, block: blockInfo.block, blockIndex: blockInfo.index });
      result.set(relationship.target, entries);
    }
  }
  return result;
}

function buildPartLabels(
  xmlParts: Map<string, string>,
  relationships: Map<string, Relationship[]>,
): Map<string, string> {
  const labels = new Map<string, string>();
  for (const part of xmlParts.keys()) labels.set(part, labelForPart(part));

  const workbookXml = xmlParts.get("xl/workbook.xml");
  if (workbookXml) {
    const workbookRels = relationships.get("xl/workbook.xml") ?? [];
    for (const sheetTag of openTags(workbookXml, "sheet")) {
      const name = attribute(sheetTag, "name");
      const relId = attribute(sheetTag, "r:id");
      const rel = workbookRels.find((candidate) => candidate.id === relId);
      if (name && rel) labels.set(rel.target, `Sheet \"${name}\"`);
    }
  }

  for (let pass = 0; pass < 2; pass++) {
    for (const [source, rels] of relationships) {
      const sourceLabel = labels.get(source);
      if (!sourceLabel) continue;
      for (const rel of rels) {
        if (rel.type.endsWith("/drawing") || rel.target.startsWith("xl/drawings/")) {
          labels.set(rel.target, sourceLabel);
        }
      }
    }
  }
  return labels;
}

function boundInventory(inventory: OoxmlVisualInventory): OoxmlVisualInventory {
  let changed = inventory.truncated;
  let stringsClipped = false;
  const clip = (value: string | undefined, max = 256): string | undefined =>
    value !== undefined && value.length > max ? `${value.slice(0, max - 1)}…` : value;
  const clipStrings = (): void => {
    inventory.warnings = inventory.warnings.slice(0, 8).map((warning) => clip(warning)!);
    for (const chart of inventory.charts) {
      chart.path = clip(chart.path)!;
      chart.type = clip(chart.type)!;
      chart.title = clip(chart.title);
      chart.embeddedWorkbook = clip(chart.embeddedWorkbook);
      chart.locations = chart.locations.map((location) => ({
        location: clip(location.location)!,
        ...(clip(location.position) ? { position: clip(location.position) } : {}),
      }));
      for (const series of chart.series) {
        series.name = clip(series.name)!;
        series.nameFormula = clip(series.nameFormula);
        series.categoryFormula = clip(series.categoryFormula);
        series.valueFormula = clip(series.valueFormula);
        series.categories = series.categories.map((value) => typeof value === "string" ? clip(value)! : value);
        series.values = series.values.map((value) => typeof value === "string" ? clip(value)! : value);
      }
    }
    for (const item of inventory.media) {
      item.path = clip(item.path)!;
      item.format = clip(item.format)!;
      item.uses = item.uses.map((use) => ({
        location: clip(use.location)!,
        ...(clip(use.position) ? { position: clip(use.position) } : {}),
        ...(clip(use.name) ? { name: clip(use.name) } : {}),
        ...(clip(use.altText) ? { altText: clip(use.altText) } : {}),
        ...(clip(use.title) ? { title: clip(use.title) } : {}),
        ...(clip(use.caption) ? { caption: clip(use.caption) } : {}),
      }));
    }
  };

  const contentBudget = MAX_INVENTORY_BYTES - 160;
  while (Buffer.byteLength(JSON.stringify(inventory), "utf8") > contentBudget) {
    const reducible = inventory.charts
      .flatMap((chart) => chart.series)
      .find((series) => series.categories.length > 8 || series.values.length > 8);
    if (reducible) {
      reducible.categories = reducible.categories.slice(0, Math.max(8, Math.floor(reducible.categories.length / 2)));
      reducible.values = reducible.values.slice(0, Math.max(8, Math.floor(reducible.values.length / 2)));
      changed = true;
      continue;
    }
    if (!stringsClipped) {
      clipStrings();
      stringsClipped = true;
      changed = true;
      continue;
    }
    const mediaWithUses = inventory.media.find((item) => item.uses.length > 1);
    if (mediaWithUses) {
      mediaWithUses.uses.pop();
      changed = true;
      continue;
    }
    if (inventory.media.length > 1) {
      inventory.media.pop();
      changed = true;
      continue;
    }
    const chartWithSeries = inventory.charts.find((chart) => chart.series.length > 1);
    if (chartWithSeries) {
      chartWithSeries.series.pop();
      changed = true;
      continue;
    }
    if (inventory.charts.length > 1) {
      inventory.charts.pop();
      changed = true;
      continue;
    }
    if (inventory.media.length > 0 && inventory.charts.length > 0) {
      inventory.media.pop();
      changed = true;
      continue;
    }
    break;
  }
  if (changed) {
    inventory.truncated = true;
    if (!inventory.warnings.includes("Visual inventory was truncated to stay within the response budget.")) {
      inventory.warnings.push("Visual inventory was truncated to stay within the response budget.");
    }
  }
  return inventory;
}

export function hasOoxmlVisualInventory(inventory: OoxmlVisualInventory): boolean {
  return inventory.charts.length > 0 || inventory.media.length > 0;
}

export interface ExtractOoxmlVisualInventoryOptions {
  /**
   * Set by callers that already ran preflightZip() on these exact bytes
   * (server.ts's mode=artifact branch preflights once and fans out to
   * every OOXML consumer, including this function — see TL-V0.9-RELEASE-
   * STRATEGY-2026-08-12.md §6.6). Skips a redundant second preflight walk.
   * Callers that omit this get preflighted for them below: this function
   * must never hand un-preflighted bytes to JSZip.loadAsync.
   */
  preflighted?: boolean;
}

/**
 * Tiny fixed-size concurrency pool — no p-limit dependency (not in the
 * tree). Runs `items` through `worker` with at most `limit` in flight at
 * once. Bounds the cost of inflating many OOXML parts in parallel — up to
 * MAX_RELEVANT_XML_PARTS entries used to run fully concurrently via a bare
 * Promise.all before this (§6.6).
 */
export async function runPooled<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));
  const runners = Array.from({ length: workerCount }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      await worker(items[index] as T);
    }
  });
  await Promise.all(runners);
}

export async function extractOoxmlVisualInventory(
  bytes: Uint8Array,
  kind: "docx" | "xlsx" | "pptx",
  options?: ExtractOoxmlVisualInventoryOptions,
): Promise<OoxmlVisualInventory> {
  const warnings: string[] = [];

  if (!options?.preflighted) {
    const preflight = await preflightZip(bytes);
    if (!preflight.ok) {
      return {
        charts: [],
        media: [],
        truncated: false,
        warnings: [`Visual inventory unavailable: zip preflight failed (${preflight.code}): ${preflight.detail}`],
      };
    }
  }

  let zip: ZipArchive;
  try {
    zip = await JSZip.loadAsync(bytes) as unknown as ZipArchive;
  } catch (error: unknown) {
    return {
      charts: [],
      media: [],
      truncated: false,
      warnings: [`Visual inventory unavailable: ${error instanceof Error ? error.message.slice(0, 160) : String(error).slice(0, 160)}`],
    };
  }

  const allPaths = Object.keys(zip.files).filter((entryPath) => !zip.files[entryPath]!.dir).sort();
  const relevantPaths = allPaths.filter((entryPath) =>
    entryPath.endsWith(".rels")
    || /^(?:ppt\/slides\/.*|word\/.*|xl\/(?:workbook|worksheets\/.*|drawings\/.*)|(?:ppt|word|xl)\/charts\/.*)\.xml$/i.test(entryPath)
  );
  const selectedPaths = relevantPaths.slice(0, MAX_RELEVANT_XML_PARTS);
  let truncated = relevantPaths.length > selectedPaths.length;
  if (truncated) warnings.push(`Only the first ${MAX_RELEVANT_XML_PARTS} relevant OOXML parts were inspected.`);

  const xmlParts = new Map<string, string>();
  await runPooled(selectedPaths, MAX_CONCURRENT_PART_INFLATIONS, async (entryPath) => {
    try {
      const raw = await zip.files[entryPath]!.async("string");
      if (Buffer.byteLength(raw, "utf8") > ZIP_LIMITS.maxPartUncompressedBytes) {
        warnings.push(`OOXML part exceeds per-part size limit, skipped: ${entryPath}`);
        return;
      }
      xmlParts.set(entryPath, raw);
    } catch {
      warnings.push(`Could not read OOXML part: ${entryPath}`);
    }
  });

  const relationships = new Map<string, Relationship[]>();
  for (const [entryPath, xml] of xmlParts) {
    if (!entryPath.endsWith(".rels")) continue;
    const source = relationshipSource(entryPath);
    if (source !== undefined) relationships.set(source, parseRelationships(xml, source));
  }

  const labels = buildPartLabels(xmlParts, relationships);
  const references = referencesByTarget(relationships, xmlParts);
  const chartPaths = allPaths.filter((entryPath) =>
    new RegExp(`^${kind === "pptx" ? "ppt" : kind === "xlsx" ? "xl" : "word"}/charts/chart\\d+\\.xml$`, "i").test(entryPath)
  );
  if (chartPaths.length > MAX_CHARTS) truncated = true;

  const charts: OoxmlChartInfo[] = [];
  for (const chartPath of chartPaths.slice(0, MAX_CHARTS)) {
    let xml = xmlParts.get(chartPath);
    if (!xml) {
      try {
        xml = await zip.files[chartPath]!.async("string");
      } catch {
        warnings.push(`Could not read chart XML: ${chartPath}`);
        continue;
      }
    }
    const truncation = { value: false };
    const chartReferences = references.get(chartPath) ?? [];
    const locations = chartReferences.slice(0, MAX_LOCATIONS).map((reference) => ({
      location: labels.get(reference.source) ?? labelForPart(reference.source),
      ...(positionOf(reference.source, reference.block) ? { position: positionOf(reference.source, reference.block) } : {}),
    }));
    if (chartReferences.length > MAX_LOCATIONS) truncation.value = true;
    const chartRels = relationships.get(chartPath) ?? [];
    const embeddedWorkbook = chartRels.find((relationship) => extensionOf(relationship.target) === "xlsx")?.target;
    const titleBlock = tagBlocks(xml, "title")[0];
    const title = titleBlock ? textNodes(titleBlock, "t").join(" ").trim() : "";
    charts.push({
      path: chartPath,
      type: chartType(xml),
      ...(title ? { title } : {}),
      locations: locations.length > 0 ? locations : [{ location: "Package (unreferenced chart part)" }],
      ...(embeddedWorkbook ? { embeddedWorkbook } : {}),
      series: parseChartSeries(xml, truncation),
    });
    if (truncation.value) truncated = true;
  }

  const mediaMap = new Map<string, OoxmlMediaInfo>();
  for (const entryPath of allPaths) {
    const detectedKind = mediaKind(entryPath);
    if (!detectedKind || !/^(?:ppt|word|xl)\/media\//i.test(entryPath)) continue;
    mediaMap.set(entryPath, {
      path: entryPath,
      kind: detectedKind,
      format: extensionOf(entryPath) || "unknown",
      uses: [],
    });
  }
  for (const [target, targetReferences] of references) {
    const first = targetReferences[0];
    if (!first) continue;
    const detectedKind = mediaKind(target, first.relationship.type);
    if (!detectedKind) continue;
    const existing = mediaMap.get(target) ?? {
      path: target,
      kind: detectedKind,
      format: extensionOf(target) || "unknown",
      ...(first.relationship.external ? { external: true } : {}),
      uses: [],
    };
    for (const reference of targetReferences.slice(0, MAX_LOCATIONS)) {
      existing.uses.push(mediaUse(reference, xmlParts.get(reference.source), labels));
    }
    if (targetReferences.length > MAX_LOCATIONS) truncated = true;
    mediaMap.set(target, existing);
  }

  const allMedia = [...mediaMap.values()].sort((a, b) => a.path.localeCompare(b.path));
  if (allMedia.length > MAX_MEDIA) truncated = true;
  const media = allMedia.slice(0, MAX_MEDIA).map((item) => ({
    ...item,
    uses: item.uses.length > 0 ? item.uses : [{ location: "Package (no drawing relationship found)" }],
  }));

  return boundInventory({ charts, media, truncated, warnings });
}

function compactJson(value: unknown): string {
  return JSON.stringify(value);
}

export function renderOoxmlVisualInventory(inventory: OoxmlVisualInventory): string {
  const sections: string[] = [];
  if (inventory.charts.length > 0) {
    const chartLines: string[] = [];
    inventory.charts.forEach((chart, index) => {
      chartLines.push(`### Chart ${index + 1}${chart.title ? `: ${chart.title}` : ""}`);
      chartLines.push(`- Type: ${chart.type}`);
      chartLines.push(`- XML: ${chart.path}`);
      chartLines.push(`- Location: ${chart.locations.map((location) =>
        location.position ? `${location.location} (${location.position})` : location.location
      ).join("; ")}`);
      if (chart.embeddedWorkbook) chartLines.push(`- Embedded workbook: ${chart.embeddedWorkbook}`);
      for (const series of chart.series) {
        chartLines.push(`- Series ${compactJson(series.name)}: categories=${compactJson(series.categories)}; values=${compactJson(series.values)}`);
        if (series.categoryFormula || series.valueFormula) {
          chartLines.push(`  - Source: categories=${series.categoryFormula ?? "(cached only)"}; values=${series.valueFormula ?? "(cached only)"}`);
        }
      }
    });
    sections.push(`## Charts\n\n${chartLines.join("\n")}`);
  }

  if (inventory.media.length > 0) {
    const mediaLines: string[] = [];
    inventory.media.forEach((item) => {
      mediaLines.push(`- ${item.kind} ${item.path} (${item.format})`);
      for (const use of item.uses) {
        const details = [
          use.position,
          use.name ? `name=${compactJson(use.name)}` : undefined,
          use.altText ? `alt=${compactJson(use.altText)}` : undefined,
          use.title ? `title=${compactJson(use.title)}` : undefined,
          use.caption ? `caption=${compactJson(use.caption)}` : undefined,
        ].filter((value): value is string => value !== undefined);
        mediaLines.push(`  - ${use.location}${details.length > 0 ? `; ${details.join("; ")}` : ""}`);
      }
    });
    sections.push(`## Media\n\n${mediaLines.join("\n")}`);
  }
  return sections.join("\n\n");
}
