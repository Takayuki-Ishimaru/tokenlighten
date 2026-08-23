// ---------------------------------------------------------------------------
// protocol v1 -- the `json` codec: today's wire, unconditionally available.
//
// This is the identity mapping and the universal fallback: every kind, every
// payload, `canEncode` is always true, `encode`/`decode` never throw. It is
// the ONLY codec `pipeline.ts` may choose when `TOKENLIGHTEN_RESPONSE_FORMAT`
// is unset or "json" -- see that module for why that keeps the default path
// byte-identical to pre-V10-11 behaviour.
// ---------------------------------------------------------------------------

import type { Kind } from "@tokenlighten/types";
import type { CodecPayload, ResponseCodec } from "./types.js";

export const jsonCodec: ResponseCodec = {
  id: "json",
  version: "1",
  canEncode(_kind: Kind, _payload: CodecPayload): boolean {
    return true;
  },
  encode(payload: CodecPayload): string {
    return JSON.stringify(payload);
  },
  decode(text: string): CodecPayload {
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("json codec: decoded value is not an object");
    }
    return parsed as CodecPayload;
  },
};
