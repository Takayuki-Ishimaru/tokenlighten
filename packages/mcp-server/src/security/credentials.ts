export type CredentialFailureCode =
  | "credential-ref-invalid"
  | "credential-not-found"
  | "credential-invalid";

export type CredentialResolution =
  | { ok: true; credentialRef?: string; password?: string }
  | {
      ok: false;
      code: CredentialFailureCode;
      error: string;
      hint?: string;
    };

const CREDENTIAL_REF_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const MAX_PASSWORD_CHARS = 1024;

export function credentialEnvName(credentialRef: string): string {
  return `TOKENLIGHTEN_PASSWORD_${credentialRef.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
}

/**
 * Resolve an opaque credential reference without ever accepting a raw password
 * in an MCP tool argument. Passwords live only in the server process
 * environment and are not cached, logged, or returned.
 */
export function resolveCredentialRef(value: unknown): CredentialResolution {
  if (value === undefined || value === null) return { ok: true };
  if (typeof value !== "string" || !CREDENTIAL_REF_RE.test(value)) {
    return {
      ok: false,
      code: "credential-ref-invalid",
      error: "credentialRef must be a 1-64 character opaque identifier.",
      hint: "Use letters, digits, dot, underscore, or hyphen; do not pass the password itself.",
    };
  }

  const envName = credentialEnvName(value);
  const password = process.env[envName];
  if (password === undefined || password.length === 0) {
    return {
      ok: false,
      code: "credential-not-found",
      error: "The requested credential reference is not configured.",
      hint: `Set ${envName} before starting the TokenLighten MCP server.`,
    };
  }
  if (password.length > MAX_PASSWORD_CHARS) {
    return {
      ok: false,
      code: "credential-invalid",
      error: "The resolved credential exceeds the supported length.",
    };
  }
  return { ok: true, credentialRef: value, password };
}
