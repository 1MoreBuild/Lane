import { randomBytes, randomUUID } from "node:crypto";
import type { CredentialStore } from "@earendil-works/pi-ai";
import type {
  AddProviderInput,
  LaneConfig,
  LaneState,
  ProviderConfig,
  ProviderKind,
  ProviderStatus,
} from "../shared/contracts.ts";
import { ConfigStore } from "./config-store.ts";
import type { SecureCredentialStore } from "./credential-store.ts";
import { GatewayServer, RuntimeHolder } from "./gateway.ts";
import { LaneLogger, redact } from "./logger.ts";
import {
  discoverModels,
  type DiscoveryInput,
} from "./model-discovery.ts";
import { OAuthCoordinator } from "./oauth-coordinator.ts";
import { buildModels, PiAiRuntime } from "./pi-runtime.ts";
import { buildImageModels, PiAiImageRuntime } from "./image-runtime.ts";
import type { ModelRuntime } from "./runtime.ts";
import { assertSafeUpstreamUrl } from "./security.ts";
import type { SecretStore } from "./secret-store.ts";

const CLIENT_KEY_SECRET = "lane:client-key";

const DEFAULT_NAMES: Record<Exclude<ProviderKind, "openai-codex">, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  openrouter: "OpenRouter",
  "custom-openai": "Custom OpenAI-compatible",
};

class EmptyRuntime implements ModelRuntime {
  listModels() {
    return [];
  }

  async *stream(): AsyncIterable<never> {
    throw new Error("No providers are configured");
  }
}

export interface AppCoreOptions {
  configStore: ConfigStore;
  secretStore: SecretStore;
  credentials: SecureCredentialStore;
  logger?: LaneLogger;
  discover?: (
    input: DiscoveryInput,
    fetcher?: typeof fetch,
    signal?: AbortSignal,
  ) => ReturnType<typeof discoverModels>;
  setLaunchAtLogin?: (enabled: boolean) => void;
  setDockIconVisible?: (enabled: boolean) => void | Promise<void>;
  setMenuBarIconVisible?: (enabled: boolean) => void | Promise<void>;
}

export class AppCore {
  private readonly configStore: ConfigStore;
  private readonly secretStore: SecretStore;
  private readonly credentials: SecureCredentialStore;
  private readonly logger: LaneLogger;
  private readonly discover: NonNullable<AppCoreOptions["discover"]>;
  private readonly setLoginItem: (enabled: boolean) => void;
  private readonly setDockIcon: (enabled: boolean) => void | Promise<void>;
  private readonly setMenuBarIcon: (enabled: boolean) => void | Promise<void>;
  private readonly runtime = new RuntimeHolder(new EmptyRuntime());
  readonly gateway: GatewayServer;
  private config: LaneConfig | undefined;
  private clientKey: string | undefined;
  private effectiveDefaultImageModel: string | undefined;

  constructor(options: AppCoreOptions) {
    this.configStore = options.configStore;
    this.secretStore = options.secretStore;
    this.credentials = options.credentials;
    this.logger = options.logger ?? new LaneLogger();
    this.gateway = new GatewayServer(this.runtime, this.logger);
    this.discover = options.discover ?? discoverModels;
    this.setLoginItem = options.setLaunchAtLogin ?? (() => {});
    this.setDockIcon = options.setDockIconVisible ?? (() => {});
    this.setMenuBarIcon = options.setMenuBarIconVisible ?? (() => {});
  }

  async initialize(): Promise<void> {
    await this.logger.initialize();
    this.config = await this.configStore.load();
    this.clientKey = await this.secretStore.get(CLIENT_KEY_SECRET);
    if (!this.clientKey) {
      this.clientKey = randomBytes(32).toString("base64url");
      await this.secretStore.set(CLIENT_KEY_SECRET, this.clientKey);
    }
    this.rebuildRuntime();
    if (this.config.launchAtLogin) this.setLoginItem(true);
    await this.setDockIcon(this.config.visibility.showDockIcon);
    await this.setMenuBarIcon(this.config.visibility.showMenuBarIcon);
    if (this.config.gateway.autoStart) {
      try {
        await this.gateway.start(this.config.gateway, this.clientKey);
        this.logger.info(`Gateway restored on ${this.gateway.getEndpoint(this.config.gateway.port)}`);
      } catch (error) {
        this.logger.error(error);
      }
    }
  }

  private requireInitialized(): { config: LaneConfig; clientKey: string } {
    if (!this.config || !this.clientKey) throw new Error("Lane is not initialized");
    return { config: this.config, clientKey: this.clientKey };
  }

