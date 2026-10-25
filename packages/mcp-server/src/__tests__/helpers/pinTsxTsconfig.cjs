// pinTsxTsconfig.cjs — the first preload of every dev server a spec spawns
// (helpers/tsxNode.ts TSX_NODE_ARGS). It points tsx at devServer.tsconfig.json
// before tsx's loader registers, so the server compiles and resolves its source
// the same way whatever directory it starts in. tsxNode.ts has the reasoning.
"use strict";

process.env.TSX_TSCONFIG_PATH = require("node:path").join(__dirname, "devServer.tsconfig.json");
