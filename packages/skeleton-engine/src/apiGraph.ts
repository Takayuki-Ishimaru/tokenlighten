// Plain data only — no meta envelope, no 'tokenlighten:meta' wrappers.
// Reason: docs/00-postmortem.md §2.2

/**
 * API endpoint extraction for CI skeleton.
 *
 * Ported from proto/src/core/apiGraph.ts — handler detection only.
 * Consumer extraction is omitted (spec §1.4: handler side only in the
 * API endpoints table; consumers are noise for the skeleton use case).
 *
 * Supported frameworks:
 *   - Spring (Java/Kotlin): @GetMapping, @PostMapping, @RequestMapping
 *   - Ktor (Kotlin): get(), post(), etc. inside route()/authenticate() blocks
 *   - FastAPI / Flask / Django (Python): @app.get, @router.post, etc.
 *   - Express / Fastify / Hono (TypeScript/JavaScript): app.get(), router.post()
 *   - NestJS (TypeScript): @Get(), @Post() decorators
 *   - Go: chi, gin, net/http
 *   - ASP.NET C#: [HttpGet], [HttpPost]
 *   - Laravel PHP: Route::get, Route::post
 *   - Rails Ruby: get, post, put, patch, delete, head, options
 */

export interface ApiHandler {
  file: string;
  line: number;
  path: string;
  method: string;
  handler: string;
  snippet: string;
  confidence: "high" | "medium" | "low";
}

const HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);

// Callers invoke this once per matchAll hit with the SAME text string, so a
// fresh scan from index 0 per call made extraction O(matches × bytes) on
// route-dense files. Memoize the newline positions of the last-seen text
// (reference hit inside a per-file match loop) and binary-search per call.
let lineOfMemoText: string | undefined;
let lineOfMemoNewlines: number[] = [];

function lineOf(text: string, index: number): number {
  if (text !== lineOfMemoText) {
    const positions: number[] = [];
    for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) positions.push(i);
    lineOfMemoText = text;
    lineOfMemoNewlines = positions;
  }
  const nl = lineOfMemoNewlines;
  let lo = 0;
  let hi = nl.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (nl[mid]! < index) lo = mid + 1;
    else hi = mid;
  }
  return lo + 1;
}

function lineAt(text: string, line: number): string {
  return text.split(/\r\n|\r|\n/)[line - 1]?.trim() ?? "";
}

export function normalizeEndpointPath(raw: string): string | undefined {
  let s = raw.trim();
  if (!s) return undefined;
  const thymeleaf = s.match(/^@\{([^}]+)\}$/);
  if (thymeleaf) s = thymeleaf[1]!;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    try { s = new URL(s).pathname; } catch { return undefined; }
  }
  s = s.split(/[?#]/)[0]!.trim();
  if (!s || s === "#" || s.startsWith("mailto:") || s.startsWith("tel:")) return undefined;
  if (s.startsWith("${") || s.startsWith("#{")) return undefined;
  if (!s.startsWith("/")) s = "/" + s;
  return s.replace(/\/{2,}/g, "/").replace(/\/+$/, "") || "/";
}

function joinPaths(base: string, leaf: string): string {
  const left = normalizeEndpointPath(base || "/") ?? "/";
  const right = normalizeEndpointPath(leaf || "/") ?? "/";
  if (left === "/") return right;
  if (right === "/") return left;
  return `${left}/${right.replace(/^\/+/, "")}`.replace(/\/{2,}/g, "/").replace(/\/+$/, "");
}

function pathLiterals(args: string | undefined): string[] {
  if (!args?.trim()) return [""];
  const focused = args.match(/\b(?:value|path)\s*=\s*(\{[^}]*\}|["'][^"']*["'])/i)?.[1];
  const source = focused ?? args;
  const strings = [...source.matchAll(/["']([^"']*)["']/g)]
    .map((m) => m[1]!.trim())
    .filter((s) => s.length > 0)
    .filter((s) => s.startsWith("/") || (!s.includes(":") && !s.includes("/") && !s.includes(".")));
  return strings.length ? strings : [""];
}

function parenDelta(line: string): number {
  let n = 0;
  for (const ch of line) {
    if (ch === "(") n++;
    else if (ch === ")") n--;
  }
  return n;
}

function collectBalanced(lines: string[], start: number): { text: string; end: number } {
  const parts: string[] = [];
  let balance = 0;
  let sawParen = false;
  for (let i = start; i < lines.length; i++) {
    const line = lines[i]!;
    parts.push(line);
    if (line.includes("(")) sawParen = true;
    balance += parenDelta(line);
    if (!sawParen || balance <= 0) return { text: parts.join("\n"), end: i };
  }
  return { text: parts.join("\n"), end: lines.length - 1 };
}

