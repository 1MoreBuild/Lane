import { safeStorage } from "electron";
import type { SecretBackend } from "./secret-store.ts";

export class ElectronSecretBackend implements SecretBackend {
  isAvailable(): boolean {
    if (!safeStorage.isEncryptionAvailable()) return false;
    if (process.platform === "linux") {
      return safeStorage.getSelectedStorageBackend() !== "basic_text";
    }
    return true;
  }

  encrypt(plaintext: string): Buffer {
    return safeStorage.encryptString(plaintext);
  }

  decrypt(ciphertext: Buffer): string {
    return safeStorage.decryptString(ciphertext);
  }
}
