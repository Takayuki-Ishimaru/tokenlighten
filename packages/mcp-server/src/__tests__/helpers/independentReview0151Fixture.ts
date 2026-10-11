/**
 * Regression workspaces for Japanese questions, constants and aliases.
 * Synthetic modules exercise ES modules, CommonJS and Python.
 * Extension source snapshots under fixtures-0151-vsix/*.txt exercise class
 * constants, imports and caller questions without being compiled.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const REVIEW_0151_JA_FILES: Readonly<Record<string, string>> = {
  "settings.ts": "export const BASE_TIMEOUT_MS = 7300;\nexport const RETRY_LIMIT = 4;\nexport const RETRY_STATUS_CODES = [408, 429, 503];\n",
  "policy.ts": "export { BASE_TIMEOUT_MS as HTTP_TIMEOUT_MS, RETRY_LIMIT as MAX_RETRIES, RETRY_STATUS_CODES as RETRYABLE_STATUS } from \"./settings\";\n",
  "http.ts": [
    "import { HTTP_TIMEOUT_MS as REQUEST_TIMEOUT, MAX_RETRIES, RETRYABLE_STATUS } from \"./policy\";",
    "",
    "export function retryDelay(attempt: number): number {",
    "  return 100 * (2 ** attempt);",
    "}",
    "",
    "export async function retry(url: string): Promise<Response> {",
    "  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {",
    "    const response = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT) });",
    "    if (!RETRYABLE_STATUS.includes(response.status)) return response;",
    "    await new Promise(resolve => setTimeout(resolve, retryDelay(attempt)));",
    "  }",
    "  throw new Error(\"retry exhausted\");",
    "}",
    "",
    "export async function loadInternalDashboard() {",
    "  return retry(\"/internal/dashboard\");",
    "}",
    "",
  ].join("\n"),
  "app.ts": "import { retry as retryRequest } from \"./http\";\nexport async function loadProfile() {\n  return retryRequest(\"/profile\");\n}\nexport async function loadFeed() {\n  return retryRequest(\"/feed\");\n}\n",
};

export const REVIEW_0151_SYNTHETIC_FILES: Readonly<Record<string, string>> = {
  ...REVIEW_0151_JA_FILES,
  "billing.ts": [
    "export const TAX_RATE = 0.10;",
    "export const DISCOUNT_THRESHOLD = 10000;",
    "export const DISCOUNT_RATE = 0.05;",
    "export function calculateTotal(price: number, count: number): number {",
    "  if (price < 0 || count < 0) throw new Error(\"negative input\");",
    "  const subtotal = price * count;",
    "  const discount = subtotal >= DISCOUNT_THRESHOLD ? DISCOUNT_RATE : 0;",
    "  return Math.floor(subtotal * (1 - discount) * (1 + TAX_RATE));",
    "}",
    "export function refund(amount: number): number {",
    "  if (amount < 0) throw new Error(\"negative refund\");",
    "  return -Math.floor(amount);",
    "}",
    "export function checkout() { return calculateTotal(5000, 3); }",
    "export function cancelOrder() { return refund(2500); }",
    "",
  ].join("\n"),
  "client.ts": "import config from \"./config\";\nexport function clientTimeout() {\n  return config.timeoutMs;\n}\n",
  "config.ts": "const config = { timeoutMs: 8700, maxRetries: 6 };\nexport default config;\n",
  "limits.cjs": "exports.TIMEOUT_MS = 9100;\n",
  "long.ts": [
    "import { RETRY_LIMIT } from './settings';",
    "export function longOperation(input: number) {",
    ...Array.from({ length: 100 }, (_, i) => `  const step${String(i).padStart(3, "0")} = input + ${i};`),
    "  return RETRY_LIMIT + input;",
    "}",
    "",
  ].join("\n"),
  "pyconfig.py": "TIMEOUT_SECONDS = 9\nMAX_ATTEMPTS = 5\n",
  "request.cjs": "const { TIMEOUT_MS: WAIT } = require(\"./limits.cjs\");\nfunction requestTimeout() {\n  return WAIT;\n}\nmodule.exports = { requestTimeout };\n",
  "runtime.ts": "export function runtimeTimeout() {\n  return Number(process.env.API_TIMEOUT_MS ?? \"5000\");\n}\n",
  "worker.py": "from pyconfig import TIMEOUT_SECONDS as WAIT_SECONDS, MAX_ATTEMPTS as LIMIT\n\ndef send_job(job):\n    for attempt in range(LIMIT):\n        job.send(timeout=WAIT_SECONDS)\n    return LIMIT\n",
};

function vendored(name: string): string {
  return fs.readFileSync(path.join(HERE, "fixtures-0151-vsix", `${name}.txt`), "utf8");
}

/** `src/watcher.ts` of the reviewed commit (83 lines; DEBOUNCE_MS / WATCHED_LANGUAGES at 15-19, the class at 23-83). */
export function reviewWatcherFiles(): Record<string, string> {
  return { "src/watcher.ts": vendored("watcher.ts") };
}

/** `src/updateChecker.ts` of the reviewed commit (275 lines; `import * as https from "node:https"`, RESPONSE_LIMIT_BYTES / REQUEST_TIMEOUT_MS at 8-9). */
export function reviewUpdateCheckerFiles(): Record<string, string> {
  return { "src/updateChecker.ts": vendored("updateChecker.ts") };
}
