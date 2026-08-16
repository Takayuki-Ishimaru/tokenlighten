// ---------------------------------------------------------------------------
// v0.7 read_code mode=artifact — structured office document reads
// ---------------------------------------------------------------------------

export interface ReadCodeArtifactInput {
  mode: "artifact";
  path: string;
  /** Opaque password reference resolved by the MCP server; never the password itself. */
  credentialRef?: string;
  kind?: "xlsx" | "docx" | "pptx";
  sheet?: string;
  range?: string;
  rows?: [number, number];
  columns?: string[];
  as?: "json" | "markdown";
  maxRows?: number;
  maxCells?: number;
  query?: string;
  sections?: string[];
}

export interface ReadCodeArtifactXlsxOutput {
  mode: "artifact";
  kind: "xlsx";
  path: string;
  sheet: string;
  range: string;
  handle: string;
  sha: string;
  columns: string[];
  rows: Record<string, unknown>[];
  truncated: boolean;
  warnings: string[];
}

export interface ReadCodeArtifactXlsxRosterOutput {
  mode: "artifact";
  kind: "xlsx";
  path: string;
  view: "roster";
  handle: string;
  sha: string;
  sheets: Array<{
    name: string;
    dimensions: string;
    hidden: boolean;
    rowCount: number;
    colCount: number;
  }>;
  warnings: string[];
}

export interface ReadCodeArtifactDocxOutput {
  mode: "artifact";
  kind: "docx";
  path: string;
  handle: string;
  sha: string;
  sections: Array<{
    heading: string;
    text: string;
  }>;
  truncated: boolean;
  warnings: string[];
}
