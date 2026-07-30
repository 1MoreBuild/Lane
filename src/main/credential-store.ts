import type {
  Credential,
  CredentialInfo,
  CredentialStore,
} from "@earendil-works/pi-ai";
import type { SecretStore } from "./secret-store.ts";

export class SecureCredentialStore implements CredentialStore {
  private readonly chains = new Map<string, Promise<unknown>>();

  constructor(private readonly secrets: SecretStore) {}

  private key(providerId: string): string {
    return `credential:${providerId}`;
  }

  async read(providerId: string): Promise<Credential | undefined> {
    const value = await this.secrets.get(this.key(providerId));
    if (!value) return undefined;
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object") throw new Error("Invalid stored credential");
    const type = (parsed as { type?: unknown }).type;
    if (type !== "api_key" && type !== "oauth") throw new Error("Invalid credential type");
    return parsed as Credential;
  }

  async list(): Promise<readonly CredentialInfo[]> {
    const prefix = "credential:";
    const result: CredentialInfo[] = [];
    for (const key of await this.secrets.listKeys(prefix)) {
      const providerId = key.slice(prefix.length);
      const credential = await this.read(providerId);
      if (credential) result.push({ providerId, type: credential.type });
    }
    return result;
  }

  async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined> {
    const previous = this.chains.get(providerId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(async () => {
      const current = await this.read(providerId);
      const updated = await fn(current);
      if (updated !== undefined) {
        await this.secrets.set(this.key(providerId), JSON.stringify(updated));
      }
      return updated ?? current;
    });
    this.chains.set(providerId, next);
    try {
      return await next;
    } finally {
      if (this.chains.get(providerId) === next) this.chains.delete(providerId);
    }
  }

  async delete(providerId: string): Promise<void> {
    const previous = this.chains.get(providerId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() => this.secrets.delete(this.key(providerId)));
    this.chains.set(providerId, next);
    try {
      await next;
    } finally {
      if (this.chains.get(providerId) === next) this.chains.delete(providerId);
    }
  }
}
