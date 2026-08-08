import { realpathSync } from "node:fs";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  nativeImage,
  nativeTheme,
  screen,
  shell,
  Tray,
} from "electron";
import electronUpdater from "electron-updater";
import type {
  AddProviderInput,
  LaneState,
  LaneUpdateState,
  OAuthUiEvent,
  ReasoningEffort,
} from "../shared/contracts.ts";
import {
  getLaneApiBaseUrl,
  getLaneApiUrl,
  LANE_API_ROUTES,
} from "../shared/api-endpoints.ts";
import { AppCore } from "./app-core.ts";
import { LaneAutoUpdate } from "./auto-update.ts";
import { GatewayStartError } from "./gateway.ts";
import { isLaneCliInvocation, runLaneCli } from "./cli.ts";
import {
  getCliSocketPath,
  LaneCliControlServer,
  requestCliControl,
  type CliControlRequest,
} from "./cli-control.ts";
import { CliInstaller } from "./cli-install.ts";
import { ConfigStore } from "./config-store.ts";
import { SecureCredentialStore } from "./credential-store.ts";
import { ElectronSecretBackend } from "./electron-secret-backend.ts";
import { E2ESecretBackend } from "./e2e-secret-backend.ts";
import { LaneLogger, redact } from "./logger.ts";
import { runLaneNativeHost } from "./native-messaging.ts";
import { NativeMessagingInstaller } from "./native-messaging-install.ts";
import { OAuthCoordinator } from "./oauth-coordinator.ts";
import { SecretStore } from "./secret-store.ts";

const dirname = fileURLToPath(new URL(".", import.meta.url));
const cliWakeMode = process.env.LANE_CLI_WAKE === "1";
const releaseBuild = process.env.LANE_RELEASE_BUILD === "1";
const e2eUserData = process.env.LANE_E2E_USER_DATA;
const e2eMode = e2eUserData !== undefined;
if (e2eUserData) {
  const temporaryRoot = `${realpathSync(tmpdir())}${sep}`;
  const resolvedUserData = realpathSync(e2eUserData);
  if (!resolvedUserData.startsWith(temporaryRoot)) {
    throw new Error("Lane E2E user data must be an existing temporary directory");
  }
  app.setPath("userData", resolvedUserData);
}
process.env.PI_OAUTH_CALLBACK_HOST = "127.0.0.1";

let mainWindow: BrowserWindow | undefined;
let menubarWindow: BrowserWindow | undefined;
let tray: Tray | undefined;
let core: AppCore | undefined;
let oauth: OAuthCoordinator | undefined;
let cliControlServer: LaneCliControlServer | undefined;
let cliInstaller: CliInstaller | undefined;
let autoUpdate: LaneAutoUpdate | undefined;
let updateState: LaneUpdateState = { status: "idle" };
let quitting = false;
let shutdownComplete = false;
let shutdownInProgress = false;
let shutdownPromise: Promise<void> | undefined;
let menuBarIconVisible = true;
let activityRefreshScheduled = false;

function sendState(state: LaneState): void {
  mainWindow?.webContents.send("lane:state-changed", state);
  menubarWindow?.webContents.send("lane:state-changed", state);
  refreshTray(state);
}

function scheduleActivityRefresh(): void {
  if (activityRefreshScheduled) return;
  activityRefreshScheduled = true;
  queueMicrotask(() => {
    activityRefreshScheduled = false;
    const appCore = core;
    if (!appCore || (!mainWindow && !menubarWindow)) return;
    void appCore
      .getState()
      .then((state) => {
        mainWindow?.webContents.send("lane:state-changed", state);
        menubarWindow?.webContents.send("lane:state-changed", state);
      })
      .catch((error: unknown) => {
        console.error(`Lane activity refresh warning: ${redact(error)}`);
      });
  });
}

function sendOAuth(event: OAuthUiEvent): void {
  mainWindow?.webContents.send("lane:oauth-event", event);
}

function sendUpdateState(state: LaneUpdateState): void {
  updateState = state;
  mainWindow?.webContents.send("lane:update-state-changed", state);
}

