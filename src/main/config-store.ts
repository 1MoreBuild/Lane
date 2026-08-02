import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { LaneConfig, ProviderConfig } from "../shared/contracts.ts";
import { isAllowedTranslyExtensionOrigin } from "../shared/native-messaging.ts";

const DEFAULT_PORT = 3210;

export function defaultConfig(): LaneConfig {
  return {
    version: 1,
    gateway: {
      port: DEFAULT_PORT,
      autoStart: false,
      allowedOrigins: [
        `http://127.0.0.1:${DEFAULT_PORT}`,
        `http://localhost:${DEFAULT_PORT}`,
      ],
    },
    providers: [],
    reasoningEffort: "high",
    speedMode: "standard",
    launchAtLogin: false,
    visibility: {
      showDockIcon: true,
      showMenuBarIcon: true,
    },
    cli: {
      enabled: false,
    },
  };
}

function isProviderConfig(value: unknown): value is ProviderConfig {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<ProviderConfig>;
  return (
    typeof item.id === "string" &&
    ["openai-codex", "openai", "anthropic", "openrouter", "custom-openai"].includes(
      item.kind ?? "",
    ) &&
    typeof item.name === "string" &&
    Array.isArray(item.models) &&
    item.models.every((model) => typeof model === "string") &&
    typeof item.createdAt === "number"
  );
}

export function validateConfig(value: unknown): LaneConfig {
  if (!value || typeof value !== "object") throw new Error("Invalid Lane settings");
  const input = value as Partial<LaneConfig>;
  const port = input.gateway?.port;
  if (!Number.isInteger(port) || port === undefined || port < 1024 || port > 65_535) {
    throw new Error("Gateway port must be between 1024 and 65535");
  }
  const origins = input.gateway?.allowedOrigins;
  if (
    !Array.isArray(origins) ||
    origins.some((origin) => {
      if (typeof origin !== "string" || origin === "*") return true;
      if (/^chrome-extension:\/\/[a-p]{32}$/.test(origin)) return false;
      try {
        const url = new URL(origin);
        return (
          url.origin !== origin ||
          (url.protocol !== "http:" && url.protocol !== "https:")
        );
      } catch {
        return true;
      }
    })
  ) {
    throw new Error("CORS origins must be explicit");
  }
  const allowedOrigins = origins.filter(
    (origin) =>
      !origin.startsWith("chrome-extension://") ||
      isAllowedTranslyExtensionOrigin(origin),
  );
  if (!Array.isArray(input.providers) || !input.providers.every(isProviderConfig)) {
    throw new Error("Invalid provider settings");
  }
  return {
    version: 1,
    gateway: {
      port,
      autoStart: input.gateway?.autoStart === true,
      allowedOrigins,
    },
    providers: [...input.providers],
    ...(typeof input.defaultModel === "string" ? { defaultModel: input.defaultModel } : {}),
    ...(typeof input.defaultImageModel === "string"
      ? { defaultImageModel: input.defaultImageModel }
      : {}),
    reasoningEffort: ["low", "medium", "high", "xhigh", "max"].includes(
      input.reasoningEffort ?? "",
    )
      ? input.reasoningEffort as LaneConfig["reasoningEffort"]
      : "high",
    speedMode: input.speedMode === "fast" ? "fast" : "standard",
    launchAtLogin: input.launchAtLogin === true,
    visibility: {
      showDockIcon: input.visibility?.showDockIcon !== false,
      showMenuBarIcon: input.visibility?.showMenuBarIcon !== false,
    },
    cli: {
      enabled: input.cli?.enabled === true,
    },
  };
}

export class ConfigStore {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async load(): Promise<LaneConfig> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as Partial<LaneConfig>;
      const config = validateConfig(parsed);
      if (
        JSON.stringify(parsed.gateway?.allowedOrigins) !==
        JSON.stringify(config.gateway.allowedOrigins)
      ) {
        await this.save(config);
      }
      return config;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return defaultConfig();
      throw error;
    }
  }

  async save(config: LaneConfig): Promise<void> {
    const validated = validateConfig(config);
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.filePath}.tmp`;
    await writeFile(temporary, `${JSON.stringify(validated, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporary, this.filePath);
  }

  async update(mutator: (current: LaneConfig) => LaneConfig | Promise<LaneConfig>): Promise<LaneConfig> {
    let result: LaneConfig | undefined;
    this.chain = this.chain.catch(() => undefined).then(async () => {
      result = validateConfig(await mutator(await this.load()));
      await this.save(result);
    });
    await this.chain;
    if (!result) throw new Error("Settings update failed");
    return result;
  }
}
