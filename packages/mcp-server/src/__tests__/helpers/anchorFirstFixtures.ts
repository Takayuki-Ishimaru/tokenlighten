// anchorFirstFixtures.ts — workspaces for anchorFirstRetrieval.spec.ts
// (2026-10-29 first-hop field report: anchors the request names — a dotted
// member such as `res.redirect`, a bracketed literal, a constant — must be
// served with their definition on the first hop).

const RESPONSE_JS_HEAD = [
  "'use strict';",
  "",
  "var encodeUrl = require('encodeurl');",
  "var escapeHtml = require('escape-html');",
  "var http = require('node:http');",
  "",
  "var res = Object.create(http.ServerResponse.prototype);",
  "module.exports = res;",
  "",
  "res.status = function status(code) {",
  "  if (!Number.isInteger(code)) {",
  "    throw new TypeError('Invalid status code: ' + code);",
  "  }",
  "  this.statusCode = code;",
  "  return this;",
  "};",
  "",
  "res.links = function links(links) {",
  "  var link = this.get('Link') || '';",
  "  if (link) link += ', ';",
  "  return this.set('Link', link + Object.keys(links).map(function (rel) {",
  "    return '<' + links[rel] + '>; rel=\"' + rel + '\"';",
  "  }).join(', '));",
  "};",
  "",
  "res.send = function send(body) {",
  "  var chunk = body;",
  "  if (typeof chunk === 'object') return this.json(chunk);",
  "  if (!this.get('Content-Type')) this.type('html');",
  "  this.end(chunk);",
  "  return this;",
  "};",
  "",
  "res.json = function json(obj) {",
  "  var body = JSON.stringify(obj);",
  "  if (!this.get('Content-Type')) this.set('Content-Type', 'application/json');",
  "  return this.send(body);",
  "};",
  "",
].join("\n");

const RESPONSE_JS_REDIRECT = [
  "res.redirect = function redirect(url) {",
  "  var address = url;",
  "  var body;",
  "  var status = 302;",
  "",
  "  if (arguments.length === 2) {",
  "    status = arguments[0];",
  "    address = arguments[1];",
  "  }",
  "",
  "  address = this.location(address).get('Location');",
  "",
  "  this.format({",
  "    text: function () {",
  "      body = statuses.message[status] + '. Redirecting to ' + address;",
  "    },",
  "    html: function () {",
  "      var u = escapeHtml(address);",
  "      body = '<p>' + statuses.message[status] + '. Redirecting to ' + u + '</p>';",
  "    },",
  "    default: function () {",
  "      body = '';",
  "    }",
  "  });",
  "",
  "  this.statusCode = status;",
  "  this.set('Content-Length', Buffer.byteLength(body));",
  "",
  "  if (this.req.method === 'HEAD') {",
  "    this.end();",
  "  } else {",
  "    this.end(body);",
  "  }",
  "};",
  "",
].join("\n");

const RESPONSE_JS_TAIL = [
  "res.location = function location(url) {",
  "  return this.set('Location', encodeUrl(url));",
  "};",
  "",
  "res.cookie = function cookie(name, value, options) {",
  "  var opts = Object.assign({}, options);",
  "  var val = typeof value === 'object' ? 'j:' + JSON.stringify(value) : String(value);",
  "  this.append('Set-Cookie', name + '=' + encodeURIComponent(val));",
  "  return this;",
  "};",
  "",
  "res.format = function (obj) {",
  "  var req = this.req;",
  "  var keys = Object.keys(obj).filter(function (v) { return v !== 'default'; });",
  "  var key = keys.length > 0 ? req.accepts(keys) : false;",
  "  if (key) return obj[key](req, this, function () {});",
  "  return obj.default(req, this);",
  "};",
  "",
].join("\n");

export const EXPRESS_RESPONSE_JS = `${RESPONSE_JS_HEAD}${RESPONSE_JS_REDIRECT}${RESPONSE_JS_TAIL}`;

