export interface DependencyNoticeRow {
  name: string;
  license: string;
  publisher: string;
  repository: string;
}

export interface ModelLicenseEntry {
  id?: string;
  revision?: string;
  license?: string;
  source?: string;
  licenseText?: string;
  notice?: string;
  installed?: boolean;
}

export interface LicenseContentInput {
  notices: string;
  models?: ModelLicenseEntry[];
  language: "ja" | "en";
  nonce: string;
}

const HEADER_TOKENS = ["package", "license", "publisher", "repository"];
const ALTERNATIVES_HEADING = /alternative|代替/i;

const COPY = {
  en: {
    title: "Third-party licenses",
    intro: "Licenses for bundled dependencies and model assets.",
    dependencies: "Dependencies",
    search: "Search by package name or license",
    package: "Package",
    license: "License",
    publisher: "Publisher",
    repository: "Repository",
    noRows: "No dependency inventory was found in the notices file.",
    noMatches: "No packages match your search.",
    models: "Model licenses",
    noModels: "No model licenses are listed.",
    installed: "Installed",
    available: "Available",
    revision: "Revision",
    source: "Source",
    licenseText: "License text",
    notice: "Notice",
    noLegalText: "No license text is registered for this model.",
    fullText: "Full legal text",
    fullNotices: "Original notices text",
    noticesFallback:
      "The inventory could not be read as a table. The original text is shown below.",
  },
  ja: {
    title: "サードパーティライセンス",
    intro: "同梱パッケージとモデル資産のライセンスを表示します。",
    dependencies: "依存パッケージ",
    search: "パッケージ名またはライセンスで検索",
    package: "パッケージ",
    license: "ライセンス",
    publisher: "パブリッシャー",
    repository: "リポジトリ",
    noRows: "通知ファイルから依存パッケージの一覧を読み取れませんでした。",
    noMatches: "検索条件に一致するパッケージはありません。",
    models: "モデルライセンス",
    noModels: "モデルライセンスの登録はありません。",
    installed: "インストール済み",
    available: "利用可能",
    revision: "リビジョン",
    source: "ソース",
    licenseText: "ライセンス本文",
    notice: "Notice",
    noLegalText: "このモデルのライセンス文は登録されていません。",
    fullText: "法的事項の全文",
    fullNotices: "通知文の原文",
    noticesFallback: "一覧表として読み取れなかったため、原文を表示しています。",
  },
} as const satisfies Record<string, Record<string, string>>;