  private rebuildRuntime(): void {
    if (!this.config) return;
    const models = buildModels(this.config.providers, this.credentials as CredentialStore);
    const imageModels = buildImageModels(
      this.config.providers,
      this.credentials as CredentialStore,
    );
    const images = new PiAiImageRuntime(
      imageModels,
      this.config.providers,
      this.config.defaultImageModel,
    );
    this.effectiveDefaultImageModel =
      this.config.defaultImageModel ?? images.listModels()[0]?.id;
    const effectiveImages = new PiAiImageRuntime(
      imageModels,
      this.config.providers,
      this.effectiveDefaultImageModel,
    );
    this.runtime.set(
      new PiAiRuntime(
        models,
        this.config.providers,
        this.config.defaultModel,
        effectiveImages,
      ),
    );
  }

  private async persist(config: LaneConfig): Promise<void> {
    await this.configStore.save(config);
    this.config = config;
    this.rebuildRuntime();
  }

  private providerId(input: AddProviderInput): string {
    return input.kind === "custom-openai" ? `custom-${randomUUID()}` : input.kind;
  }

  async addProvider(input: AddProviderInput): Promise<LaneState> {
    const { config } = this.requireInitialized();
    if (!["openai", "anthropic", "openrouter", "custom-openai"].includes(input.kind)) {
      throw new Error("Unsupported provider type");
    }
    const baseUrl =
      input.kind === "custom-openai"
        ? assertSafeUpstreamUrl(input.baseUrl ?? "").toString().replace(/\/$/, "")
        : undefined;
    const discovered = await this.discover({
      kind: input.kind,
      apiKey: input.apiKey,
      ...(baseUrl ? { baseUrl } : {}),
    });
    const id = this.providerId(input);
    const previousCredential = await this.credentials.read(id);
    await this.credentials.modify(id, async () => ({ type: "api_key", key: input.apiKey }));
    const provider: ProviderConfig = {
      id,
      kind: input.kind,
      name: input.name?.trim() || DEFAULT_NAMES[input.kind],
      ...(baseUrl ? { baseUrl } : {}),
      models: discovered.map((model) => model.id),
      createdAt: Date.now(),
    };
    const providers =
      input.kind === "custom-openai"
        ? [...config.providers, provider]
        : [...config.providers.filter((item) => item.id !== id), provider];
    try {
      await this.persist({ ...config, providers });
    } catch (error) {
      if (previousCredential) {
        await this.credentials.modify(id, async () => previousCredential);
      } else {
        await this.credentials.delete(id);
      }
      throw error;
    }
    this.logger.info(`Connected ${provider.name}; ${provider.models.length} models loaded`);
    return await this.getState();
  }

  async startOAuth(coordinator: OAuthCoordinator): Promise<LaneState> {
    const { config } = this.requireInitialized();
    const provisional: ProviderConfig = {
      id: "openai-codex",
      kind: "openai-codex",
      name: "ChatGPT / Codex",
      models: [],
      createdAt: Date.now(),
    };
    const models = buildModels(
      [...config.providers.filter((item) => item.id !== provisional.id), provisional],
      this.credentials,
    );
    const previousCredential = await this.credentials.read(provisional.id);
    await coordinator.login(models);
    const providers = [
      ...config.providers.filter((item) => item.id !== provisional.id),
      provisional,
    ];
    try {
      await this.persist({ ...config, providers });
    } catch (error) {
      if (previousCredential) {
        await this.credentials.modify(provisional.id, async () => previousCredential);
      } else {
        await this.credentials.delete(provisional.id);
      }
      throw error;
    }
    this.logger.info("Connected ChatGPT / Codex with OAuth");
    return await this.getState();
  }

  async removeProvider(providerId: string): Promise<LaneState> {
    const { config } = this.requireInitialized();
    if (!config.providers.some((provider) => provider.id === providerId)) {
      throw new Error("Provider not found");
    }
    const previousCredential = await this.credentials.read(providerId);
    await this.credentials.delete(providerId);
    const defaultModel = config.defaultModel?.startsWith(`${providerId}/`)
      ? undefined
      : config.defaultModel;
    const defaultImageModel = config.defaultImageModel?.startsWith(`${providerId}/`)
      ? undefined
      : config.defaultImageModel;
    const {
      defaultModel: _previousDefaultModel,
      defaultImageModel: _previousDefaultImageModel,
      ...configWithoutDefault
    } = config;
    try {
      await this.persist({
        ...configWithoutDefault,
        providers: config.providers.filter((provider) => provider.id !== providerId),
        ...(defaultModel ? { defaultModel } : {}),
        ...(defaultImageModel ? { defaultImageModel } : {}),
      });
    } catch (error) {
      if (previousCredential) {
        await this.credentials.modify(providerId, async () => previousCredential);
      }
      throw error;
    }
    this.logger.info(`Removed provider ${providerId} and cleared its credential`);
    return await this.getState();
  }