export const EXPRESS_INDEX_JS = [
  "'use strict';",
  "",
  "var bodyParser = require('body-parser');",
  "var proto = require('./application');",
  "var req = require('./request');",
  "var res = require('./response');",
  "",
  "exports = module.exports = createApplication;",
  "",
  "function createApplication() {",
  "  var app = function (req, res, next) {",
  "    app.handle(req, res, next);",
  "  };",
  "  app.request = Object.create(req, { app: { configurable: true, enumerable: true, writable: true, value: app } });",
  "  app.response = Object.create(res, { app: { configurable: true, enumerable: true, writable: true, value: app } });",
  "  return app;",
  "}",
  "",
  "exports.json = bodyParser.json;",
  "exports.urlencoded = bodyParser.urlencoded;",
  "",
].join("\n");

export const EXPRESS_README = [
  "# Fast web framework",
  "",
  "Fast, unopinionated, minimalist web framework for node.",
  "",
  "```js",
  "const express = require('express')",
  "const app = express()",
  "app.get('/', (req, res) => { res.send('Hello World') })",
  "app.listen(3000)",
  "```",
  "",
].join("\n");

export function expressHistoryMd(): string {
  const lines: string[] = ["Release history", "==============="];
  for (let i = 0; i < 100; i++) {
    lines.push("", `5.0.${i} / 2024-0${(i % 9) + 1}-1${i % 9}`, "  * Fix res.redirect handling of relative urls (#" + (1000 + i) + ")");
    lines.push("  * Improve redirect performance for long urls and redirect loops");
  }
  return `${lines.join("\n")}\n`;
}

export const EXPRESS_FILES: Readonly<Record<string, string>> = {
  "package.json": JSON.stringify({ name: "express-fixture", version: "5.2.1", main: "index.js" }, null, 2),
  "Readme.md": EXPRESS_README,
  "History.md": expressHistoryMd(),
  "index.js": "module.exports = require('./lib/express');\n",
  "lib/express.js": EXPRESS_INDEX_JS,
  "lib/response.js": EXPRESS_RESPONSE_JS,
  "lib/request.js": [
    "'use strict';",
    "var req = Object.create(require('node:http').IncomingMessage.prototype);",
    "module.exports = req;",
    "req.get = function header(name) { return this.headers[name.toLowerCase()]; };",
    "req.accepts = function () { return false; };",
    "",
  ].join("\n"),
};

// ---------------------------------------------------------------------------
// computeTotal / MODEL_PRICES: a name defined in one file and used in another.
// ---------------------------------------------------------------------------

export const ORDER_TS = [
  "export interface LineItem {",
  "  sku: string;",
  "  quantity: number;",
  "  unitPrice: number;",
  "}",
  "",
  "/** Sum of every line, with the bulk discount applied past ten units. */",
  "export function computeTotal(items: LineItem[]): number {",
  "  let total = 0;",
  "  for (const item of items) {",
  "    const line = item.quantity * item.unitPrice;",
  "    total += item.quantity > 10 ? line * 0.9 : line;",
  "  }",
  "  return Math.round(total * 100) / 100;",
  "}",
  "",
  "export function describeOrder(items: LineItem[]): string {",
  "  return `${items.length} lines`;",
  "}",
  "",
].join("\n");

export const CHECKOUT_TS = [
  "import { computeTotal, describeOrder } from \"./order.js\";",
  "import type { LineItem } from \"./order.js\";",
  "",
  "export interface Receipt {",
  "  summary: string;",
  "  total: number;",
  "}",
  "",
  "export function checkout(items: LineItem[]): Receipt {",
  "  const total = computeTotal(items);",
  "  return { summary: describeOrder(items), total };",
  "}",
  "",
].join("\n");

export const COMPUTE_TOTAL_FILES: Readonly<Record<string, string>> = {
  "package.json": JSON.stringify({ name: "shop-fixture", version: "1.0.0", type: "module" }, null, 2),
  "src/order.ts": ORDER_TS,
  "src/checkout.ts": CHECKOUT_TS,
  "README.md": "# Shop\n\nCheckout and order helpers.\n",
};

