// firstPackPrecisionCorpus.ts — corpus generators + metric helpers shared by
// firstPackPrecisionEval.spec.ts (Agent B, Phase 3, 2026-09-19). Extracted
// so another spec can reuse the same corpora/metrics without re-copying
// them. Pure filesystem-writing + metric-computation code only — no vitest
// imports, no assertions, so it can be imported from any spec.

import * as fs from "node:fs";
import * as path from "node:path";

import type { TaskPackResult, TaskPackSurface } from "../../features/task-pack/model.js";

// ---------------------------------------------------------------------------
// Synthetic corpus ("OrderFlow"): TypeScript + Python across 8+ modules. A
// minority of files carry Japanese comments with katakana loanwords next to
// the English identifier they name, controlled by `japaneseComments`.
//
// PHASE 3 ADDITION: three "Observation-1-shape" feature areas
// (priority/channel/tag) — each a plain string-literal union declared ONCE,
// MULTI-LINE (one member per line, so no declaration keyword and no member
// ever shares a line with `type X =`), then referenced only as bare
// equality comparisons scattered across several OTHER files. No member ever
// gets its own unique per-member declaration anywhere — exactly the real
// Observation-1 failure shape (a literal used pervasively as a string VALUE,
// never uniquely owned by one declaration site), unlike E3's backticked
// enum (which is codeShaped and individually recoverable via the
// pre-existing per-identifier path).
// ---------------------------------------------------------------------------

export function writeFile(root: string, rel: string, content: string): void {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, "utf8");
}

export interface SyntheticCorpusOptions {
  japaneseComments?: boolean;
}