  async setDefaultModel(modelId: string): Promise<LaneState> {
    const { config } = this.requireInitialized();
    const models = await this.runtime.listModels();
    if (!models.some((model) => model.id === modelId)) throw new Error("Model not found");
    await this.persist({ ...config, defaultModel: modelId });
    this.logger.info(`Default model set to ${modelId}`);
    return await this.getState();
  }

  async setDefaultImageModel(modelId: string): Promise<LaneState> {
    const { config } = this.requireInitialized();
    const models = await this.runtime.listImageModels?.();
    if (!models?.some((model) => model.id === modelId)) {
      throw new Error("Image model not found");
    }
    await this.persist({ ...config, defaultImageModel: modelId });
    this.logger.info(`Default image model set to ${modelId}`);
    return await this.getState();
  }

  async startGateway(): Promise<LaneState> {
    const { config, clientKey } = this.requireInitialized();
    await this.gateway.start(config.gateway, clientKey);
    try {
      await this.persist({
        ...config,
        gateway: { ...config.gateway, autoStart: true },
      });
    } catch (error) {
      await this.gateway.stop();
      throw error;
    }
    this.logger.info(`Gateway started on ${this.gateway.getEndpoint(config.gateway.port)}`);
    return await this.getState();
  }

  async stopGateway(): Promise<LaneState> {
    const { config } = this.requireInitialized();
    await this.gateway.stop();
    await this.persist({
      ...config,
      gateway: { ...config.gateway, autoStart: false },
    });
    this.logger.info("Gateway stopped");
    return await this.getState();
  }

  async setLaunchOnLogin(enabled: boolean): Promise<LaneState> {
    const { config } = this.requireInitialized();
    this.setLoginItem(enabled);
    try {
      await this.persist({ ...config, launchAtLogin: enabled });
    } catch (error) {
      this.setLoginItem(config.launchAtLogin);
      throw error;
    }
    this.logger.info(`Launch at login ${enabled ? "enabled" : "disabled"}`);
    return await this.getState();
  }

  async setDockIconVisible(enabled: boolean): Promise<LaneState> {
    const { config } = this.requireInitialized();
    await this.setDockIcon(enabled);
    try {
      await this.persist({
        ...config,
        visibility: { ...config.visibility, showDockIcon: enabled },
      });
    } catch (error) {
      await this.setDockIcon(config.visibility.showDockIcon);
      throw error;
    }
    this.logger.info(`Dock icon ${enabled ? "shown" : "hidden"}`);
    return await this.getState();
  }

  async setMenuBarIconVisible(enabled: boolean): Promise<LaneState> {
    const { config } = this.requireInitialized();
    await this.setMenuBarIcon(enabled);
    try {
      await this.persist({
        ...config,
        visibility: { ...config.visibility, showMenuBarIcon: enabled },
      });
    } catch (error) {
      await this.setMenuBarIcon(config.visibility.showMenuBarIcon);
      throw error;
    }
    this.logger.info(`Menu bar icon ${enabled ? "shown" : "hidden"}`);
    return await this.getState();
  }

  async setCliEnabled(enabled: boolean): Promise<LaneState> {
    const { config } = this.requireInitialized();
    await this.persist({
      ...config,
      cli: { enabled },
    });
    this.logger.info(`CLI integration ${enabled ? "enabled" : "disabled"}`);
    return await this.getState();
  }

  private async providerStatuses(config: LaneConfig): Promise<ProviderStatus[]> {
    return await Promise.all(
      config.providers.map(async (provider) => {
        try {
          const credential = await this.credentials.read(provider.id);
          return {
            id: provider.id,
            kind: provider.kind,
            name: provider.name,
            connected: credential !== undefined,
            ...(credential ? { authType: credential.type } : {}),
            models: [...provider.models],
          };
        } catch (error) {
          return {
            id: provider.id,
            kind: provider.kind,
            name: provider.name,
            connected: false,
            models: [...provider.models],
            error: redact(error),
          };
        }
      }),
    );
  }

  async getState(): Promise<LaneState> {
    const { config, clientKey } = this.requireInitialized();
    return {
      gateway: {
        running: this.gateway.isRunning(),
        endpoint: this.gateway.getEndpoint(config.gateway.port),
        port: config.gateway.port,
        ...(this.gateway.lastError ? { error: this.gateway.lastError } : {}),
      },
      providers: await this.providerStatuses(config),
      models: await this.runtime.listModels(),
      imageModels: (await this.runtime.listImageModels?.()) ?? [],
      ...(config.defaultModel ? { defaultModel: config.defaultModel } : {}),
      ...(this.effectiveDefaultImageModel
        ? { defaultImageModel: this.effectiveDefaultImageModel }
        : {}),
      launchAtLogin: config.launchAtLogin,
      visibility: { ...config.visibility },
      cliEnabled: config.cli.enabled,
      clientKey,
      logs: this.logger.list(),
    };
  }

  async shutdown(): Promise<void> {
    await this.gateway.stop();
    await this.logger.flush();
  }
}