async function shutdownServices(): Promise<void> {
  if (shutdownComplete) return;
  if (!shutdownPromise) {
    shutdownInProgress = true;
    shutdownPromise = Promise.all([cliControlServer?.stop(), core?.shutdown()])
      .then(() => undefined)
      .catch((error: unknown) => {
        console.error(`Lane shutdown warning: ${redact(error)}`);
      })
      .finally(() => {
        shutdownComplete = true;
        shutdownInProgress = false;
      });
  }
  await shutdownPromise;
}

function showMainWindow(): void {
  menubarWindow?.hide();
  mainWindow?.show();
  mainWindow?.focus();
}

function lockRendererNavigation(window: BrowserWindow): void {
  window.webContents.on("will-navigate", (event, url) => {
    event.preventDefault();
    if (url.startsWith("https://")) void shell.openExternal(url);
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) void shell.openExternal(url);
    return { action: "deny" };
  });
}

async function stateAfter(action: () => Promise<LaneState>): Promise<LaneState> {
  try {
    const state = await action();
    sendState(state);
    return state;
  } catch (error) {
    throw new Error(redact(error));
  }
}

async function isPortAvailable(port: number): Promise<boolean> {
  const server = createServer();
  return await new Promise<boolean>((resolveAvailable) => {
    server.once("error", () => resolveAvailable(false));
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolveAvailable(true));
    });
  });
}

async function findAlternativePort(currentPort: number): Promise<number> {
  for (let offset = 1; offset <= 20; offset += 1) {
    const candidate = currentPort + offset;
    if (candidate > 65_535) break;
    if (await isPortAvailable(candidate)) return candidate;
  }
  const server = createServer();
  return await new Promise<number>((resolvePort, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not find an available local port"));
        return;
      }
      server.close((error) => (error ? reject(error) : resolvePort(address.port)));
    });
  });
}

async function startGatewayFromUi(
  appCore: AppCore,
  parent: BrowserWindow | null,
): Promise<LaneState> {
  try {
    const state = await appCore.startGateway();
    sendState(state);
    return state;
  } catch (error) {
    if (!(error instanceof GatewayStartError) || error.code !== "EADDRINUSE") {
      throw new Error(redact(error));
    }
    const state = await appCore.getState();
    const currentPort = Number(new URL(state.gateway.endpoint).port);
    const alternativePort = await findAlternativePort(currentPort);
    const options: Electron.MessageBoxOptions = {
      type: "warning",
      message: `Port ${currentPort} is already in use`,
      detail:
        `Lane can use port ${alternativePort} instead. ` +
        "Apps using the current API URL will need to be updated.",
      buttons: [`Use port ${alternativePort}`, "Cancel"],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    };
    const choice = parent
      ? await dialog.showMessageBox(parent, options)
      : await dialog.showMessageBox(options);
    if (choice.response !== 0) throw new Error(redact(error));
    return await stateAfter(() => appCore.startGatewayOnPort(alternativePort));
  }
}

function validateProviderInput(value: unknown): AddProviderInput {
  if (!value || typeof value !== "object") throw new Error("Provider input is required");
  const input = value as Partial<AddProviderInput>;
  if (!["openai", "anthropic", "openrouter", "custom-openai"].includes(input.kind ?? "")) {
    throw new Error("Unsupported provider type");
  }
  if (typeof input.apiKey !== "string" || !input.apiKey.trim()) throw new Error("API key is required");
  if (input.kind === "custom-openai" && (typeof input.baseUrl !== "string" || !input.baseUrl)) {
    throw new Error("Custom endpoint is required");
  }
  return {
    kind: input.kind as AddProviderInput["kind"],
    apiKey: input.apiKey,
    ...(typeof input.name === "string" ? { name: input.name } : {}),
    ...(typeof input.baseUrl === "string" ? { baseUrl: input.baseUrl } : {}),
  };
}

function publicProviders(state: LaneState): unknown[] {
  return state.providers.map((provider) => ({
    id: provider.id,
    kind: provider.kind,
    name: provider.name,
    connected: provider.connected,
    auth_type: provider.authType ?? null,
    models: provider.models,
    ...(provider.error ? { error: provider.error } : {}),
  }));
}

