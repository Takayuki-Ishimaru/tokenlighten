// Canonical dialect rescue at the MCP transport boundary.
//
// Keep this independent of server.ts so transport normalisation is testable and
// cannot become entangled with domain dispatch. The caller supplies the
// advertised schema validation hooks, preserving server.ts as the single
// schema authority.

import type { SchemaNode } from "../../validation/requestShape.js";

export interface CanonicalDialectRescueDependencies {
  readonly objectFields: readonly string[];
  readonly arrayFields: readonly string[];
  readonly advertisedPropertiesFor: (canonical: string) => Record<string, SchemaNode>;
  readonly findUnknownProperties: (
    canonical: string,
    schema: Record<string, SchemaNode>,
    value: Record<string, unknown>,
  ) => readonly { readonly field: string }[];
  readonly asObject: (value: unknown) => Record<string, unknown> | undefined;
  /**
   * Legacy member names, per object field, that the server resolves itself
   * once the value is an object: normalized where a policy accepts them,
   * refused naming them otherwise (`task.taskProfile`). A string whose parsed
   * object's only unknown members are these is still rescued, so it meets the
   * same treatment as a native object rather than failing as "must be an
   * object".
   */
  readonly legacyMembers?: Readonly<Record<string, readonly string[]>>;
}

function jsonParseIfStructureLike(value: unknown): { parsed: unknown } | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed === "" || !(trimmed.startsWith("{") || trimmed.startsWith("["))) return undefined;
  try {
    return { parsed: JSON.parse(trimmed) as unknown };
  } catch {
    return undefined;
  }
}

function matchesTopLevelShape(
  value: unknown,
  expected: "object" | "array",
  asObject: CanonicalDialectRescueDependencies["asObject"],
): boolean {
  return expected === "array" ? Array.isArray(value) : asObject(value) !== undefined;
}

function valuePassesSchema(
  canonical: string,
  field: string,
  value: unknown,
  deps: CanonicalDialectRescueDependencies,
): boolean {
  const schema = deps.advertisedPropertiesFor(canonical)[field];
  const legacy = deps.legacyMembers?.[field] ?? [];
  return schema !== undefined
    && deps.findUnknownProperties(canonical, { [field]: schema }, { [field]: value })
      .every((violation) => legacy.some((name) => violation.field === `${field}.${name}`));
}

/**
 * Rescue only JSON-stringified canonical structures. Invalid values remain
 * untouched so normal request validation owns their refusal; a value whose
 * only unknown members are `legacyMembers` is rescued, because the validation
 * a native object gets owns those (a string would be refused as "must be an
 * object", which names neither the member nor its canonical spelling).
 */
export function rescueStringifiedCanonicalFields(
  canonical: string,
  input: Record<string, unknown>,
  deps: CanonicalDialectRescueDependencies,
): Record<string, unknown> {
  let out: Record<string, unknown> | undefined;
  const target = (): Record<string, unknown> => (out ??= { ...input });

  for (const field of deps.objectFields) {
    const rescued = jsonParseIfStructureLike(input[field]);
    if (
      rescued !== undefined
      && matchesTopLevelShape(rescued.parsed, "object", deps.asObject)
      && valuePassesSchema(canonical, field, rescued.parsed, deps)
    ) {
      target()[field] = rescued.parsed;
    }
  }

  for (const field of deps.arrayFields) {
    let arrayValue = input[field];
    const topLevelRescue = jsonParseIfStructureLike(arrayValue);
    if (
      topLevelRescue !== undefined
      && matchesTopLevelShape(topLevelRescue.parsed, "array", deps.asObject)
      && valuePassesSchema(canonical, field, topLevelRescue.parsed, deps)
    ) {
      arrayValue = topLevelRescue.parsed;
      target()[field] = arrayValue;
    }

    const itemSchema = deps.advertisedPropertiesFor(canonical)[field]?.items;
    if (Array.isArray(arrayValue) && itemSchema?.properties !== undefined && arrayValue.some((item) => typeof item === "string")) {
      const rescuedItems = arrayValue.map((item) => {
        const itemRescue = jsonParseIfStructureLike(item);
        return itemRescue !== undefined && matchesTopLevelShape(itemRescue.parsed, "object", deps.asObject)
          ? itemRescue.parsed
          : item;
      });
      if (
        rescuedItems.some((item, index) => item !== arrayValue[index])
        && valuePassesSchema(canonical, field, rescuedItems, deps)
      ) {
        target()[field] = rescuedItems;
      }
    }
  }

  return out ?? input;
}
