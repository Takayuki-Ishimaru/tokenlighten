// wiringProfiles — extracted implementation; imports point to the owning modules.


/**
 * Lower-cased naming pieces of a path: every directory segment, the final
 * segment's extension-stripped stem, and each `_`/`-`/`.`-separated piece of
 * both. `firmware/src/telemetry/mavlink_dialect.cpp` yields `firmware`, `src`,
 * `telemetry`, `mavlink_dialect`, `mavlink`, `dialect`.
 */
export function pathFamilyPieces(relPath: string): string[] {
  const out: string[] = [];
  const parts = relPath.split("/");
  for (let index = 0; index < parts.length; index++) {
    const raw = parts[index]!;
    const base = index === parts.length - 1 ? raw.replace(/\.[^.]*$/, "") : raw;
    if (base.length === 0) continue;
    out.push(base.toLowerCase());
    for (const piece of base.split(/[_\-.]+/)) {
      if (piece.length > 0) out.push(piece.toLowerCase());
    }
  }
  return out;
}