async function cliResult(request: CliControlRequest, appCore: AppCore): Promise<unknown> {
  const { command, params } = request;
  if (command === "open") {
    showMainWindow();
    return { opened: true };
  }
  if (command === "providers-add") {
    const state = await stateAfter(() => appCore.addProvider(params!.provider!));
    return { providers: publicProviders(state), default_model: state.defaultModel ?? null };
  }
  if (command === "providers-remove") {
    const state = await stateAfter(() => appCore.removeProvider(params!.providerId!));
    return { removed: params!.providerId, providers: publicProviders(state) };
  }
  if (command === "providers-oauth") {
    if (oauth) throw new Error("An OAuth sign-in is already in progress");
    oauth = new OAuthCoordinator(
      async (url) => {
        await shell.openExternal(url);
      },
      sendOAuth,
    );
    try {
      const state = await stateAfter(() => appCore.startOAuth(oauth!));
      return { providers: publicProviders(state), default_model: state.defaultModel ?? null };
    } finally {
      oauth = undefined;
    }
  }
  if (command === "default-model-set") {
    const state = await stateAfter(() => appCore.setDefaultModel(params!.modelId!));
    return { default_model: state.defaultModel ?? null };
  }
  if (command === "default-image-model-set") {
    const state = await stateAfter(() => appCore.setDefaultImageModel(params!.modelId!));
    return { default_image_model: state.defaultImageModel ?? null };
  }
  if (command === "speed-mode-set") {
    const state = await stateAfter(() => appCore.setSpeedMode(params!.speedMode!));
    return { speed_mode: state.speedMode };
  }
  if (command === "reasoning-effort-set") {
    const state = await stateAfter(() =>
      appCore.setReasoningEffort(params!.reasoningEffort!),
    );
    return { reasoning_effort: state.reasoningEffort };
  }
  if (command === "browser-client-connect") {
    const state = await stateAfter(() => appCore.connectBrowserClient(params!.origin!));
    return {
      service: "lane",
      apiUrl: getLaneApiBaseUrl(state.gateway.endpoint),
      apiKey: state.clientKey,
      models: state.models.map((model) => model.id),
      defaultModel: state.defaultModel ?? state.models[0]?.id ?? null,
      protocol: "responses",
    };
  }
  const state =
    command === "start"
      ? await stateAfter(() => appCore.startGateway())
      : command === "stop"
        ? await stateAfter(() => appCore.stopGateway())
        : await appCore.getState();
  if (command === "models") {
    return [
      ...state.models.map((model) => ({
        id: model.id,
        name: model.name,
        provider: model.provider,
        capability: "chat",
      })),
      ...state.imageModels.map((model) => ({
        id: model.id,
        name: model.name,
        provider: model.provider,
        capability: "image_generation",
      })),
    ];
  }
  if (command === "connection") {
    return {
      api_base_url: getLaneApiBaseUrl(state.gateway.endpoint),
      client_key: state.clientKey,
      endpoints: LANE_API_ROUTES.map((route) => ({
        method: route.method,
        name: route.label,
        url: getLaneApiUrl(state.gateway.endpoint, route.path),
      })),
    };
  }
  if (command === "providers-list") return publicProviders(state);
  if (command === "activity") {
    return state.logs.map((entry) => {
      const trace = entry.trace;
      return {
        timestamp: new Date(entry.timestamp).toISOString(),
        level: entry.level,
        type: trace ? "gateway" : "system",
        message: entry.message,
        ...(trace
          ? {
              request_id: trace.requestId,
              phase: trace.phase,
              method: trace.method,
              path: trace.path,
              ...(trace.stream !== undefined ? { stream: trace.stream } : {}),
              ...(trace.provider ? { provider: trace.provider } : {}),
              ...(trace.model ? { model: trace.model } : {}),
              ...(trace.status !== undefined ? { status: trace.status } : {}),
              ...(trace.durationMs !== undefined
                ? { duration_ms: trace.durationMs }
                : {}),
              ...(trace.inputTokens !== undefined
                ? { input_tokens: trace.inputTokens }
                : {}),
              ...(trace.outputTokens !== undefined
                ? { output_tokens: trace.outputTokens }
                : {}),
              ...(trace.totalTokens !== undefined
                ? { total_tokens: trace.totalTokens }
                : {}),
              ...(trace.imageCount !== undefined
                ? { image_count: trace.imageCount }
                : {}),
              ...(trace.errorCode ? { error_code: trace.errorCode } : {}),
              ...(trace.cancelled !== undefined
                ? { cancelled: trace.cancelled }
                : {}),
            }
          : {}),
      };
    });
  }
  return {
    version: app.getVersion(),
    gateway: {
      running: state.gateway.running,
      api_base_url: getLaneApiBaseUrl(state.gateway.endpoint),
      ...(state.gateway.error ? { error: state.gateway.error } : {}),
    },
    default_model: state.defaultModel ?? null,
    default_image_model: state.defaultImageModel ?? null,
    reasoning_effort: state.reasoningEffort,
    speed_mode: state.speedMode,
    providers: {
      connected: state.providers.filter((provider) => provider.connected).length,
      total: state.providers.length,
    },
  };
}

