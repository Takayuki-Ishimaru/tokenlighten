// Mini-repo fixture: math utilities
export function add(a: number, b: number): number {
  return a + b;
}

export function subtract(a: number, b: number): number {
  return a - b;
}

export class Calculator {
  private value: number = 0;

  reset(): void {
    this.value = 0;
  }

  accumulate(n: number): number {
    this.value += n;
    return this.value;
  }
}
