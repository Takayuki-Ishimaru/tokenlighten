export const REVIEW_0153_QUERY = "src/bill.ts の bill(5000, true) の戻り値と計算順序を説明してください。";
export function review0153Pricing(rate: number, constantAlias = false, functionAlias = false, barrel = false) {
  return {
    "src/policy.ts": `export const RATE = ${rate};\nexport const FREE = 5000;\nexport const FEE = 500;\n`,
    "src/helpers.ts": constantAlias
      ? 'import { RATE as R, FREE as MINIMUM, FEE as DELIVERY } from "./policy.ts";\nexport function discount(x: number, member: boolean): number { return member ? Math.floor(x * R) : 0; }\nexport function shipping(x: number): number { return x >= MINIMUM ? 0 : DELIVERY; }\n'
      : 'import { RATE, FREE, FEE } from "./policy.ts";\nexport function discount(x: number, member: boolean): number { return member ? Math.floor(x * RATE) : 0; }\nexport function shipping(x: number): number { return x >= FREE ? 0 : FEE; }\n',
    ...(barrel ? { "src/index.ts": functionAlias ? 'export {discount as cut, shipping as delivery} from "./helpers.ts";\n' : 'export {discount, shipping} from "./helpers.ts";\n' } : {}),
    "src/bill.ts": `import { ${functionAlias ? barrel ? "cut, delivery" : "discount as cut, shipping as delivery" : "discount, shipping"} } from "./${barrel ? "index" : "helpers"}.ts";\nexport function bill(x: number, member: boolean): number {\n const discounted = x - ${functionAlias ? "cut" : "discount"}(x, member);\n return discounted + ${functionAlias ? "delivery" : "shipping"}(discounted);\n}\n`,
  };
}