async function startCliControl(appCore: AppCore): Promise<void> {
  if (cliControlServer) return;
  const server = new LaneCliControlServer(
    process.env.LANE_CONTROL_SOCKET || getCliSocketPath(app.getPath("userData")),
    { execute: (request) => cliResult(request, appCore) },
  );
  await server.start();
  cliControlServer = server;
}

function registerIpc(appCore: AppCore, installer: CliInstaller): void {
  ipcMain.handle("lane:get-state", () => appCore.getState());
  ipcMain.handle("lane:clear-activity", () => stateAfter(() => appCore.clearActivity()));
  ipcMain.handle("lane:get-update-state", () => updateState);
  ipcMain.handle("lane:download-update", async () => {
    await autoUpdate?.downloadAvailable();
  });
  ipcMain.handle("lane:add-provider", (_event, input: unknown) =>
    stateAfter(() => appCore.addProvider(validateProviderInput(input))),
  );
  ipcMain.handle("lane:remove-provider", (_event, id: unknown) => {
    if (typeof id !== "string") throw new Error("Provider id is required");
    return stateAfter(() => appCore.removeProvider(id));
  });
  ipcMain.handle("lane:start-oauth", async () => {
    oauth = new OAuthCoordinator(
      async (url) => {
        await shell.openExternal(url);
      },
      sendOAuth,
    );
    try {
      return await stateAfter(() => appCore.startOAuth(oauth!));
    } finally {
      oauth = undefined;
    }
  });
  ipcMain.handle("lane:submit-oauth-code", (_event, code: unknown) => {
    if (typeof code !== "string") throw new Error("OAuth code is required");
    oauth?.submit(code);
  });
  ipcMain.handle("lane:cancel-oauth", () => oauth?.cancel());
  ipcMain.handle("lane:set-default-model", (_event, model: unknown) => {
    if (typeof model !== "string") throw new Error("Model id is required");
    return stateAfter(() => appCore.setDefaultModel(model));
  });
  ipcMain.handle("lane:set-default-image-model", (_event, model: unknown) => {
    if (typeof model !== "string") throw new Error("Image model id is required");
    return stateAfter(() => appCore.setDefaultImageModel(model));
  });
  ipcMain.handle("lane:set-speed-mode", (_event, mode: unknown) => {
    if (mode !== "standard" && mode !== "fast") throw new Error("Invalid speed mode");
    return stateAfter(() => appCore.setSpeedMode(mode));
  });
  ipcMain.handle("lane:set-reasoning-effort", (_event, effort: unknown) => {
    if (!["low", "medium", "high", "xhigh", "max"].includes(String(effort))) {
      throw new Error("Invalid reasoning effort");
    }
    return stateAfter(() =>
      appCore.setReasoningEffort(effort as ReasoningEffort),
    );
  });
  ipcMain.handle("lane:start-gateway", (event) =>
    startGatewayFromUi(appCore, BrowserWindow.fromWebContents(event.sender)),
  );
  ipcMain.handle("lane:stop-gateway", () => stateAfter(() => appCore.stopGateway()));
  ipcMain.handle("lane:set-launch-at-login", (_event, enabled: unknown) => {
    if (typeof enabled !== "boolean") throw new Error("Boolean value required");
    return stateAfter(() => appCore.setLaunchOnLogin(enabled));
  });
  ipcMain.handle("lane:set-dock-icon-visible", (_event, enabled: unknown) => {
    if (typeof enabled !== "boolean") throw new Error("Boolean value required");
    return stateAfter(() => appCore.setDockIconVisible(enabled));
  });
  ipcMain.handle("lane:set-menu-bar-icon-visible", (_event, enabled: unknown) => {
    if (typeof enabled !== "boolean") throw new Error("Boolean value required");
    return stateAfter(() => appCore.setMenuBarIconVisible(enabled));
  });
  ipcMain.handle("lane:get-cli-integration", async () => {
    const state = await appCore.getState();
    return await installer.getState(state.cliEnabled);
  });
  ipcMain.handle("lane:install-cli-integration", async () => {
    if (!app.isPackaged) {
      throw new Error("Install the packaged Lane app before enabling its command line tool");
    }
    const existing = await installer.getState(false);
    if (!existing.installed) await installer.install();
    await startCliControl(appCore);
    const state = await appCore.setCliEnabled(true);
    sendState(state);
    return await installer.getState(true);
  });
  ipcMain.handle("lane:copy-text", (_event, text: unknown) => {
    if (typeof text !== "string" || text.length > 4096) throw new Error("Invalid text");
    clipboard.writeText(text);
  });
  ipcMain.handle("lane:open-main-window", () => showMainWindow());
  ipcMain.handle("lane:quit-app", () => {
    quitting = true;
    app.quit();
  });
}

