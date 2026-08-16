export type OfficeDecryptionFailureCode =
  | "office-password-required"
  | "office-password-invalid"
  | "office-encryption-unsupported"
  | "office-decrypted-too-large";

export type OfficeDocumentPreparation =
  | { ok: true; bytes: Uint8Array; encrypted: boolean }
  | {
      ok: false;
      code: OfficeDecryptionFailureCode;
      error: string;
      hint?: string;
    };

export type OfficeDocumentProtection =
  | { ok: true; bytes: Uint8Array }
  | {
      ok: false;
      code: "office-encryption-unsupported" | "office-encrypted-too-large";
      error: string;
    };

type OfficeCryptoModule = {
  isEncrypted(input: Buffer): boolean;
  decrypt(
    input: Buffer,
    options: { password: string },
  ): Promise<Buffer | Uint8Array> | Buffer | Uint8Array;
  encrypt(
    input: Buffer,
    options: { password: string },
  ): Promise<Buffer | Uint8Array> | Buffer | Uint8Array;
};

const CFB_MAGIC = Uint8Array.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const MAX_DECRYPTED_OFFICE_BYTES = 25 * 1024 * 1024;
let officeCryptoCache: OfficeCryptoModule | undefined;

function startsWith(bytes: Uint8Array, prefix: Uint8Array): boolean {
  return bytes.length >= prefix.length && prefix.every((byte, index) => bytes[index] === byte);
}

async function getOfficeCrypto(): Promise<OfficeCryptoModule> {
  if (officeCryptoCache) return officeCryptoCache;
  const imported = await import("officecrypto-tool");
  const candidate = imported as unknown as OfficeCryptoModule & { default?: OfficeCryptoModule };
  officeCryptoCache = candidate.default ?? candidate;
  return officeCryptoCache;
}

/**
 * Decrypt an ECMA-376 Office package in memory. Plain ZIP-based OOXML is
 * returned unchanged, keeping the normal extraction path dependency-free.
 */
export async function prepareOfficeDocument(
  bytes: Uint8Array,
  password?: string,
): Promise<OfficeDocumentPreparation> {
  if (!startsWith(bytes, CFB_MAGIC)) {
    return { ok: true, bytes, encrypted: false };
  }

  let officeCrypto: OfficeCryptoModule;
  try {
    officeCrypto = await getOfficeCrypto();
  } catch {
    return {
      ok: false,
      code: "office-encryption-unsupported",
      error: "Office decryption support is unavailable.",
    };
  }

  const input = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let encrypted = false;
  try {
    encrypted = officeCrypto.isEncrypted(input);
  } catch {
    // A CFB container under a modern OOXML extension is not a readable plain
    // OOXML ZIP. Treat an unrecognized encryption container honestly.
  }
  if (!encrypted) {
    return {
      ok: false,
      code: "office-encryption-unsupported",
      error: "The Office encryption container is not supported.",
    };
  }
  if (password === undefined) {
    return {
      ok: false,
      code: "office-password-required",
      error: "The Office document is password-protected.",
      hint: "Pass credentialRef after configuring its TOKENLIGHTEN_PASSWORD_* environment variable.",
    };
  }

  try {
    const decrypted = new Uint8Array(await officeCrypto.decrypt(input, { password }));
    if (decrypted.byteLength > MAX_DECRYPTED_OFFICE_BYTES) {
      return {
        ok: false,
        code: "office-decrypted-too-large",
        error: `Decrypted Office package exceeds ${MAX_DECRYPTED_OFFICE_BYTES} bytes.`,
      };
    }
    if (
      decrypted.length < 4
      || decrypted[0] !== 0x50
      || decrypted[1] !== 0x4b
    ) {
      return {
        ok: false,
        code: "office-password-invalid",
        error: "The resolved credential did not decrypt the Office document.",
      };
    }
    return { ok: true, bytes: decrypted, encrypted: true };
  } catch {
    return {
      ok: false,
      code: "office-password-invalid",
      error: "The resolved credential did not decrypt the Office document.",
    };
  }
}

export async function protectOfficeDocument(
  bytes: Uint8Array,
  password: string,
): Promise<OfficeDocumentProtection> {
  if (bytes.byteLength > MAX_DECRYPTED_OFFICE_BYTES) {
    return {
      ok: false,
      code: "office-encrypted-too-large",
      error: `Office package exceeds ${MAX_DECRYPTED_OFFICE_BYTES} bytes before encryption.`,
    };
  }
  try {
    const officeCrypto = await getOfficeCrypto();
    const input = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const encrypted = new Uint8Array(await officeCrypto.encrypt(input, { password }));
    if (encrypted.byteLength > MAX_DECRYPTED_OFFICE_BYTES * 2) {
      return {
        ok: false,
        code: "office-encrypted-too-large",
        error: "Encrypted Office package exceeds the output size limit.",
      };
    }
    return { ok: true, bytes: encrypted };
  } catch {
    return {
      ok: false,
      code: "office-encryption-unsupported",
      error: "Office encryption failed.",
    };
  }
}