type Copy = { [K in keyof typeof COPY.en]: string };

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Split one Markdown table row, honouring backslash-escaped pipes. */
function splitRow(line: string): string[] {
  let body = line.trim();
  if (body.startsWith("|")) body = body.slice(1);
  if (body.endsWith("|")) body = body.slice(0, -1);
  const cells: string[] = [];
  let current = "";
  for (let i = 0; i < body.length; i += 1) {
    const char = body[i];
    if (char === "\\" && body[i + 1] === "|") {
      current += "|";
      i += 1;
    } else if (char === "|") {
      cells.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  cells.push(current);
  return cells.map((cell) => cell.trim().replaceAll("&#124;", "|"));
}

function isSeparatorRow(cells: string[]): boolean {
  return cells.length > 0 && cells.every((cell) => /^:?-{1,}:?$/.test(cell));
}

function normalizeHeader(cell: string): string {
  return cell.toLowerCase().replace(/[`*_]/g, "").trim();
}

function isHeaderRow(cells: string[]): boolean {
  return cells.length === HEADER_TOKENS.length && cells.every((cell, index) => normalizeHeader(cell) === HEADER_TOKENS[index]);
}

export function parseDependencyNotices(notices: string): DependencyNoticeRow[] {
  const source = typeof notices === "string" ? notices : "";
  const rows: DependencyNoticeRow[] = [];
  let inTable = false;
  let skipSection = false;
  for (const line of source.split(/\r\n|\r|\n/)) {
    const trimmed = line.trim();
    if (/^#{1,6}\s/.test(trimmed)) {
      inTable = false;
      skipSection = ALTERNATIVES_HEADING.test(trimmed);
      continue;
    }
    if (skipSection) continue;
    if (!trimmed.includes("|")) {
      inTable = false;
      continue;
    }
    const cells = splitRow(trimmed);
    if (isSeparatorRow(cells)) continue;
    if (!inTable) {
      inTable = isHeaderRow(cells);
      continue;
    }
    if (cells.length !== HEADER_TOKENS.length) {
      inTable = false;
      continue;
    }
    const [name, license, publisher, repository] = cells;
    if (!name && !license && !publisher && !repository) continue;
    rows.push({ name, license, publisher, repository });
  }
  return rows;
}

function renderDependencyTable(rows: DependencyNoticeRow[], copy: Copy): string {
  const head = [copy.package, copy.license, copy.publisher, copy.repository]
    .map((label) => `<th>${escapeHtml(label)}</th>`)
    .join("");
  const body = rows
    .map(
      (row) =>
        `<tr class="dep-row" data-search="${escapeHtml(`${row.name} ${row.license}`.toLowerCase())}">` +
        [row.name, row.license, row.publisher, row.repository]
          .map((cell) => `<td>${escapeHtml(cell) || "&mdash;"}</td>`)
          .join("") +
        "</tr>",
    )
    .join("");
  return `<table class="licenses"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

function renderModelCard(model: ModelLicenseEntry, copy: Copy): string {
  const id = text(model.id);
  const revision = text(model.revision);
  const status = model.installed === true ? copy.installed : copy.available;
  const statusClass = model.installed === true ? "status installed" : "status available";
  const fields: string[] = [];
  const push = (label: string, value: string): void => {
    if (!value) return;
    fields.push(`<div class="field"><span class="label">${escapeHtml(label)}</span><span class="value">${escapeHtml(value)}</span></div>`);
  };
  push(copy.revision, revision);
  push(copy.license, text(model.license));
  push(copy.source, text(model.source));
  const legal: string[] = [];
  const licenseText = text(model.licenseText);
  const notice = text(model.notice);
  if (licenseText) {
    legal.push(`<details><summary>${escapeHtml(copy.licenseText)}</summary><pre>${escapeHtml(licenseText)}</pre></details>`);
  }
  if (notice) {
    legal.push(`<details><summary>${escapeHtml(copy.notice)}</summary><pre>${escapeHtml(notice)}</pre></details>`);
  }
  if (legal.length === 0) {
    legal.push(`<p class="muted">${escapeHtml(copy.noLegalText)}</p>`);
  }
  return (
    `<article class="model" data-search="${escapeHtml(`${id} ${revision} ${text(model.license)}`.toLowerCase())}">` +
    `<header><h3>${escapeHtml(id) || "&mdash;"}</h3><span class="${statusClass}">${escapeHtml(status)}</span></header>` +
    `<div class="fields">${fields.join("")}</div>${legal.join("")}</article>`
  );
}

export function renderLicenseContent(input: LicenseContentInput): string {
  const notices = typeof input?.notices === "string" ? input.notices : "";
  const language = input?.language === "ja" ? "ja" : "en";
  const copy = COPY[language];
  // A nonce with anything outside the safe charset is dropped: an invalid
  // nonce fails closed (the script is blocked) instead of being mangled.
  const rawNonce = text(input?.nonce);
  const nonce = /^[A-Za-z0-9+/=._-]+$/.test(rawNonce) ? rawNonce : "";
  const models = Array.isArray(input?.models) ? input.models : [];
  const rows = parseDependencyNotices(notices);
  const csp = `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'`;

  const dependencySection =
    `<h2>${escapeHtml(copy.dependencies)}</h2>` +
    `<input id="search" type="search" class="search" placeholder="${escapeHtml(copy.search)}" aria-label="${escapeHtml(copy.search)}">` +
    (rows.length > 0
      ? renderDependencyTable(rows, copy)
      : `<p class="muted">${escapeHtml(notices.trim() ? copy.noticesFallback : copy.noRows)}</p>`) +
    `<p class="muted no-matches" hidden>${escapeHtml(copy.noMatches)}</p>`;

  const modelSection =
    `<h2>${escapeHtml(copy.models)}</h2>` +
    (models.length > 0
      ? `<div class="models">${models.map((model) => renderModelCard(model ?? {}, copy)).join("")}</div>`
      : `<p class="muted">${escapeHtml(copy.noModels)}</p>`);

  const noticesSection =
    `<h2>${escapeHtml(copy.fullNotices)}</h2>` +
    `<details><summary>${escapeHtml(copy.fullText)}</summary><pre class="notices">${escapeHtml(notices)}</pre></details>`;

  const script =
    `var box=document.getElementById("search");` +
    `var rows=document.querySelectorAll(".dep-row");` +
    `var empty=document.querySelector(".no-matches");` +
    `function apply(){var q=(box.value||"").trim().toLowerCase();var shown=0;` +
    `rows.forEach(function(row){var hit=!q||row.getAttribute("data-search").indexOf(q)>-1;` +
    `row.hidden=!hit;if(hit){shown+=1;}});empty.hidden=shown!==0;}` +
    `box.addEventListener("input",apply);`;

  return `<!DOCTYPE html>
<html lang="${language}">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(copy.title)}</title>
<style>
  body { margin: 0; padding: 16px; font: var(--vscode-font-size)/1.5 var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); }
  h1 { font-size: 20px; margin: 0 0 4px; }
  h2 { font-size: 13px; letter-spacing: .06em; text-transform: uppercase; margin: 22px 0 8px; color: var(--vscode-textLink-foreground); }
  h3 { font-size: 14px; margin: 0; overflow-wrap: anywhere; }
  .muted { color: var(--vscode-descriptionForeground); font-size: 12px; }
  .search { width: 100%; box-sizing: border-box; padding: 7px 8px; border: 1px solid var(--vscode-input-border, transparent); background: var(--vscode-input-background); color: var(--vscode-input-foreground); border-radius: 3px; }
  .search:focus { outline: 1px solid var(--vscode-focusBorder); }
  table.licenses { width: 100%; border-collapse: collapse; table-layout: fixed; }
  .licenses th, .licenses td { border-bottom: 1px solid var(--vscode-panel-border, var(--vscode-widget-border, transparent)); padding: 6px 8px; text-align: left; vertical-align: top; overflow-wrap: anywhere; }
  .licenses th { color: var(--vscode-descriptionForeground); font-weight: 600; font-size: 12px; }
  .licenses tr[hidden] { display: none; }
  .models { display: grid; gap: 10px; }
  .model { border: 1px solid var(--vscode-panel-border, var(--vscode-widget-border, transparent)); border-radius: 4px; padding: 10px; }
  .model header { display: flex; justify-content: space-between; gap: 8px; align-items: baseline; }
  .status { font-size: 11px; padding: 2px 6px; border-radius: 999px; border: 1px solid var(--vscode-badge-border, transparent); background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); white-space: nowrap; }
  .fields { display: grid; gap: 4px; margin: 8px 0; }
  .field { display: grid; grid-template-columns: 110px 1fr; gap: 8px; font-size: 12px; }
  .label { color: var(--vscode-descriptionForeground); }
  .value { overflow-wrap: anywhere; }
  details { margin: 6px 0; }
  summary { cursor: pointer; color: var(--vscode-textLink-foreground); font-size: 12px; }
  pre { white-space: pre-wrap; overflow-wrap: anywhere; background: var(--vscode-textBlockQuote-background); padding: 8px; margin: 6px 0 0; font-family: var(--vscode-editor-font-family, monospace); font-size: var(--vscode-editor-font-size, 12px); }
  pre.notices { max-height: 60vh; overflow: auto; }
  @media (max-width: 600px) { .field { grid-template-columns: 1fr; } .licenses th, .licenses td { padding: 5px 6px; } }
</style>
</head>
<body>
<h1>${escapeHtml(copy.title)}</h1>
<p class="muted">${escapeHtml(copy.intro)}</p>
${dependencySection}
${modelSection}
${noticesSection}
<script nonce="${nonce}">${script}</script>
</body>
</html>`;
}