function trayImage(): Electron.NativeImage {
  const image = nativeImage.createFromPath(join(dirname, "trayTemplate.png"));
  image.setTemplateImage(true);
  return image;
}

function refreshTray(state?: LaneState): void {
  if (!tray) return;
  const running = state?.gateway.running === true;
  tray.setToolTip(`Lane — gateway ${running ? "running" : "stopped"}`);
}

async function setDockIconVisible(visible: boolean): Promise<void> {
  const dock = app.dock;
  if (process.platform === "darwin" && dock) {
    if (visible) {
      await dock.show();
    } else {
      dock.hide();
    }
    return;
  }
  mainWindow?.setSkipTaskbar(!visible);
}

function destroyMenuBar(): void {
  menubarWindow?.destroy();
  menubarWindow = undefined;
  tray?.destroy();
  tray = undefined;
}

async function setMenuBarIconVisible(visible: boolean): Promise<void> {
  menuBarIconVisible = visible;
  if (!mainWindow) return;
  if (!visible) {
    destroyMenuBar();
    return;
  }
  if (tray && menubarWindow) return;
  tray = new Tray(trayImage());
  menubarWindow = await createMenubarWindow();
  tray.on("click", toggleMenubarWindow);
  tray.on("right-click", toggleMenubarWindow);
  menubarWindow.on("closed", () => {
    menubarWindow = undefined;
  });
  if (core) refreshTray(await core.getState());
}

function positionMenubarWindow(): void {
  if (!tray || !menubarWindow) return;
  const trayBounds = tray.getBounds();
  const windowBounds = menubarWindow.getBounds();
  const display = screen.getDisplayNearestPoint({
    x: Math.round(trayBounds.x + trayBounds.width / 2),
    y: Math.round(trayBounds.y + trayBounds.height / 2),
  });
  const margin = 8;
  const preferredX = Math.round(
    trayBounds.x + trayBounds.width / 2 - windowBounds.width / 2,
  );
  const minX = display.workArea.x + margin;
  const maxX = display.workArea.x + display.workArea.width - windowBounds.width - margin;
  const x = Math.min(Math.max(preferredX, minX), maxX);
  const trayIsAtBottom =
    trayBounds.y > display.bounds.y + display.bounds.height / 2;
  const y = trayIsAtBottom
    ? Math.round(trayBounds.y - windowBounds.height - margin)
    : Math.round(trayBounds.y + trayBounds.height + 3);
  menubarWindow.setPosition(x, y, false);
}

function toggleMenubarWindow(): void {
  if (!menubarWindow) return;
  if (menubarWindow.isVisible()) {
    menubarWindow.hide();
    return;
  }
  positionMenubarWindow();
  menubarWindow.show();
  menubarWindow.focus();
}

