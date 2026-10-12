export const REVIEW_0152_TINY = "export function add(a: number, b: number) { return a + b; }\n";
export const REVIEW_0152_PRICING_QUERY = "src/pricing.ts の total(5000, true) の戻り値と、割引と送料を計算する順序を説明してください。";
export function review0152Pricing(rate: number): string {
  return `export function shipping(subtotal: number): number {\n  if (subtotal >= 5000) return 0;\n  return 500;\n}\n\nexport function discount(subtotal: number, member: boolean): number {\n  return member ? Math.floor(subtotal * ${rate}) : 0;\n}\n\nexport function total(subtotal: number, member: boolean): number {\n  const discounted = subtotal - discount(subtotal, member);\n  return discounted + shipping(discounted);\n}\n`;
}
