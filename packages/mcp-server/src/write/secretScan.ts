/**
 * secretScan.ts — path-based secret file detection for write tools.
 *
 * Ported from proto/src/core/secretScanner.ts looksLikeSecretFile() and
 * extended with additional path patterns for write-gate rejection.
 *
 * Pure logic, no I/O. Returns true when the given relative or absolute path
 * looks like a file that should never be written (or overwritten) by an
 * automated tool.
 *
 * Output policy: plain data — no meta envelope.
 */

/** Extract the basename from any path using both separators. */
function base(p: string): string {
  const normalized = p.replace(/\\/g, "/");
  const idx = normalized.lastIndexOf("/");
  return idx === -1 ? normalized : normalized.slice(idx + 1);
}

/**
 * Patterns that match path SEGMENTS (directory components or the basename).
 * Each pattern is tested against the full posix-normalized path string.
 */
const PATH_PATTERNS: RegExp[] = [
  // .env and .env.* (e.g. .env.local, .env.production) — but NOT *.example
  /(^|\/)\.(env)(\.|$)/,
  // Private key files
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)$/,
  // AWS credentials directory
  /(^|\/)\.aws\//,
  // Kubernetes config directory
  /(^|\/)\.kube\//,
  // SSH directory
  /(^|\/)\.ssh\//,
  // PEM / key / p12 / pfx / keystore suffix
  /\.(pem|key|p12|pfx|keystore)$/i,
  // Google service account JSON (common naming pattern)
  /(^|\/)service[-_]?account.*\.json$/i,
  // Terraform variable files that often contain secrets
  /\.tfvars$/i,
  // Docker config (may contain registry credentials)
  /(^|\/)\.docker\/config\.json$/,
  // netrc (may contain credentials)
  /(^|\/)\.netrc$/,
  // npmrc with auth tokens
  /(^|\/)\.npmrc$/,
  // pypirc
  /(^|\/)\.pypirc$/,
  // Maven settings (may contain credentials)
  /(^|\/)\.m2\/settings\.xml$/,
];

/**
 * Returns true when the path looks like a secret or credential file.
 * The check is performed on the full path (not just basename) so directory
 * patterns like .aws/ and .ssh/ are caught correctly.
 *
 * Explicit example/template files (*.example, *.sample, *.template) are
 * never flagged — they exist precisely to show structure without real values.
 */
export function looksLikeSecretFile(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  const b = base(normalized).toLowerCase();

  if (b.length === 0) return false;

  // Never flag explicit example/template files.
  if (
    b.endsWith(".example") ||
    b.endsWith(".sample") ||
    b.endsWith(".template")
  ) {
    return false;
  }

  // Check every path segment, retaining protection for nested secret dirs
  // without using a wildcard regex.
  const segments = normalized.toLowerCase().split("/");
  if (segments.some((segment) => segment.includes("credentials") || segment.includes("secret"))) return true;

  for (const pattern of PATH_PATTERNS) {
    if (pattern.test(normalized)) return true;
  }

  return false;
}