export function writeSyntheticCorpus(root: string, options: SyntheticCorpusOptions = {}): void {
  const jp = options.japaneseComments ?? true;
  /** A Japanese comment line, included only when this corpus variant wants Japanese comments at all. */
  const jline = (line: string): string[] => (jp ? [line] : []);

  writeFile(
    root,
    "src/auth/loginService.ts",
    [
      'import { issueSessionToken } from "./sessionToken.js";',
      "",
      "export interface LoginResult {",
      "  userId: string;",
      "  token: string;",
      "}",
      "",
      "/** Verifies credentials against the user store and issues a session token. */",
      "export async function authenticateUser(email: string, password: string): Promise<LoginResult> {",
      "  const userId = await verifyCredentials(email, password);",
      "  const token = issueSessionToken(userId);",
      "  return { userId, token };",
      "}",
      "",
      "async function verifyCredentials(email: string, _password: string): Promise<string> {",
      '  if (!email.includes("@")) throw new Error("invalid_input");',
      "  return `user-${email}`;",
      "}",
      "",
    ].join("\n"),
  );
  writeFile(
    root,
    "src/auth/sessionToken.ts",
    [
      "export const SESSION_TTL_SECONDS = 3600;",
      "",
      "/** Issues a signed session token for the given user id. */",
      "export function issueSessionToken(userId: string): string {",
      "  const expiry = Date.now() + SESSION_TTL_SECONDS * 1000;",
      "  return `${userId}.${expiry}`;",
      "}",
      "",
      "export function isSessionExpired(token: string): boolean {",
      '  const [, expiry] = token.split(".");',
      "  return Date.now() > Number(expiry);",
      "}",
      "",
    ].join("\n"),
  );
  writeFile(
    root,
    "src/auth/passwordReset.ts",
    [
      "const RESET_TOKEN_TTL_MINUTES = 30;",
      "",
      "export function requestPasswordReset(email: string): string {",
      "  return `reset-${email}-${Date.now()}-${RESET_TOKEN_TTL_MINUTES}`;",
      "}",
      "",
      "export function resetPasswordWithToken(token: string, newPassword: string): boolean {",
      "  if (newPassword.length < 8) return false;",
      '  return token.startsWith("reset-");',
      "}",
      "",
    ].join("\n"),
  );
  writeFile(
    root,
    "src/auth/authMiddleware.ts",
    [
      'import { isSessionExpired } from "./sessionToken.js";',
      "",
      "export function requireAuth(token: string | undefined): boolean {",
      "  if (!token) return false;",
      "  return !isSessionExpired(token);",
      "}",
      "",
    ].join("\n"),
  );
  writeFile(
    root,
    "src/payment/paymentGateway.ts",
    [
      "export interface PaymentResult {",
      "  success: boolean;",
      "  transactionId: string;",
      "}",
      "",
      "export async function chargeCard(cardToken: string, amountCents: number): Promise<PaymentResult> {",
      '  if (amountCents <= 0) throw new Error("invalid_input");',
      "  return { success: true, transactionId: `txn-${cardToken}-${amountCents}` };",
      "}",
      "",
    ].join("\n"),
  );
  writeFile(
    root,
    "src/payment/couponEngine.ts",
    [
      "// クーポンコードを検証し、割引額を計算する (validate coupon code, compute discount amount)",
      "export const MAX_COUPON_DISCOUNT_PERCENT = 50;",
      "",
      'const VALID_COUPON_PREFIXES = ["SAVE", "WELCOME", "SEASONAL"];',
      "",
      "/** Validates a coupon code shape and expiry; returns false for a malformed code. */",
      "export function validateCouponCode(code: string): boolean {",
      "  return VALID_COUPON_PREFIXES.some((prefix) => code.startsWith(prefix));",
      "}",
      "",
      "/** Applies a coupon's percentage discount to a price, capped at MAX_COUPON_DISCOUNT_PERCENT. */",
      "export function applyDiscount(priceCents: number, discountPercent: number): number {",
      "  const cappedPercent = Math.min(discountPercent, MAX_COUPON_DISCOUNT_PERCENT);",
      "  return Math.round(priceCents * (1 - cappedPercent / 100));",
      "}",
      "",
    ]
      .filter((line) => jp || !line.startsWith("// クーポン"))
      .join("\n"),
  );
  writeFile(
    root,
    "src/payment/refundHandler.ts",
    [
      ...jline("// 返金処理: refundはキャンセル後に呼び出される (refund is invoked after a cancellation)"),
      "export interface RefundResult {",
      "  refundId: string;",
      "  amountCents: number;",
      "}",
      "",
      "export function issueRefund(transactionId: string, amountCents: number): RefundResult {",
      "  return { refundId: `rf-${transactionId}`, amountCents };",
      "}",
      "",
    ].join("\n"),
  );
  writeFile(
    root,
    "src/payment/invoiceBuilder.ts",
    [
      'import type { OrderTag } from "../common/tag.js";',
      "",
      "export function buildInvoice(orderId: string, lineItems: Array<{ name: string; amountCents: number }>): string {",
      "  const total = lineItems.reduce((sum, item) => sum + item.amountCents, 0);",
      "  return `Invoice for ${orderId}: total ${total} cents across ${lineItems.length} items`;",
      "}",
      "",
      "/** Adds a one-line surcharge note when the order carries the fragile handling tag. */",
      "export function applyFragileSurcharge(tag: OrderTag, subtotalCents: number): number {",
      '  if (tag === "fragile") return subtotalCents + 500;',
      "  return subtotalCents;",
      "}",
      "",
    ].join("\n"),
  );
  writeFile(
    root,
    "src/notification/emailNotifier.ts",
    [
      'import type { Channel } from "../common/channel.js";',
      "",
      "export async function sendEmail(to: string, _subject: string, _body: string): Promise<boolean> {",
      '  if (!to.includes("@")) return false;',
      "  return true;",
      "}",
      "",
      "/** Routes to the email transport only when the requested channel is email. */",
      "export function handlesChannel(channel: Channel): boolean {",
      '  return channel === "email";',
      "}",
      "",
    ].join("\n"),
  );
  writeFile(
    root,
    "src/notification/smsNotifier.ts",
    [
      'import type { Channel } from "../common/channel.js";',
      "",
      "export async function sendSms(phoneNumber: string, _body: string): Promise<boolean> {",
      "  return phoneNumber.length >= 10;",
      "}",
      "",
      "export function handlesChannel(channel: Channel): boolean {",
      '  return channel === "sms";',
      "}",
      "",
    ].join("\n"),
  );
  writeFile(
    root,
    "src/notification/notificationQueue.ts",
    [
      ...jline("// 通知キュー: 送信に失敗した通知はリトライキューに入れて再送する (retry queue for failed notifications)"),
      'import type { Channel } from "../common/channel.js";',
      "",
      "export const MAX_RETRY_ATTEMPTS = 5;",
      "",
      "interface QueuedNotification {",
      "  id: string;",
      "  channel: Channel;",
      "  attempts: number;",
      "}",
      "",
      "const retryQueue: QueuedNotification[] = [];",
      "",
      "export function enqueueNotification(id: string, channel: Channel): void {",
      "  retryQueue.push({ id, channel, attempts: 0 });",
      "}",
      "",
      "/** Retries every queued notification up to MAX_RETRY_ATTEMPTS times, skipping the push and webhook channels which never retry. */",
      "export function retryFailedNotifications(): string[] {",
      "  const succeeded: string[] = [];",
      "  for (const item of retryQueue) {",
      '    if (item.channel === "push" || item.channel === "webhook") continue;',
      "    if (item.attempts < MAX_RETRY_ATTEMPTS) {",
      "      item.attempts += 1;",
      "      succeeded.push(item.id);",
      "    }",
      "  }",
      "  return succeeded;",
      "}",
      "",
    ].join("\n"),
  );
  writeFile(
    root,
    "src/order/orderStateMachine.ts",
    [
      ...jline("// 注文のステータス遷移を管理する。"),
      ...jline("// ステータスは pending, shipped, cancelled, delivered, refunded のいずれか。"),
      'import { releaseCouponHold } from "../payment/couponEngineExtra.js";',
      "",
      'export type OrderStatus = "pending" | "shipped" | "cancelled" | "delivered" | "refunded";',
      "",
      "export interface Order {",
      "  id: string;",
      "  status: OrderStatus;",
      "  couponCode?: string;",
      "}",
      "",
      "const LEGAL_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {",
      '  pending: ["shipped", "cancelled"],',
      '  shipped: ["delivered", "cancelled"],',
      '  delivered: ["refunded"],',
      "  cancelled: [],",
      "  refunded: [],",
      "};",
      "",
      "/** Transitions an order to the next status, validating the edge is legal. */",
      "export function transitionTo(order: Order, next: OrderStatus): Order {",
      "  if (!LEGAL_TRANSITIONS[order.status].includes(next)) {",
      "    throw new Error(`illegal transition ${order.status} -> ${next}`);",
      "  }",
      "  return { ...order, status: next };",
      "}",
      "",
      ...jline("/** キャンセル処理: 在庫を戻し、クーポンを解放してから注文をキャンセル状態にする */"),
      "export function cancelOrder(order: Order): Order {",
      "  releaseInventoryHold(order.id);",
      "  if (order.couponCode) releaseCouponHold(order.couponCode);",
      '  return transitionTo(order, "cancelled");',
      "}",
      "",
      "function releaseInventoryHold(_orderId: string): void {",
      "  // returns reserved stock to the pool",
      "}",
      "",
    ].join("\n"),
  );
  writeFile(
    root,
    "src/order/orderValidator.ts",
    [
      'import type { Priority } from "../common/priority.js";',
      "",
      "export function validateOrderPayload(payload: { items: unknown[] }): boolean {",
      "  return Array.isArray(payload.items) && payload.items.length > 0;",
      "}",
      "",
      "/** Orders at urgent or critical priority skip the normal validation queue. */",
      "export function skipsQueue(priority: Priority): boolean {",
      '  return priority === "urgent" || priority === "critical";',
      "}",
      "",
    ].join("\n"),
  );
  writeFile(
    root,
    "src/order/shippingCalculator.ts",
    [
      'import type { OrderTag } from "../common/tag.js";',
      "",
      "export function calculateShippingCost(weightGrams: number, distanceKm: number): number {",
      "  return Math.round(weightGrams * 0.01 + distanceKm * 0.05);",
      "}",
      "",
      "/** Express-tagged orders pay a flat surcharge instead of the distance rate. */",
      "export function appliesExpressSurcharge(tag: OrderTag): boolean {",
      '  return tag === "express";',
      "}",
      "",
    ].join("\n"),
  );
  writeFile(
    root,
    "src/inventory/stock_manager.py",
    [
      '"""Reserves and releases stock levels for orders."""',
      "",
      "_stock_levels: dict[str, int] = {}",
      "",
      "",
      "def reserve_stock(sku: str, quantity: int) -> bool:",
      '    """Reserves `quantity` units of `sku`, returning False if unavailable."""',
      "    available = _stock_levels.get(sku, 0)",
      "    if available < quantity:",
      "        return False",
      "    _stock_levels[sku] = available - quantity",
      "    return True",
      "",
      "",
      "def release_stock(sku: str, quantity: int) -> None:",
      "    _stock_levels[sku] = _stock_levels.get(sku, 0) + quantity",
      "",
    ].join("\n"),
  );
  writeFile(
    root,
    "src/inventory/warehouse_sync.py",
    [
      '"""Synchronizes local stock levels with the warehouse system of record."""',
      "",
      "",
      "def sync_warehouse_levels(warehouse_id: str) -> int:",
      "    # returns the number of SKUs updated",
      "    return 0",
      "",
    ].join("\n"),
  );
  writeFile(
    root,
    "src/inventory/reorder_policy.py",
    [
      "REORDER_THRESHOLD = 10",
      "",
      "",
      "def should_reorder(current_quantity: int) -> bool:",
      "    return current_quantity < REORDER_THRESHOLD",
      "",
    ].join("\n"),
  );
  writeFile(
    root,
    "src/user/user_profile.py",
    [
      "class UserProfile:",
      '    """Holds a user\'s display name, email, and locale preference."""',
      "",
      "    def __init__(self, user_id: str, email: str):",
      "        self.user_id = user_id",
      "        self.email = email",
      '        self.locale = "en-US"',
      "",
      "",
      "def update_profile(profile: UserProfile, **fields) -> UserProfile:",
      "    for key, value in fields.items():",
      "        setattr(profile, key, value)",
      "    return profile",
      "",
    ].join("\n"),
  );
  writeFile(
    root,
    "src/user/preferences.py",
    [
      ...jline("# ユーザー設定: ポイント残高 (loyalty points balance) はここで取得する"),
      "_point_balances: dict[str, int] = {}",
      "",
      "",
      "def get_user_preferences(user_id: str) -> dict:",
      '    return {"user_id": user_id, "point_balance": get_point_balance(user_id)}',
      "",
      "",
      "def get_point_balance(user_id: str) -> int:",
      "    return _point_balances.get(user_id, 0)",
      "",
    ].join("\n"),
  );
  writeFile(
    root,
    "src/user/loyalty_points.py",
    [
      '"""Loyalty point accrual and redemption."""',
      "",
      "POINTS_PER_DOLLAR = 10",
      "",
      "",
      "class LoyaltyAccount:",
      "    def __init__(self, user_id: str):",
      "        self.user_id = user_id",
      "        self.balance = 0",
      "",
      "",
      "def add_points(account: LoyaltyAccount, amount_cents: int) -> int:",
      "    earned = (amount_cents // 100) * POINTS_PER_DOLLAR",
      "    account.balance += earned",
      "    return earned",
      "",
      "",
      "def redeem_points(account: LoyaltyAccount, points: int) -> bool:",
      "    if points > account.balance:",
      "        return False",
      "    account.balance -= points",
      "    return True",
      "",
    ].join("\n"),
  );
  writeFile(
    root,
    "src/analytics/eventTracker.ts",
    [
      "export function trackEvent(name: string, properties: Record<string, unknown>): void {",
      "  // forwards to the analytics sink",
      "  void name;",
      "  void properties;",
      "}",
      "",
    ].join("\n"),
  );
  writeFile(
    root,
    "src/analytics/reportBuilder.ts",
    [
      'import type { Priority } from "../common/priority.js";',
      "",
      "export function buildDailyReport(dateIso: string): { date: string; totalOrders: number } {",
      "  return { date: dateIso, totalOrders: 0 };",
      "}",
      "",
      "/** Critical-priority items get a red banner in the daily report; everything else is plain. */",
      "export function bannerFor(priority: Priority): string {",
      '  if (priority === "critical") return "red";',
      '  if (priority === "normal") return "none";',
      '  return "none";',
      "}",
      "",
    ].join("\n"),
  );
  writeFile(
    root,
    "src/common/logger.ts",
    [
      "export function logInfo(message: string): void {",
      "  console.log(`[info] ${message}`);",
      "}",
      "",
      "export function logError(message: string, err?: unknown): void {",
      "  console.error(`[error] ${message}`, err);",
      "}",
      "",
    ].join("\n"),
  );
  writeFile(
    root,
    "src/common/errorCodes.ts",
    [
      "export const ERROR_CODES = {",
      '  INVALID_INPUT: "invalid_input",',
      '  NOT_FOUND: "not_found",',
      '  UNAUTHORIZED: "unauthorized",',
      '  RATE_LIMITED: "rate_limited",',
      "} as const;",
      "",
      "export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];",
      "",
    ].join("\n"),
  );
  writeFile(
    root,
    "src/common/featureFlags.ts",
    [
      "const enabledFlags = new Set<string>();",
      "",
      "export function isFeatureEnabled(name: string): boolean {",
      "  return enabledFlags.has(name);",
      "}",
      "",
    ].join("\n"),
  );
  // --- Observation-1-shape features (Phase 3): plain string-literal unions,
  // ONE multi-line declaration (no member shares a line with the `type X =`
  // keyword, so no member is ever "definitionShaped"), referenced only as
  // bare comparisons scattered across several other files above.
  writeFile(
    root,
    "src/common/priority.ts",
    [
      "export type Priority =",
      '  | "low"',
      '  | "normal"',
      '  | "urgent"',
      '  | "critical";',
      "",
    ].join("\n"),
  );
  writeFile(
    root,
    "src/common/channel.ts",
    [
      "export type Channel =",
      '  | "email"',
      '  | "sms"',
      '  | "push"',
      '  | "webhook";',
      "",
    ].join("\n"),
  );
  writeFile(
    root,
    "src/common/tag.ts",
    [
      "export type OrderTag =",
      '  | "gift"',
      '  | "fragile"',
      '  | "express"',
      '  | "backorder";',
      "",
    ].join("\n"),
  );
  writeFile(
    root,
    "docs/ARCHITECTURE.md",
    [
      "# OrderFlow architecture",
      "",
      "OrderFlow is split into auth, payment, notification, order, inventory, user,",
      "analytics, and common modules. Orders move through pending, shipped,",
      "delivered, cancelled, and refunded states (see src/order/orderStateMachine.ts).",
      "",
    ].join("\n"),
  );
  writeFile(
    root,
    "docs/CONTRIBUTING.md",
    ["# Contributing", "", "Run tests with the project's test runner before sending a change for review.", ""].join(
      "\n",
    ),
  );
  writeFile(
    root,
    "tests/orderStateMachine.test.ts",
    [
      "// placeholder regression pin for order status transitions",
      'import { transitionTo, cancelOrder } from "../src/order/orderStateMachine.js";',
      "void transitionTo;",
      "void cancelOrder;",
      "",
    ].join("\n"),
  );
  writeFile(
    root,
    "tests/couponEngine.test.ts",
    [
      "// placeholder regression pin for coupon validation",
      'import { validateCouponCode } from "../src/payment/couponEngine.js";',
      "void validateCouponCode;",
      "",
    ].join("\n"),
  );
  writeFile(
    root,
    "src/payment/couponEngineExtra.ts",
    [
      ...jline("// クーポンの保留を解放する (release a held coupon)"),
      "export function releaseCouponHold(_couponCode: string): void {",
      "  // marks a single-use coupon as available again",
      "}",
      "",
    ].join("\n"),
  );
}

