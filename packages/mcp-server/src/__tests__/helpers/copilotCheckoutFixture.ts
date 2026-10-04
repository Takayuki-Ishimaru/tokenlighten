// copilotCheckoutFixture.ts — the VS Code Copilot standard-setup evaluation's
// (2026-10-02) own synthetic, public-safe checkout fixture, byte-for-byte (the
// evaluator's evidence/standard-setup/fixture-files.json), and the large
// task's verbatim TokenLighten call. Shared by
// copilotEval1002.gapHonesty.spec.ts and replayCorpus.spec.ts's `cp2`-`cp4` groups.

export const COPILOT_CHECKOUT_FILES: Readonly<Record<string, string>> = {
  "src/checkout/constants.ts": "export const SHIPPING_FREE_AT = 5000;\nexport const STANDARD_SHIPPING = 450;\nexport const EXPRESS_SURCHARGE = 700;\nexport const MEMBER_RATE = 0.10;\nexport const TAX_RATE = 0.08;\nexport const POINT_VALUE = 2;\n",
  "src/checkout/types.ts": "export type Item = { sku: string; quantity: number };\nexport type Input = { items: Item[]; member: boolean; coupon?: string; points: number; delivery: 'standard' | 'express'; region: 'mainland' | 'island' };\n",
  "src/checkout/catalog.ts": "export const catalog: Record<string,{price:number;weight:number;discountable:boolean}> = {\n  notebook: { price:1200, weight:200, discountable:true },\n  mug: { price:1800, weight:500, discountable:true },\n  giftcard: { price:2000, weight:0, discountable:false },\n  kettle: { price:4800, weight:1400, discountable:true }\n};\n",
  "src/checkout/lines.ts": "import { catalog } from './catalog';\nimport type { Item } from './types';\nexport function lines(items: Item[]) { return items.map(item=> {\n const p=catalog[item.sku]; if(!p || !Number.isInteger(item.quantity) || item.quantity<1) throw new Error('invalid item');\n return { amount:p.price*item.quantity, eligible:p.discountable?p.price*item.quantity:0, weight:p.weight*item.quantity };\n}); }\n",
  "src/checkout/membership.ts": "import { MEMBER_RATE } from './constants';\nexport function memberDiscount(eligible:number, member:boolean) { return member ? Math.floor(eligible*MEMBER_RATE) : 0; }\n",
  "src/checkout/coupons.ts": "export function couponDiscount(code:string|undefined, eligibleAfterMember:number) {\n if(code==='SAVE500') return eligibleAfterMember>=3000 ? 500 : 0;\n if(code==='TEN') return Math.min(600,Math.floor(eligibleAfterMember*0.10));\n return 0;\n}\n",
  "src/checkout/points.ts": "import { POINT_VALUE } from './constants';\nexport function pointRedemption(points:number, merchandiseAfterDiscounts:number) {\n const requested=Math.max(0,Math.floor(points))*POINT_VALUE;\n return Math.min(requested,Math.floor(merchandiseAfterDiscounts/4));\n}\n",
  "src/checkout/shipping.ts": "import { SHIPPING_FREE_AT, STANDARD_SHIPPING, EXPRESS_SURCHARGE } from './constants';\nexport function shipping(subtotalAfterDiscounts:number, weight:number, delivery:string, region:string) {\n const base=subtotalAfterDiscounts>=SHIPPING_FREE_AT ? 0 : STANDARD_SHIPPING;\n const heavy=weight>2000 ? 300 : 0;\n const island=region==='island' ? 900 : 0;\n return base+heavy+island+(delivery==='express'?EXPRESS_SURCHARGE:0);\n}\n",
  "src/checkout/tax.ts": "import { TAX_RATE } from './constants';\nexport function tax(merchandiseAfterPoints:number, shippingAmount:number) { return Math.floor((merchandiseAfterPoints+shippingAmount)*TAX_RATE); }\n",
  "src/checkout/quote.ts": "import { lines } from './lines';\nimport { memberDiscount } from './membership';\nimport { couponDiscount } from './coupons';\nimport { pointRedemption } from './points';\nimport { shipping } from './shipping';\nimport { tax } from './tax';\nimport type { Input } from './types';\nexport function quote(input:Input) {\n const rows=lines(input.items);\n const subtotal=rows.reduce((s,r)=>s+r.amount,0);\n const eligible=rows.reduce((s,r)=>s+r.eligible,0);\n const weight=rows.reduce((s,r)=>s+r.weight,0);\n const memberOff=memberDiscount(eligible,input.member);\n const couponOff=couponDiscount(input.coupon,eligible-memberOff);\n const discounted=subtotal-memberOff-couponOff;\n const pointsOff=pointRedemption(input.points,discounted);\n const delivery=shipping(discounted,weight,input.delivery,input.region);\n const taxAmount=tax(discounted-pointsOff,delivery);\n return {subtotal,memberOff,couponOff,pointsOff,shipping:delivery,tax:taxAmount,total:discounted-pointsOff+delivery+taxAmount};\n}\n",
  "src/checkout/display.ts": "export function displayYen(value:number) { return 'JPY '+value.toLocaleString('en-US'); }\n",
  "src/checkout/legacy.ts": "// Historical rule, not used by quote.\nexport const legacyFreeShippingAt=3000;\nexport function legacyTax(v:number) { return Math.round(v*0.10); }\n",
};

/** The large task's only TokenLighten call (GPT-6 Luna), `query` and `targets` verbatim. */
export const COPILOT_EVAL_QUERY =
  "Inspect src/checkout quote() implementation and calculate exact quote results for carts A, B, C. Need discount ordering, gift card discount behavior, points impact on free shipping eligibility, and rounding rules with line citations.";

export const COPILOT_EVAL_TARGET_FILES: readonly string[] = [
  "quote", "types", "catalog", "constants", "membership", "coupons", "points", "shipping", "tax", "lines",
].map((name) => `src/checkout/${name}.ts`);

/**
 * The retest's (2026-10-02, same evaluation) retry files from the evaluator's
 * synthetic workspace, byte-for-byte: retrySchedule() delegates its arithmetic
 * to backoff(), the callee the measured answer pack left out.
 */
export const COPILOT_RETRY_FILES: Readonly<Record<string, string>> = {
  "src/config.ts": "export const RETRY_LIMIT = 3;\nexport const RETRY_BASE_MS = 125;\nexport const RETRY_CAP_MS = 1000;\n",
  "src/backoff.ts": "import { RETRY_BASE_MS, RETRY_CAP_MS } from \"./config\";\nexport function backoff(attempt: number): number {\n  return Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** attempt);\n}\n",
  "src/worker.ts": "import { RETRY_LIMIT } from \"./config\";\nimport { backoff } from \"./backoff\";\nexport function retrySchedule(): number[] {\n  return Array.from({length: RETRY_LIMIT}, (_, i) => backoff(i));\n}\n",
};