async function createMenubarWindow(): Promise<BrowserWindow> {
  const window = new BrowserWindow({
    width: 208,
    height: 96,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    movable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    ...(process.platform === "darwin"
      ? {
          type: "panel" as const,
          vibrancy: "popover" as const,
          visualEffectState: "active" as const,
          roundedCorners: true,
        }
      : {}),
    webPreferences: {
      preload: join(dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  lockRendererNavigation(window);
  window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  window.on("blur", () => {
    if (!window.webContents.isDevToolsOpened()) window.hide();
  });
  window.on("close", (event) => {
    if (!quitting && !e2eMode) {
      event.preventDefault();
      window.hide();
    }
  });
  if (process.env.VITE_DEV_SERVER_URL) {
    await window.loadURL(
      new URL("/menubar.html", process.env.VITE_DEV_SERVER_URL).toString(),
    );
  } else {
    await window.loadFile(join(dirname, "../renderer/menubar.html"));
  }
  return window;
}

async function createWindow(): Promise<BrowserWindow> {
  const window = new BrowserWindow({
    width: 660,
    height: 470,
    minWidth: 620,
    minHeight: 450,
    // Packaged E2E exercises the real renderer and IPC boundary in a hidden
    // native window so the suite does not steal focus from the desktop.
    show: !cliWakeMode && !e2eMode,
    title: "Lane",
    backgroundColor:
      process.platform === "darwin"
        ? "#00000000"
        : nativeTheme.shouldUseDarkColors
          ? "#161616"
          : "#f8f8f8",
    ...(process.platform === "darwin"
      ? {
          titleBarStyle: "hidden" as const,
          trafficLightPosition: { x: 17, y: 15 },
          vibrancy: "under-window" as const,
          visualEffectState: "followWindow" as const,
        }
      : {}),
    webPreferences: {
      preload: join(dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  window.on("close", (event) => {
    if (!quitting && !e2eMode) {
      event.preventDefault();
      window.hide();
    }
  });
  lockRendererNavigation(window);
  if (process.env.VITE_DEV_SERVER_URL) {
    await window.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    await window.loadFile(join(dirname, "../renderer/index.html"));
  }
  return window;
}

function startAutomaticUpdates(logger: LaneLogger): void {
  if (
    !releaseBuild ||
    !app.isPackaged ||
    e2eMode ||
    cliWakeMode ||
    app.getVersion().includes("-") ||
    process.env.LANE_DISABLE_AUTO_UPDATE === "1"
  ) {
    return;
  }
  autoUpdate = new LaneAutoUpdate({
    updater: electronUpdater.autoUpdater,
    logger,
    onStateChanged: sendUpdateState,
    prepareToInstall: async () => {
      quitting = true;
      oauth?.cancel();
      await shutdownServices();
    },
  });
  autoUpdate.start();
}

async function boot(): Promise<void> {
  const userData = app.getPath("userData");
  if (e2eMode) {
    app.dock?.hide();
    app.setAppLogsPath(join(userData, "logs"));
  } else {
    app.setAppLogsPath();
  }
  const logger = new LaneLogger({ directory: app.getPath("logs") });
  const secretBackend = e2eMode
    ? new E2ESecretBackend(process.env.LANE_E2E_SECRET_KEY ?? "")
    : new ElectronSecretBackend();
  const secretStore = new SecretStore(join(userData, "secrets.json"), secretBackend);
  const credentials = new SecureCredentialStore(secretStore);
  core = new AppCore({
    configStore: new ConfigStore(join(userData, "settings.json")),
    secretStore,
    credentials,
    logger,
    setLaunchAtLogin: (enabled) =>
      app.setLoginItemSettings({ openAtLogin: enabled, openAsHidden: true }),
    setDockIconVisible,
    setMenuBarIconVisible,
  });
  logger.subscribe(scheduleActivityRefresh);
  await core.initialize();
  cliInstaller = new CliInstaller({
    executablePath: process.execPath,
    launcherPath: join(process.resourcesPath, "bin/lane"),
  });
  const initialState = await core.getState();
  await startCliControl(core);
  if (!process.defaultApp && !e2eMode && process.platform === "darwin") {
    const nativeMessaging = new NativeMessagingInstaller({
      executablePath: process.execPath,
    });
    try {
      const integration = await nativeMessaging.install();
      if (integration.installed) logger.info("Chrome integration is ready");
      else if (integration.error) logger.warn(integration.error);
    } catch (error) {
      logger.warn(`Chrome integration could not be installed: ${redact(error)}`);
    }
  }
  registerIpc(core, cliInstaller);
  mainWindow = await createWindow();
  await setDockIconVisible(initialState.visibility.showDockIcon);
  await setMenuBarIconVisible(menuBarIconVisible);
  mainWindow.on("closed", () => {
    mainWindow = undefined;
  });
  startAutomaticUpdates(logger);
}

function cliArguments(): string[] {
  return process.defaultApp ? process.argv.slice(2) : process.argv.slice(1);
}

async function wakeLaneApp(): Promise<void> {
  if (process.defaultApp) return;
  await new Promise<void>((resolveWake, reject) => {
    const child = spawn(process.execPath, [], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, LANE_CLI_WAKE: "1" },
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolveWake();
    });
  });
}

const args = cliArguments();
const nativeCallerOrigin = args.find((arg) => arg.startsWith("chrome-extension://"));
const invokedThroughLauncher =
  resolve(process.argv0) !== resolve(process.execPath) &&
  basename(process.argv0).toLowerCase() === "lane";
const cliMode =
  process.env.LANE_BE_CLI === "1" ||
  invokedThroughLauncher ||
  isLaneCliInvocation(args);

if (nativeCallerOrigin) {
  app
    .whenReady()
    .then(async () => {
      app.dock?.hide();
      const socketPath =
        process.env.LANE_CONTROL_SOCKET || getCliSocketPath(app.getPath("userData"));
      const connect = async (callerOrigin: string) => {
        const request = {
          command: "browser-client-connect" as const,
          params: { origin: callerOrigin },
        };
        try {
          return await requestCliControl(socketPath, request, 5_000);
        } catch {
          await wakeLaneApp();
          const deadline = Date.now() + 8_000;
          let lastError: unknown;
          while (Date.now() < deadline) {
            try {
              return await requestCliControl(socketPath, request, 5_000);
            } catch (error) {
              lastError = error;
              await new Promise((resolveWait) => setTimeout(resolveWait, 100));
            }
          }
          throw lastError instanceof Error ? lastError : new Error("Lane is unavailable");
        }
      };
      const code = await runLaneNativeHost({
        callerOrigin: nativeCallerOrigin,
        connect,
        onError: (error) => {
          console.error(`Lane native messaging unavailable: ${redact(error)}`);
        },
      });
      app.exit(code);
    })
    .catch((error: unknown) => {
      console.error(`Lane native messaging failed: ${redact(error)}`);
      app.exit(1);
    });
} else if (cliMode) {
  app
    .whenReady()
    .then(async () => {
      const code = await runLaneCli(args, {
        socketPath:
          process.env.LANE_CONTROL_SOCKET || getCliSocketPath(app.getPath("userData")),
        version: app.getVersion(),
        wakeApp: wakeLaneApp,
      });
      app.exit(code);
    })
    .catch((error: unknown) => {
      console.error(`lane: ${redact(error)}`);
      app.exit(1);
    });
} else {
  const hasLock = app.requestSingleInstanceLock({ cliWake: cliWakeMode });
  if (!hasLock) {
    app.quit();
  } else {
    app.on("second-instance", (_event, _argv, _workingDirectory, additionalData) => {
      if ((additionalData as { cliWake?: boolean } | undefined)?.cliWake !== true) {
        showMainWindow();
      }
    });
    app.whenReady().then(boot).catch((error: unknown) => {
      console.error(`Lane failed to start: ${redact(error)}`);
      app.exit(1);
    });
  }

  app.on("activate", () => {
    showMainWindow();
  });

  app.on("before-quit", (event) => {
    quitting = true;
    oauth?.cancel();
    if (shutdownComplete) return;
    event.preventDefault();
    if (shutdownInProgress) return;
    void shutdownServices().finally(() => app.quit());
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