export function listFilesRecursive(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(path.relative(root, full));
    }
  };
  walk(root);
  return out;
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

export type QueryClass =
  | "en_single"
  | "en_multi"
  | "ja_single"
  | "ja_multi"
  | "ja_en_ident"
  | "ja_katakana"
  | "ja_single_xling"
  | "ja_multi_xling"
  | "ja_en_ident_xling"
  | "ja_katakana_xling"
  | "obs1_shape"
  | "tl_self"
  | "seeded";

export type CorpusKind = "shopflow" | "synthetic" | "synthetic_no_ja_comments" | "tl_self";

export interface ConcernQrel {
  label: string;
  /** Any ONE of these files carrying a served body counts as a hit for this concern under the LENIENT metric. */
  files: string[];
  /** STRICT metric only: a served body in an expected file must ALSO be >=5 lines OR contain one of these strings (e.g. a function name) to count. Omit to fall back to the >=5-line rule alone. */
  mustContain?: string[];
}

export interface EvalQuery {
  id: string;
  corpus: CorpusKind;
  cls: QueryClass;
  query: string;
  concerns: ConcernQrel[];
  /** "seeded" class only: caller-supplied paths[] this query is issued WITH -- the GitHub Copilot call shape (a guessed file alongside a multi-point question), routing through buildSeededTaskPack instead of buildAnswerTaskPack. */
  seedPaths?: readonly string[];
}

