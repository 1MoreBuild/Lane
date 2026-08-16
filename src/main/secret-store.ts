import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface SecretBackend {
  isAvailable(): boolean;
  encrypt(plaintext: string): Buffer;
  decrypt(ciphertext: Buffer): string;
}

export class InvalidSecretCiphertextError extends Error {
  constructor() {
    super("Invalid secret ciphertext");
    this.name = "InvalidSecretCiphertextError";
  }
}

type StoredSecrets = Record<string, string>;

export interface SecretSnapshot {
  readonly encodedValue?: string;
}

export class SecretStore {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly backend: SecretBackend,
  ) {}

  private assertAvailable(): void {
    if (!this.backend.isAvailable()) {
      throw new Error("OS secure storage is unavailable; Lane will not store credentials");
    }
  }

  private async loadRaw(): Promise<StoredSecrets> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.filePath, "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("Invalid secure storage file");
      }
      for (const value of Object.values(parsed)) {
        if (typeof value !== "string") throw new Error("Invalid secure storage entry");
      }
      return parsed as StoredSecrets;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw error;
    }
  }

  private async saveRaw(values: StoredSecrets): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.filePath}.tmp`;
    await writeFile(temporary, `${JSON.stringify(values, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporary, this.filePath);
  }

  async get(key: string): Promise<string | undefined> {
    this.assertAvailable();
    const encoded = (await this.loadRaw())[key];
    if (!encoded) return undefined;
    return this.backend.decrypt(Buffer.from(encoded, "base64"));
  }

  async listKeys(prefix = ""): Promise<string[]> {
    this.assertAvailable();
    return Object.keys(await this.loadRaw())
      .filter((key) => key.startsWith(prefix))
      .sort();
  }

  async snapshot(key: string): Promise<SecretSnapshot> {
    this.assertAvailable();
    const values = await this.loadRaw();
    return Object.hasOwn(values, key)
      ? { encodedValue: values[key]! }
      : {};
  }

  async restore(key: string, snapshot: SecretSnapshot): Promise<void> {
    this.assertAvailable();
    this.chain = this.chain.catch(() => undefined).then(async () => {
      const values = await this.loadRaw();
      if (snapshot.encodedValue === undefined) {
        delete values[key];
      } else {
        values[key] = snapshot.encodedValue;
      }
      await this.saveRaw(values);
    });
    await this.chain;
  }

  async set(key: string, value: string): Promise<void> {
    this.assertAvailable();
    this.chain = this.chain.catch(() => undefined).then(async () => {
      const values = await this.loadRaw();
      values[key] = this.backend.encrypt(value).toString("base64");
      await this.saveRaw(values);
    });
    await this.chain;
  }

  async delete(key: string): Promise<void> {
    this.assertAvailable();
    this.chain = this.chain.catch(() => undefined).then(async () => {
      const values = await this.loadRaw();
      delete values[key];
      await this.saveRaw(values);
    });
    await this.chain;
  }
}