function collectMethodHead(lines: string[], start: number): { text: string; end: number } | undefined {
  const first = lines[start]?.trim() ?? "";
  if (!/\b[A-Za-z_$][\w$]*\s*\(/.test(first)) return undefined;
  const parts: string[] = [];
  for (let i = start; i < lines.length; i++) {
    const line = lines[i]!;
    parts.push(line);
    if (line.includes("{")) return { text: parts.join("\n"), end: i };
    if (line.includes(";")) return undefined;
  }
  return undefined;
}

const JAVA_METHOD_RE =
  /\b(?:public|protected|private)?\s*(?:static\s+)?(?:final\s+)?(?:synchronized\s+)?(?:[\w$<>\[\],.?]+\s+)+([A-Za-z_$][\w$]*)\s*\([\s\S]*\)\s*(?:throws\s+[\w$.,\s]+)?\{/;

function parseJavaAnnotations(line: string, lineNo: number): Array<{ methods: string[]; paths: string[]; line: number; snippet: string }> {
  const out: Array<{ methods: string[]; paths: string[]; line: number; snippet: string }> = [];
  const re = /@(GetMapping|PostMapping|PutMapping|PatchMapping|DeleteMapping|RequestMapping)\b\s*(?:\(([\s\S]*?)\))?/g;
  const snippet = line.split(/\r\n|\r|\n/).map((s) => s.trim()).find((s) => s.length > 0) ?? line.trim();
  for (const m of line.matchAll(re)) {
    const name = m[1]!;
    const args = m[2];
    const fixed = name.replace("Mapping", "").toUpperCase();
    const methods =
      name === "RequestMapping"
        ? [...(args ?? "").matchAll(/\bRequestMethod\.([A-Z]+)/g)].map((mm) => mm[1]!).filter((mm) => HTTP_METHODS.has(mm))
        : [fixed];
    out.push({
      methods: methods.length ? methods : ["*"],
      paths: pathLiterals(args).map((p) => normalizeEndpointPath(p) ?? ""),
      line: lineNo,
      snippet,
    });
  }
  return out;
}

function extractSpringHandlers(text: string, language: string | undefined, file: string): ApiHandler[] {
  if (language !== "java" && language !== "kotlin") return [];
  const out: ApiHandler[] = [];
  let classBases = [""];
  let pending: Array<{ methods: string[]; paths: string[]; line: number; snippet: string }> = [];
  const lines = text.split(/\r\n|\r|\n/);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const lineNo = i + 1;
    const annotationBlock =
      /@(GetMapping|PostMapping|PutMapping|PatchMapping|DeleteMapping|RequestMapping)\b/.test(line)
        ? collectBalanced(lines, i)
        : undefined;
    const annotations = annotationBlock
      ? parseJavaAnnotations(annotationBlock.text, lineNo)
      : parseJavaAnnotations(line, lineNo);
    if (annotations.length) pending.push(...annotations);
    if (annotationBlock) {
      i = annotationBlock.end;
      continue;
    }

    if (/^\s*(?:public|protected|private|abstract|final|static|\s)*\b(?:class|interface|record)\s+[A-Za-z_$][\w$]*/.test(line)) {
      const bases = pending.flatMap((a) => a.paths);
      classBases = bases.length ? bases : [""];
      pending = [];
      continue;
    }

    const methodHead = collectMethodHead(lines, i);
    const method = methodHead?.text.match(JAVA_METHOD_RE);
    if (method) {
      const snippet = methodHead!.text.replace(/\s*\{[\s\S]*$/, "").replace(/\s+/g, " ").trim();
      const mappings = pending.filter((a) => a.methods.length > 0);
      for (const mapping of mappings) {
        for (const base of classBases) {
          for (const leaf of mapping.paths) {
            for (const httpMethod of mapping.methods) {
              out.push({ file, line: lineNo, path: joinPaths(base, leaf), method: httpMethod, handler: method[1]!, snippet, confidence: httpMethod === "*" ? "medium" : "high" });
            }
          }
        }
      }
      pending = [];
      i = methodHead!.end;
      continue;
    }

    if (!annotations.length && line.trim() && !line.trim().startsWith("@")) pending = [];
  }

  return out;
}

function nextFunctionName(lines: string[], start: number, language: string): { name: string; line: number; snippet: string } | undefined {
  for (let i = start; i < Math.min(lines.length, start + 8); i++) {
    const line = lines[i]!;
    const m =
      language === "python"
        ? line.match(/^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/)
        : line.match(/^\s*(?:public|private|protected|internal|static|async|\s)*(?:[\w<>\[\],.?]+\s+)?([A-Za-z_$][\w$]*)\s*\(/);
    if (m) {
      const head = collectMethodHead(lines, i);
      const snippet = head ? head.text.replace(/\s*\{[\s\S]*$/, "").replace(/\s+/g, " ").trim() : line.trim();
      return { name: m[1]!, line: i + 1, snippet };
    }
    if (line.trim() && !line.trim().startsWith("@") && !line.trim().startsWith("[")) break;
  }
  return undefined;
}

function methodFromRouteArgs(args: string | undefined): string[] {
  if (!args) return ["*"];
  const methods = [...args.matchAll(/\b(?:methods?|RequestMethod)\s*=\s*(?:\[|\{)?\s*([^\]\})]+)/gi)]
    .flatMap((m) => [...m[1]!.matchAll(/\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/gi)].map((mm) => mm[1]!.toUpperCase()))
    .filter((m) => HTTP_METHODS.has(m));
  return methods.length ? [...new Set(methods)] : ["*"];
}

function extractPythonHandlers(text: string, language: string | undefined, file: string): ApiHandler[] {
  if (language !== "python") return [];
  const out: ApiHandler[] = [];
  const lines = text.split(/\r\n|\r|\n/);
  const prefix = text.match(/\bAPIRouter\s*\([^)]*\bprefix\s*=\s*["']([^"']+)["']/)?.[1] ?? "";
  const re = /^\s*@(?:[A-Za-z_]\w*\.)?(get|post|put|patch|delete|head|options|route)\s*\(\s*["']([^"']+)["']([\s\S]*?)\)\s*$/gim;
  for (const m of text.matchAll(re)) {
    const line = lineOf(text, m.index ?? 0);
    const fn = nextFunctionName(lines, line, "python");
    const methods = m[1]!.toLowerCase() === "route" ? methodFromRouteArgs(m[3]) : [m[1]!.toUpperCase()];
    for (const method of methods) {
      out.push({ file, line: fn?.line ?? line, path: joinPaths(prefix, m[2]!), method, handler: fn?.name ?? "<handler>", snippet: fn?.snippet ?? lineAt(text, line), confidence: method === "*" ? "medium" : "high" });
    }
  }
  return out;
}

function extractTsJsHandlers(text: string, language: string | undefined, file: string): ApiHandler[] {
  if (!["javascript", "javascriptreact", "typescript", "typescriptreact"].includes(language ?? "")) return [];
  const out: ApiHandler[] = [];
  const lines = text.split(/\r\n|\r|\n/);

  const express = /\b(?:app|router|server|route)\s*\.\s*(get|post|put|patch|delete|head|options|all)\s*\(\s*["'`]([^"'`\n]+)["'`]\s*,?\s*([A-Za-z_$][\w$]*)?/gi;
  for (const m of text.matchAll(express)) {
    const line = lineOf(text, m.index ?? 0);
    out.push({ file, line, path: normalizeEndpointPath(m[2]!) ?? "/", method: m[1]!.toLowerCase() === "all" ? "*" : m[1]!.toUpperCase(), handler: m[3] ?? "<inline>", snippet: lines[line - 1]?.trim() ?? "", confidence: "high" });
  }

  let controllerBase = "";
  let pending: Array<{ methods: string[]; paths: string[]; line: number; snippet: string }> = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const lineNo = i + 1;
    const ctl = line.match(/@Controller\s*\(\s*["'`]([^"'`]*)["'`]\s*\)/);
    if (ctl) { controllerBase = ctl[1]!; continue; }
    const ann = line.match(/@(Get|Post|Put|Patch|Delete|Head|Options)\s*\(\s*(?:["'`]([^"'`]*)["'`])?\s*\)/);
    if (ann) {
      pending.push({ methods: [ann[1]!.toUpperCase()], paths: [normalizeEndpointPath(ann[2] ?? "") ?? ""], line: lineNo, snippet: line.trim() });
      continue;
    }
    if (pending.length) {
      const fn = nextFunctionName(lines, i, "typescript");
      if (fn) {
        for (const p of pending) {
          for (const method of p.methods) {
            for (const leaf of p.paths) {
              out.push({ file, line: fn.line, path: joinPaths(controllerBase, leaf), method, handler: fn.name, snippet: fn.snippet, confidence: "high" });
            }
          }
        }
        pending = [];
      } else if (line.trim() && !line.trim().startsWith("@")) {
        pending = [];
      }
    }
  }
  return out;
}

function extractGoHandlers(text: string, language: string | undefined, file: string): ApiHandler[] {
  if (language !== "go") return [];
  const out: ApiHandler[] = [];
  const lines = text.split(/\r\n|\r|\n/);
  const router = /\b[A-Za-z_]\w*\s*\.\s*(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|Get|Post|Put|Patch|Delete|Head|Options)\s*\(\s*"([^"]+)"\s*,\s*([A-Za-z_]\w*)?/g;
  for (const m of text.matchAll(router)) {
    const line = lineOf(text, m.index ?? 0);
    out.push({ file, line, path: normalizeEndpointPath(m[2]!) ?? "/", method: m[1]!.toUpperCase(), handler: m[3] ?? "<handler>", snippet: lines[line - 1]?.trim() ?? "", confidence: "high" });
  }
  const netHttp = /\bhttp\.HandleFunc\s*\(\s*"([^"]+)"\s*,\s*([A-Za-z_]\w*)/g;
  for (const m of text.matchAll(netHttp)) {
    const line = lineOf(text, m.index ?? 0);
    out.push({ file, line, path: normalizeEndpointPath(m[1]!) ?? "/", method: "*", handler: m[2]!, snippet: lines[line - 1]?.trim() ?? "", confidence: "medium" });
  }
  return out;
}

function braceDelta(line: string): number {
  let n = 0;
  for (const ch of line) {
    if (ch === "{") n++;
    else if (ch === "}") n--;
  }
  return n;
}

function extractKtorHandlers(text: string, language: string | undefined, file: string): ApiHandler[] {
  if (language !== "kotlin") return [];
  const out: ApiHandler[] = [];
  const lines = text.split(/\r\n|\r|\n/);
  let depth = 0;
  const routeStack: Array<{ depth: number; base: string }> = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const lineNo = i + 1;
    while (routeStack.length && routeStack[routeStack.length - 1]!.depth > depth) routeStack.pop();
    const base = routeStack.reduce((acc, entry) => joinPaths(acc, entry.base), "");

    const endpoint = line.match(/\b(get|post|put|patch|delete|head|options)\s*\(\s*(?:(["'])([^"']*)\2\s*)?(?:,\s*::([A-Za-z_]\w*))?/i);
    if (endpoint) {
      const method = endpoint[1]!.toUpperCase();
      const leaf = endpoint[3] ?? "";
      const handler = endpoint[4] ?? "<inline>";
      out.push({ file, line: lineNo, path: joinPaths(base, leaf), method, handler, snippet: line.trim(), confidence: handler === "<inline>" ? "medium" : "high" });
    }

    const route = line.match(/\b(?:route|authenticate)\s*\(\s*(?:(["'])([^"']*)\1)?/);
    const delta = braceDelta(line);
    if (route && delta > 0) {
      routeStack.push({ depth: depth + delta, base: route[2] ?? "" });
    }
    depth += delta;
    while (routeStack.length && routeStack[routeStack.length - 1]!.depth > depth) routeStack.pop();
  }

  return out;
}

function csharpMethods(attr: string): string[] {
  const m = attr.match(/\bHttp(Get|Post|Put|Patch|Delete|Head|Options)\b/i)?.[1];
  return m ? [m.toUpperCase()] : ["*"];
}

function csharpPath(attr: string): string {
  return attr.match(/["']([^"']*)["']/)?.[1] ?? "";
}

function extractCsharpHandlers(text: string, language: string | undefined, file: string): ApiHandler[] {
  if (language !== "csharp") return [];
  const out: ApiHandler[] = [];
  const lines = text.split(/\r\n|\r|\n/);
  let classBase = "";
  let className = "";
  let pendingAttrs: { attr: string; line: number }[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const lineNo = i + 1;
    const attrLine = line.trim().startsWith("[") ? line.trim() : "";
    const attrMatches = attrLine.match(/\[(Route|HttpGet|HttpPost|HttpPut|HttpPatch|HttpDelete|HttpHead|HttpOptions)\b/i);
    if (attrMatches) { pendingAttrs.push({ attr: attrLine, line: lineNo }); continue; }
    const cls = line.match(/\bclass\s+([A-Za-z_]\w*)/);
    if (cls) {
      className = cls[1]!;
      const route = pendingAttrs.find((a) => /\[Route\b/.test(a.attr));
      classBase = route ? csharpPath(route.attr) : "";
      if (classBase.includes("[controller]")) classBase = classBase.replace(/\[controller\]/gi, className.replace(/Controller$/, "").toLowerCase());
      pendingAttrs = [];
      continue;
    }
    const fn = nextFunctionName(lines, i, "csharp");
    if (fn && pendingAttrs.length) {
      for (const attr of pendingAttrs.filter((a) => /\[Http|Route\b/.test(a.attr))) {
        const methods = csharpMethods(attr.attr);
        const leaf = csharpPath(attr.attr);
        for (const method of methods) {
          out.push({ file, line: fn.line, path: joinPaths(classBase, leaf), method, handler: fn.name, snippet: fn.snippet, confidence: method === "*" ? "medium" : "high" });
        }
      }
      pendingAttrs = [];
      continue;
    }
    if (line.trim() && !line.trim().startsWith("[")) pendingAttrs = [];
  }
  return out;
}

function phpHandlerLabel(args: string | undefined): string {
  const body = args ?? "";
  const arrayMethod = body.match(/\[\s*[A-Za-z_\\][\w\\]*(?:::class)?\s*,\s*["']([^"']+)["']/)?.[1];
  if (arrayMethod) return arrayMethod;
  const controllerAt = body.match(/["']([^"']+@[A-Za-z_]\w*)["']/)?.[1];
  if (controllerAt) return controllerAt;
  const callable = body.match(/\b([A-Za-z_]\w*)\s*(?:,|\)|$)/)?.[1];
  if (callable && callable !== "function") return callable;
  return body.includes("function") || body.includes("fn") ? "<inline>" : "<handler>";
}

function extractPhpHandlers(text: string, language: string | undefined, file: string): ApiHandler[] {
  if (language !== "php") return [];
  const out: ApiHandler[] = [];
  const lines = text.split(/\r\n|\r|\n/);
  const push = (index: number, method: string, rawPath: string, args: string | undefined, confidence: "high" | "medium" | "low" = "high") => {
    const line = lineOf(text, index);
    out.push({ file, line, path: normalizeEndpointPath(rawPath) ?? "/", method, handler: phpHandlerLabel(args), snippet: lines[line - 1]?.trim() ?? "", confidence });
  };
  const laravel = /\bRoute::(get|post|put|patch|delete|head|options|any)\s*\(\s*(["'])([^"']+)\2\s*,\s*([\s\S]{0,260}?)\)/gi;
  for (const m of text.matchAll(laravel)) push(m.index ?? 0, m[1]!.toLowerCase() === "any" ? "*" : m[1]!.toUpperCase(), m[3]!, m[4], m[1]!.toLowerCase() === "any" ? "medium" : "high");
  return out;
}

function rubyHandlerLabel(args: string | undefined): string {
  const body = args ?? "";
  const to = body.match(/\bto:\s*["']([^"']+)["']/)?.[1];
  if (to) return to;
  const action = body.match(/\baction:\s*["']?([A-Za-z_]\w*)["']?/)?.[1];
  return action ?? (body.includes(" do") ? "<inline>" : "<handler>");
}

function extractRubyHandlers(text: string, language: string | undefined, file: string): ApiHandler[] {
  if (language !== "ruby") return [];
  const out: ApiHandler[] = [];
  const lines = text.split(/\r\n|\r|\n/);
  const push = (index: number, method: string, rawPath: string, args: string | undefined, confidence: "high" | "medium" | "low" = "high") => {
    const line = lineOf(text, index);
    out.push({ file, line, path: normalizeEndpointPath(rawPath) ?? "/", method, handler: rubyHandlerLabel(args), snippet: lines[line - 1]?.trim() ?? "", confidence });
  };
  const direct = /^\s*(get|post|put|patch|delete|head|options)\s+(?:\(\s*)?["']([^"']+)["']([^\n]*)/gim;
  for (const m of text.matchAll(direct)) push(m.index ?? 0, m[1]!.toUpperCase(), m[2]!, m[3], "high");
  return out;
}

/**
 * Extract API handler entries from source text.
 * Returns only handler-side entries (not consumer-side).
 */
type ApiExtractor = (text: string, language: string | undefined, file: string) => ApiHandler[];

export const API_HANDLER_EXTRACTORS: readonly ApiExtractor[] = [
  extractSpringHandlers,
  extractPythonHandlers,
  extractTsJsHandlers,
  extractGoHandlers,
  extractKtorHandlers,
  extractCsharpHandlers,
  extractPhpHandlers,
  extractRubyHandlers,
];

export function extractApiHandlers(text: string, language: string | undefined, file: string): ApiHandler[] {
  return API_HANDLER_EXTRACTORS.flatMap((extract) => extract(text, language, file));
}