export const PRICING_TS = [
  "export interface ModelPrice {",
  "  inputPerMillion: number;",
  "  outputPerMillion: number;",
  "}",
  "",
  "export const MODEL_PRICES: Record<string, ModelPrice> = {",
  "  \"alpha-small\": { inputPerMillion: 0.25, outputPerMillion: 1.25 },",
  "  \"alpha-large\": { inputPerMillion: 3, outputPerMillion: 15 },",
  "  \"beta-mini\": { inputPerMillion: 0.1, outputPerMillion: 0.4 },",
  "};",
  "",
  "export const DEFAULT_CURRENCY = \"USD\";",
  "",
].join("\n");

export const COST_TS = [
  "import { MODEL_PRICES, DEFAULT_CURRENCY } from \"./pricing.js\";",
  "",
  "export function estimateCost(model: string, inputTokens: number, outputTokens: number): string {",
  "  const price = MODEL_PRICES[model];",
  "  if (price === undefined) throw new Error(`unknown model ${model}`);",
  "  const cost = (inputTokens * price.inputPerMillion + outputTokens * price.outputPerMillion) / 1_000_000;",
  "  return `${cost.toFixed(4)} ${DEFAULT_CURRENCY}`;",
  "}",
  "",
].join("\n");

export const MODEL_PRICES_FILES: Readonly<Record<string, string>> = {
  "package.json": JSON.stringify({ name: "pricing-fixture", version: "1.0.0", type: "module" }, null, 2),
  "src/pricing.ts": PRICING_TS,
  "src/cost.ts": COST_TS,
  "README.md": "# Pricing\n\nPer-model token prices.\n",
};

// ---------------------------------------------------------------------------
// click-shaped Python: a help literal built from f-string pieces.
// ---------------------------------------------------------------------------

export const CLICK_CORE_PY = [
  "from __future__ import annotations",
  "",
  "import typing as t",
  "",
  "",
  "class Parameter:",
  "    def __init__(self, name: str) -> None:",
  "        self.name = name",
  "",
  "",
  "class Option(Parameter):",
  "    def __init__(self, name: str, count: bool = False, show_default: bool | str | None = None) -> None:",
  "        super().__init__(name)",
  "        self.count = count",
  "        self.show_default = show_default",
  "",
  "    def get_default_string(self) -> str | None:",
  "        if not self.show_default:",
  "            return None",
  "        if self.count:",
  "            return \"(unlimited)\"",
  "        return \"1\"",
  "",
  "    def get_help_extra(self) -> dict[str, t.Any]:",
  "        extra: dict[str, t.Any] = {}",
  "        default_string = self.get_default_string()",
  "        if default_string is not None:",
  "            extra[\"default\"] = default_string",
  "        return extra",
  "",
  "    def get_help_record(self, help_text: str) -> str:",
  "        extra = self.get_help_extra()",
  "        extra_str = \"; \".join(f\"{key}: {value}\" for key, value in extra.items())",
  "        if extra_str:",
  "            return f\"{help_text}  [{extra_str}]\"",
  "        return help_text",
  "",
].join("\n");

export const CLICK_TEST_PY = [
  "import pytest",
  "",
  "from click.core import Option",
  "",
  "",
  "def test_count_option_default_shows_unlimited():",
  "    option = Option(\"verbose\", count=True, show_default=True)",
  "    assert option.get_help_record(\"Verbosity\") == \"Verbosity  [default: (unlimited)]\"",
  "    assert \"[default: (unlimited)]\" in option.get_help_record(\"Verbosity\")",
  "",
  "",
  "def test_plain_option_default():",
  "    option = Option(\"level\", show_default=True)",
  "    assert option.get_help_record(\"Level\") == \"Level  [default: 1]\"",
  "",
].join("\n");

export const CLICK_FILES: Readonly<Record<string, string>> = {
  "pyproject.toml": "[project]\nname = \"click-fixture\"\nversion = \"8.5.0\"\n",
  "README.md": "# Click fixture\n\nCommand line option parsing.\n",
  "CHANGES.md": ["# Changes", "", ...Array.from({ length: 60 }, (_, i) => `- Version 8.${i}: improved help output for options and defaults.`), ""].join("\n"),
  "src/click/__init__.py": "from .core import Option, Parameter\n",
  "src/click/core.py": CLICK_CORE_PY,
  "tests/test_options.py": CLICK_TEST_PY,
};
