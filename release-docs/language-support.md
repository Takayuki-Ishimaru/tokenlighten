# Language and file support

## Target programming languages

TokenLighten currently targets:

`ts`, `js`, `py`, `go`, `java`, `rs`, `c`, `cpp`, `kt`, `cs`, `php`, and `rb`.

For these languages, TokenLighten provides repository skeletons, symbol and documentation maps, and lexical reference search. It also recognizes common web-framework routes in supported Java, Python, TypeScript/JavaScript, Go, Kotlin, C#, PHP, and Ruby patterns.

Rename and edit operations are deliberately conservative. They are lexical rather than type-aware: string literals are skipped, comments are skipped unless explicitly included, and ambiguous cases can be refused.

## Text and CSS

Common text and configuration files can be discovered and read as text. CSS receives outline-level support only; it is not a full target language. SCSS and Less are treated as text.

## Document and archive formats

| Format | Support |
|---|---|
| DOCX, XLSX, PPTX | Read structured content; supported structured edits require write permission. |
| PDF | Read text-layer content. Scanned or image-only PDFs are not supported. |
| ZIP | Inspect text members; supported ZIP changes require write permission. |
| TAR, TAR.GZ/TGZ, 7Z, RAR | Read-only inspection. |
| Legacy Office formats (`.doc`, `.xls`, `.ppt`) and OpenDocument formats | Not supported. |

Password-protected supported documents and archives use an environment-backed credential reference. Do not put raw passwords in tool arguments.

## Non-goals

TokenLighten does not include a language server. It does not guarantee cross-file semantic resolution, type-aware overload handling, import-aware rename, or runtime routing. When a result is uncertain, the tools should return a compact candidate list or refuse an unsafe operation.