export interface ServedSurfaceRecord {
  path: string;
  range?: string;
  lineCount: number;
}

export interface QueryMetrics {
  queryId: string;
  cls: QueryClass;
  corpus: string;
  variant: string;
  /** Lenient: any served body in an expected file counts. */
  concernsHitLenient: number;
  /** Strict: served body must be >=5 lines OR contain a qrel mustContain string. */
  concernsHitStrict: number;
  concernsTotal: number;
  filesWithBody: number;
  surfacesTotal: number;
  sliverCount: number;
  sliverRate: number | null;
  bytes: number;
  coverage?: string;
  coverageReason?: string;
  missingCount: number;
  missingFull: string[];
  decisionKind: string;
  decisionReason?: string;
  wallClockMs: number;
  servedSurfaces: ServedSurfaceRecord[];
  error?: string;
}

export function hasBody(s: TaskPackSurface): boolean {
  return typeof s.code === "string" && s.code.trim().length > 0;
}

export function bodyLineCount(code: string): number {
  const trimmed = code.replace(/\n+$/, "");
  if (trimmed.length === 0) return 0;
  return trimmed.split(/\r?\n/).length;
}

const STRICT_MIN_BODY_LINES = 5;

function concernHitStrict(concern: ConcernQrel, surfacesWithBody: readonly TaskPackSurface[]): boolean {
  return surfacesWithBody.some((s) => {
    if (!concern.files.includes(s.path)) return false;
    const lines = bodyLineCount(s.code!);
    if (lines >= STRICT_MIN_BODY_LINES) return true;
    if (concern.mustContain && concern.mustContain.some((needle) => s.code!.includes(needle))) return true;
    return false;
  });
}

