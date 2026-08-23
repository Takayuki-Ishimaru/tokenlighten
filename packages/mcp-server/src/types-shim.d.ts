// Stub type declarations for packages that will be installed at build time.
// These are listed as dependencies in package.json but not yet npm-installed.
// Remove this file once the packages are installed and their types are available.

declare module "mammoth" {
  const mammoth: {
    convertToMarkdown?: (input: { buffer: Buffer }) => Promise<{
      value: string;
      messages: Array<{ type: string; message: string }>;
    }>;
    convertToHtml: (input: { buffer: Buffer }) => Promise<{
      value: string;
      messages: Array<{ type: string; message: string }>;
    }>;
  };
  export = mammoth;
}

declare module "pptx2json" {
  class Pptx2Json {
    buffer2json(buf: Buffer): Promise<Record<string, unknown>>;
  }
  export = Pptx2Json;
}

declare module "exceljs" {
  interface Cell {
    value: unknown;
    text?: string;
  }
  interface Row {
    values: unknown[];
  }
  interface Worksheet {
    name: string;
    state: string;
    rowCount: number;
    columnCount: number;
    getRow(r: number): Row;
  }
  class Workbook {
    xlsx: { load(buffer: Buffer): Promise<void> };
    worksheets: Worksheet[];
  }
  export { Workbook, Worksheet, Row, Cell };
}

declare module "jszip" {
  interface JSZipEntry {
    dir: boolean;
    _data?: { compressedSize: number; uncompressedSize: number };
    async(type: "string"): Promise<string>;
  }
  interface JSZipInstance {
    files: Record<string, JSZipEntry>;
  }
  interface JSZipStatic {
    loadAsync(data: Uint8Array | Buffer | ArrayBuffer): Promise<JSZipInstance>;
  }
  const jszip: JSZipStatic & (new () => JSZipInstance);
  export = jszip;
}

declare module "libarchive.js/dist/libarchive-node.mjs" {
  interface ArchiveReader {
    getFilesArray(): Promise<Array<{
      path: string;
      file: {
        name: string;
        size: number;
        lastModified: number;
        extract(): Promise<File>;
      };
    }>>;
    hasEncryptedData(): Promise<boolean | null>;
    close(): Promise<void>;
  }

  export const ArchiveFormat: {
    SEVEN_ZIP: "7zip";
    USTAR: "ustar";
    ZIP: "zip";
  };
  export const ArchiveCompression: {
    GZIP: "gzip";
    NONE: "none";
  };
  export const Archive: {
    open(file: Blob): Promise<ArchiveReader>;
    write(options: {
      files: Array<{ file: Blob; pathname: string }>;
      outputFileName: string;
      compression: string;
      format: string;
      passphrase: string | null;
    }): Promise<Blob>;
  };
}

declare module "web-tree-sitter" {
  interface Parser {
    setLanguage(lang: unknown): void;
    parse(text: string): { rootNode: unknown; delete?(): void };
    delete?(): void;
  }
  interface Language {
    load(wasmPath: string): Promise<unknown>;
  }
  interface ParserConstructor {
    new (): Parser;
    init(opts?: { locateFile?: (name: string) => string }): Promise<void>;
    Language: { load(wasmPath: string): Promise<unknown> };
  }
  const Parser: ParserConstructor;
  export default Parser;
}

declare module "@modelcontextprotocol/sdk/server/index.js" {
  export class Server {
    constructor(info: { name: string; version: string }, opts: { capabilities: Record<string, unknown>; instructions?: string });
    setRequestHandler(matcher: { method: string }, handler: (req: unknown) => Promise<unknown>): void;
    connect(transport: unknown): Promise<void>;
  }
}

declare module "@modelcontextprotocol/sdk/server/stdio.js" {
  export class StdioServerTransport {}
}
