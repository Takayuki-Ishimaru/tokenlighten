/** Bind prior-pack residency only after this exact call actually delivered its bytes. */
export interface BindablePackFingerprint {
  handle: string;
  range: string;
  hash: string;
  taskBinding: string | undefined;
}
type Row = Record<string, unknown>;
const record = (value: unknown): Row | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Row : undefined;

export function createPackFingerprintBinding(
  current: (key: string) => readonly BindablePackFingerprint[] | undefined,
  hash: (text: string) => string,
) {
  interface Candidate {entry: BindablePackFingerprint; path: string; handle: string; range: string; hash: string; body: string}
  interface Capability {key: string; owner: object; entries: readonly BindablePackFingerprint[]; candidates: Candidate[]}
  let capabilities = new WeakMap<object, Capability>();
  return {
    reset(): void {capabilities = new WeakMap();},
    capture(source: object, key: string, owner: object, entries: readonly BindablePackFingerprint[], surfaces: readonly unknown[]): void {
      const candidates: Candidate[] = [];
      for (const value of surfaces) {
        const row = record(value);
        if (!row || typeof row.path !== "string" || typeof row.handle !== "string"
          || typeof row.range !== "string" || typeof row.code !== "string") continue;
        const bodyHash = hash(row.code);
        const entry = entries.find(item => item.taskBinding === undefined && item.handle === row.handle
          && item.range === row.range && item.hash === bodyHash);
        if (entry) candidates.push({entry, path: row.path, handle: row.handle, range: row.range, hash: bodyHash, body: row.code});
      }
      capabilities.set(source, {key, owner, entries, candidates});
    },
    stage(source: object, key: string, owner: object, binding: string, taskHandle: string):
      ((text: string, owner: object) => void) | undefined {
      const captured = capabilities.get(source);
      if (!captured || captured.key !== key || captured.owner !== owner || current(key) !== captured.entries
        || captured.candidates.length === 0 || !binding || !taskHandle) return undefined;
      let finalized = false;
      return (text, finalOwner): void => {
        if (finalized) return;
        finalized = true;
        if (finalOwner !== captured.owner || current(captured.key) !== captured.entries) return;
        let payload: Row | undefined;
        try {payload = record(JSON.parse(text));} catch {return;}
        if (payload?.kind !== "read.task_pack" || record(payload.task)?.id !== taskHandle
          || !Array.isArray(payload.evidence)) return;
        const evidence = payload.evidence;
        for (const candidate of captured.candidates) {
          const entry = candidate.entry;
          if (entry.taskBinding !== undefined || entry.handle !== candidate.handle
            || entry.range !== candidate.range || entry.hash !== candidate.hash) continue;
          if (evidence.some(value => {
            const row = record(value);
            return row?.path === candidate.path && row.handle === candidate.handle
              && row.range === candidate.range && row.body === candidate.body;
          })) entry.taskBinding = binding;
        }
      };
    },
  };
}