export function evaluateResult(
  q: EvalQuery,
  variant: string,
  result: TaskPackResult,
  decisionKind: string,
  decisionReason: string | undefined,
  wallClockMs: number,
): QueryMetrics {
  const surfacesWithBody = result.surfaces.filter(hasBody);
  const filesWithBodySet = new Set(surfacesWithBody.map((s) => s.path));
  const sliverCount = surfacesWithBody.filter((s) => bodyLineCount(s.code!) <= 2).length;
  let concernsHitLenient = 0;
  let concernsHitStrict = 0;
  for (const concern of q.concerns) {
    if (surfacesWithBody.some((s) => concern.files.includes(s.path))) concernsHitLenient += 1;
    if (concernHitStrict(concern, surfacesWithBody)) concernsHitStrict += 1;
  }
  return {
    queryId: q.id,
    cls: q.cls,
    corpus: q.corpus,
    variant,
    concernsHitLenient,
    concernsHitStrict,
    concernsTotal: q.concerns.length,
    filesWithBody: filesWithBodySet.size,
    surfacesTotal: result.surfaces.length,
    sliverCount,
    sliverRate: surfacesWithBody.length > 0 ? sliverCount / surfacesWithBody.length : null,
    bytes: Buffer.byteLength(JSON.stringify(result), "utf8"),
    coverage: result.coverage,
    coverageReason: result.coverage_reason,
    missingCount: Array.isArray(result.missing) ? result.missing.length : 0,
    missingFull: Array.isArray(result.missing) ? result.missing : [],
    decisionKind,
    ...(decisionReason ? { decisionReason } : {}),
    wallClockMs,
    servedSurfaces: result.surfaces.map((s) => ({
      path: s.path,
      ...(s.range ? { range: s.range } : {}),
      lineCount: typeof s.code === "string" ? bodyLineCount(s.code) : 0,
    })),
  };
}

export function errorMetrics(q: EvalQuery, variant: string, err: unknown, wallClockMs: number): QueryMetrics {
  const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return {
    queryId: q.id,
    cls: q.cls,
    corpus: q.corpus,
    variant,
    concernsHitLenient: 0,
    concernsHitStrict: 0,
    concernsTotal: q.concerns.length,
    filesWithBody: 0,
    surfacesTotal: 0,
    sliverCount: 0,
    sliverRate: null,
    bytes: 0,
    missingCount: 0,
    missingFull: [],
    decisionKind: "n/a",
    wallClockMs,
    servedSurfaces: [],
    error: message.slice(0, 500),
  };
}
