// Mini-repo fixture: utilities
export function slugify(s: string): string {
  return s.toLowerCase().replace(/\s+/g, "-");
}

export const VERSION = "0.1.0";

export type ID = string;
