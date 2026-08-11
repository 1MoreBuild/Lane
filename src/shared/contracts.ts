export type ProviderKind =
  | "openai-codex"
  | "openai"
  | "anthropic"
  | "openrouter"
  | "custom-openai";

export interface ProviderConfig {
  id: string;
  kind: ProviderKind;
  name: string;
  baseUrl?: string;
  models: string[];
  createdAt: number;
}

export interface GatewayConfig {
  port: number;
  autoStart: boolean;
  allowedOrigins: string[];
}

export interface AppVisibilityConfig {
  showDockIcon: boolean;
  showMenuBarIcon: boolean;
}

export interface CliConfig {
  enabled: boolean;
}

export type SpeedMode = "standard" | "fast";
export type ReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max";

export interface LaneConfig {
  version: 1;
  gateway: GatewayConfig;
  providers: ProviderConfig[];
  defaultModel?: string;
  defaultImageModel?: string;
  reasoningEffort: ReasoningEffort;
  speedMode: SpeedMode;
  launchAtLogin: boolean;
  visibility: AppVisibilityConfig;
  cli: CliConfig;
}

export interface ProviderStatus {
  id: string;
  kind: ProviderKind;
  name: string;
  connected: boolean;
  authType?: "api_key" | "oauth";
  models: string[];
  error?: string;
}

export interface PublicModel {
  id: string;
  provider: string;
  name: string;
  reasoning?: boolean;
  reasoningEfforts?: ReasoningEffort[];
}

export interface LaneState {
  gateway: {
    running: boolean;
    endpoint: string;
    port: number;
    error?: string;
  };
  credentialStorage: {
    available: boolean;
    notice?: string;
    error?: string;
  };
  providers: ProviderStatus[];
  models: PublicModel[];
  imageModels: PublicModel[];
  defaultModel?: string;
  defaultImageModel?: string;
  reasoningEffort: ReasoningEffort;
  speedMode: SpeedMode;
  launchAtLogin: boolean;
  visibility: AppVisibilityConfig;
  cliEnabled: boolean;
  activityCaptureEnabled: boolean;
  clientKey: string;
  logs: LogEntry[];
}

export interface CliIntegrationState {
  enabled: boolean;
  installed: boolean;
  command: string;
  path?: string;
  error?: string;
}

export interface GatewayTrace {
  kind: "gateway";
  requestId: string;
  phase: "started" | "completed";
  method: string;
  path: string;
  stream?: boolean;
  model?: string;
  provider?: string;
  status?: number;
  durationMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  imageCount?: number;
  errorCode?: string;
  cancelled?: boolean;
}

export interface GatewayCapturedBody {
  body: string;
  contentType?: string;
  capturedBytes: number;
  totalBytes: number;
  truncated: boolean;
}

export interface GatewayCapture {
  request?: GatewayCapturedBody;
  response?: GatewayCapturedBody;
}

export interface LogEntry {
  timestamp: number;
  level: "info" | "warn" | "error";
  message: string;
  trace?: GatewayTrace;
  capture?: GatewayCapture;
}

export interface AddProviderInput {
  kind: Exclude<ProviderKind, "openai-codex">;
  name?: string;
  apiKey: string;
  baseUrl?: string;
}

export type LaneUpdateState =
  | { status: "idle" }
  | { status: "available"; version: string }
  | { status: "downloading"; version: string; percent: number };

export interface LaneRendererApi {
  readonly platform: string;
  getState(): Promise<LaneState>;
  clearActivity(): Promise<LaneState>;
  setActivityCapture(enabled: boolean): Promise<LaneState>;
  getUpdateState(): Promise<LaneUpdateState>;
  downloadUpdate(): Promise<void>;
  addProvider(input: AddProviderInput): Promise<LaneState>;
  removeProvider(providerId: string): Promise<LaneState>;
  startOAuth(): Promise<LaneState>;
  submitOAuthCode(code: string): Promise<void>;
  cancelOAuth(): Promise<void>;
  setDefaultModel(modelId: string): Promise<LaneState>;
  setDefaultImageModel(modelId: string): Promise<LaneState>;
  setReasoningEffort(effort: ReasoningEffort): Promise<LaneState>;
  setSpeedMode(mode: SpeedMode): Promise<LaneState>;
  startGateway(): Promise<LaneState>;
  stopGateway(): Promise<LaneState>;
  setLaunchAtLogin(enabled: boolean): Promise<LaneState>;
  setDockIconVisible(enabled: boolean): Promise<LaneState>;
  setMenuBarIconVisible(enabled: boolean): Promise<LaneState>;
  getCliIntegration(): Promise<CliIntegrationState>;
  installCliIntegration(): Promise<CliIntegrationState>;
  copyText(text: string): Promise<void>;
  openMainWindow(): Promise<void>;
  quitApp(): Promise<void>;
  onStateChanged(listener: (state: LaneState) => void): () => void;
  onUpdateStateChanged(listener: (state: LaneUpdateState) => void): () => void;
  onOAuthEvent(listener: (event: OAuthUiEvent) => void): () => void;
  onOpenSettings(listener: () => void): () => void;
}

export type OAuthUiEvent =
  | { type: "auth_url"; url: string; instructions?: string }
  | { type: "prompt"; promptType: string; message: string }
  | { type: "progress"; message: string }
  | { type: "error"; message: string };

declare global {
  interface Window {
    lane: LaneRendererApi;
  }
}
