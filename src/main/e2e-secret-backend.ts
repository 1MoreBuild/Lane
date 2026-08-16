import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";
import {
  InvalidSecretCiphertextError,
  type SecretBackend,
} from "./secret-store.ts";

const VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

export class E2ESecretBackend implements SecretBackend {
  private readonly key: Buffer;

  constructor(encodedKey: string) {
    this.key = Buffer.from(encodedKey, "base64url");
    if (this.key.length !== KEY_BYTES) {
      throw new Error("Lane E2E secret key must contain 32 bytes");
    }
  }

  isAvailable(): boolean {
    return true;
  }

  encrypt(plaintext: string): Buffer {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const encrypted = Buffer.concat([
      cipher.update(plaintext, "utf8"),
      cipher.final(),
    ]);
    return Buffer.concat([
      Buffer.from([VERSION]),
      iv,
      cipher.getAuthTag(),
      encrypted,
    ]);
  }

  decrypt(ciphertext: Buffer): string {
    if (
      ciphertext.length < 1 + IV_BYTES + TAG_BYTES ||
      ciphertext[0] !== VERSION
    ) {
      throw new InvalidSecretCiphertextError();
    }
    const ivStart = 1;
    const tagStart = ivStart + IV_BYTES;
    const bodyStart = tagStart + TAG_BYTES;
    const decipher = createDecipheriv(
      "aes-256-gcm",
      this.key,
      ciphertext.subarray(ivStart, tagStart),
    );
    decipher.setAuthTag(ciphertext.subarray(tagStart, bodyStart));
    try {
      return Buffer.concat([
        decipher.update(ciphertext.subarray(bodyStart)),
        decipher.final(),
      ]).toString("utf8");
    } catch {
      throw new InvalidSecretCiphertextError();
    }
  }
}
