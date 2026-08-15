import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
  type TestInfo,
} from "@playwright/test";
import type { KeyboardEvent } from "electron";
import { startMockOpenAI, type MockOpenAI } from "../test/mock-openai.ts";
import { freePort } from "../test/helpers.ts";
import {
  LANE_NATIVE_PROTOCOL_VERSION,
  TRANSLY_PRODUCTION_NATIVE_ALLOWED_ORIGIN,
} from "../src/shared/native-messaging.ts";

interface LaneSession {
  app: ElectronApplication;
  page: Page;
}

interface LaneTestContext {
  userData: string;
  cliCommandPath: string;
  secretKey: string;
  controlSocket: string;
  gatewayPort: number;
  upstream: MockOpenAI;
  session: LaneSession | undefined;
  rendererErrors: string[];
  appExit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
}

const INHERITED_ENVIRONMENT_KEYS =
  process.platform === "win32"
    ? [
        "PATH",
        "SystemRoot",
        "WINDIR",
        "TEMP",
        "TMP",
        "USERPROFILE",
        "LOCALAPPDATA",
        "APPDATA",
        "LANG",
        "LC_ALL",
      ]
    : [
        "PATH",
        "HOME",
        "TMPDIR",
        "USER",
        "LOGNAME",
        "SHELL",
        "LANG",
        "LC_ALL",
        "__CF_USER_TEXT_ENCODING",
      ];

function e2eEnvironment(extra: NodeJS.ProcessEnv = {}): Record<string, string> {
  const inherited = Object.fromEntries(
    INHERITED_ENVIRONMENT_KEYS.flatMap((key) => {
      const value = process.env[key];
      return value === undefined ? [] : [[key, value]];
    }),
  );
  const definedExtra = Object.fromEntries(
    Object.entries(extra).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  return { ...inherited, ...definedExtra };
}

function packagedExecutable(): string {
  if (process.env.LANE_E2E_APP_PATH) {
    return resolve(process.env.LANE_E2E_APP_PATH);
  }
  if (process.platform === "darwin") {
    const directory = process.arch === "x64" ? "mac" : `mac-${process.arch}`;
    return resolve(
      `release/${directory}/Lane.app/Contents/MacOS/Lane`,
    );
  }
  if (process.platform === "win32") {
    return resolve("release/win-unpacked/Lane.exe");
  }
  throw new Error(`Lane E2E does not support ${process.platform}`);
}

function nativeHostExecutable(): string {
  if (process.platform !== "win32") return packagedExecutable();
  return resolve(dirname(packagedExecutable()), "resources/bin/lane-native-host.exe");
}

async function createContext(): Promise<LaneTestContext> {
  const userData = await mkdtemp(join(tmpdir(), "lane-e2e-"));
  const controlSocket =
    process.platform === "win32"
      ? `\\\\.\\pipe\\lane-e2e-${randomBytes(12).toString("hex")}`
      : join(userData, "lane-control.sock");
  const gatewayPort = await freePort();
  const upstream = await startMockOpenAI();
  await writeFile(
    join(userData, "settings.json"),
    `${JSON.stringify(
      {
        version: 1,
        gateway: {
          port: gatewayPort,
          autoStart: false,
          allowedOrigins: [
            `http://127.0.0.1:${gatewayPort}`,
            `http://localhost:${gatewayPort}`,
          ],
        },
        providers: [],
        reasoningEffort: "high",
        speedMode: "standard",
        launchAtLogin: false,
        visibility: {
          showDockIcon: true,
          showMenuBarIcon: false,
        },
        cli: { enabled: false },
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  return {
    userData,
    cliCommandPath: join(userData, "bin", "lane.cmd"),
    controlSocket,
    gatewayPort,
    upstream,
    secretKey: randomBytes(32).toString("base64url"),
    session: undefined,
    rendererErrors: [],
    appExit: undefined,
  };
}

async function launchLane(
  context: LaneTestContext,
  testInfo: TestInfo,
): Promise<LaneSession> {
  const app = await electron.launch({
    executablePath: packagedExecutable(),
    env: e2eEnvironment({
      LANE_DISABLE_AUTO_UPDATE: "1",
      LANE_E2E_USER_DATA: context.userData,
      LANE_E2E_SECRET_KEY: context.secretKey,
      LANE_CONTROL_SOCKET: context.controlSocket,
      LANE_E2E_CLI_COMMAND_PATH: context.cliCommandPath,
    }),
    artifactsDir: testInfo.outputPath("electron-artifacts"),
  });
  context.appExit = undefined;
  app.process().once("exit", (code, signal) => {
    context.appExit = { code, signal };
  });
  const page = await app.firstWindow();
  const windowVisible = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().some((window) => window.isVisible()),
  );
  expect(windowVisible).toBe(false);
  if (process.platform === "win32") {
    const menuBarVisible = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().some((window) => window.isMenuBarVisible()),
    );
    expect(menuBarVisible).toBe(false);
  }
  page.on("pageerror", (error) => {
    context.rendererErrors.push(error.message);
  });
  page.on("console", (message) => {
    if (message.type() === "error") context.rendererErrors.push(message.text());
  });
  await page.waitForLoadState("domcontentloaded");
  await expect(page.getByRole("heading", { name: "Gateway" })).toBeVisible();
  await app.context().tracing.start({
    screenshots: true,
    snapshots: true,
    sources: true,
  });
  const session = { app, page };
  context.session = session;
  return session;
}

interface ChildResult {
  code: number | null;
  stdout: Buffer;
  stderr: string;
}

async function runPackagedProcess(
  context: LaneTestContext,
  executable: string,
  args: string[],
  input?: Buffer,
  extraEnv: NodeJS.ProcessEnv = {},
  options: { closeStdout?: boolean } = {},
): Promise<ChildResult> {
  return await new Promise<ChildResult>((resolveChild, rejectChild) => {
    const child = spawn(executable, args, {
      env: e2eEnvironment({
        LANE_DISABLE_AUTO_UPDATE: "1",
        LANE_E2E_USER_DATA: context.userData,
        LANE_E2E_SECRET_KEY: context.secretKey,
        LANE_CONTROL_SOCKET: context.controlSocket,
        ...extraEnv,
      }),
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill();
      rejectChild(new Error(`Packaged process timed out: ${executable} ${args.join(" ")}`));
    }, 15_000);
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    if (options.closeStdout) child.stdout.destroy();
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      rejectChild(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      resolveChild({ code, stdout: Buffer.concat(stdout), stderr });
    });
    child.stdin.end(input);
  });
}

function cliExecutable(): { executable: string; env: NodeJS.ProcessEnv } {
  const appExecutable = packagedExecutable();
  if (process.platform === "darwin") {
    return {
      executable: resolve(
        dirname(appExecutable),
        "../Resources/bin/lane",
      ),
      env: {},
    };
  }
  return {
    executable: appExecutable,
    env: { LANE_BE_CLI: "1" },
  };
}

function nativeFrame(value: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  const frame = Buffer.allocUnsafe(4 + payload.length);
  frame.writeUInt32LE(payload.length, 0);
  payload.copy(frame, 4);
  return frame;
}

function decodeNativeFrame(frame: Buffer): unknown {
  expect(frame.length).toBeGreaterThanOrEqual(4);
  const length = frame.readUInt32LE(0);
  expect(frame.length).toBe(4 + length);
  return JSON.parse(frame.subarray(4).toString("utf8"));
}

async function closeLane(
  context: LaneTestContext,
  testInfo: TestInfo,
  retainFailureDiagnostics = true,
): Promise<void> {
  const session = context.session;
  if (!session) return;
  const failed =
    retainFailureDiagnostics && testInfo.status !== testInfo.expectedStatus;
  try {
    if (failed && !session.page.isClosed()) {
      await testInfo.attach("lane-window", {
        body: await session.page.screenshot(),
        contentType: "image/png",
      });
    }
    if (failed) {
      await testInfo.attach("lane-process-exit", {
        body: Buffer.from(JSON.stringify(context.appExit ?? { state: "running" })),
        contentType: "application/json",
      });
    }
    if (failed) {
      const tracePath = testInfo.outputPath("trace.zip");
      await session.app.context().tracing.stop({ path: tracePath }).catch(() => undefined);
      await testInfo.attach("trace", {
        path: tracePath,
        contentType: "application/zip",
      }).catch(() => undefined);
    } else {
      await session.app.context().tracing.stop().catch(() => undefined);
    }
  } finally {
    await session.app.close().catch(() => undefined);
    context.session = undefined;
  }
}

async function connectMockProvider(page: Page, upstream: MockOpenAI): Promise<void> {
  await page.getByRole("button", { name: "Add provider" }).click();
  const dialog = page.getByRole("dialog", { name: "Add provider" });
  await dialog.locator('[data-slot="select-trigger"]').click();
  await page.getByRole("option", { name: /Custom endpoint/ }).click();
  await dialog.getByLabel("Display name").fill("Mock");
  await dialog.getByLabel("Base URL").fill(upstream.baseUrl);
  await dialog.getByLabel("API key").fill("mock-upstream-key");
  await dialog.getByRole("button", { name: "Test and connect" }).click();
  await expect(page.getByText("Connected · 2 models")).toBeVisible();
  await expect(page.getByText("Mock", { exact: true })).toBeVisible();

  await page.getByRole("combobox", { name: "Default model" }).click();
  await page.getByRole("option", { name: "mock-model", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "Default model" })).toContainText(
    "mock-model",
  );
}

async function restartWithCodexProvider(
  context: LaneTestContext,
  testInfo: TestInfo,
): Promise<LaneSession> {
  await closeLane(context, testInfo, false);
  const settingsPath = join(context.userData, "settings.json");
  const settings = JSON.parse(await readFile(settingsPath, "utf8")) as Record<
    string,
    unknown
  >;
  await writeFile(
    settingsPath,
    `${JSON.stringify(
      {
        ...settings,
        providers: [
          {
            id: "openai-codex",
            kind: "openai-codex",
            name: "ChatGPT / Codex",
            models: [],
            createdAt: Date.now(),
          },
        ],
        defaultModel: "openai-codex/gpt-5.6-luna",
        defaultImageModel: "openai-codex/gpt-image-2",
        reasoningEffort: "high",
        speedMode: "standard",
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  return await launchLane(context, testInfo);
}

async function startGateway(page: Page): Promise<{ apiBaseUrl: string; clientKey: string }> {
  const gateway = page.getByRole("switch", { name: "Local gateway" });
  await gateway.click();
  await expect(gateway).toBeChecked();
  await page.getByRole("button", { name: "Reveal client key" }).click();
  const apiBaseUrl =
    (await page.getByLabel("API base URL value").textContent())?.trim() ?? "";
  const clientKey =
    (await page.getByLabel("Client key value").textContent())?.trim() ?? "";
  expect(apiBaseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/);
  expect(clientKey.length).toBeGreaterThan(30);
  return { apiBaseUrl, clientKey };
}

function headers(clientKey: string, origin?: string): Record<string, string> {
  return {
    Authorization: `Bearer ${clientKey}`,
    "Content-Type": "application/json",
    ...(origin ? { Origin: origin } : {}),
  };
}

test.describe("Lane packaged product journeys", () => {
  let context: LaneTestContext;

  test.beforeEach(async ({ browserName: _browserName }, testInfo) => {
    context = await createContext();
    await launchLane(context, testInfo);
  });

  test.afterEach(async ({ browserName: _browserName }, testInfo) => {
    try {
      await closeLane(context, testInfo);
      if (testInfo.status === testInfo.expectedStatus) {
        expect(context.rendererErrors).toEqual([]);
      }
    } finally {
      await context.upstream.close();
      await rm(context.userData, { recursive: true, force: true });
    }
  });

  test("connects a provider in the UI and serves every public API", async () => {
    const page = context.session!.page;
    await connectMockProvider(page, context.upstream);
    const { apiBaseUrl, clientKey } = await startGateway(page);
    await page.getByRole("button", { name: "Open Activity" }).click();
    const activity = page.getByRole("region", { name: "Activity" });
    const capture = activity.getByRole("switch", {
      name: "Capture raw request and response bodies",
    });
    await capture.click();
    await expect(capture).toBeChecked();
    await page.getByRole("button", { name: "Show Overview" }).click();

    const health = await fetch(`${apiBaseUrl.replace(/\/v1$/, "")}/health`, {
      headers: headers(clientKey),
    });
    expect(health.status).toBe(200);

    const models = await fetch(`${apiBaseUrl}/models`, {
      headers: headers(clientKey),
    });
    expect(models.status).toBe(200);
    const modelData = (await models.json() as any).data;
    expect(modelData).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: expect.stringContaining("mock-model") }),
        expect.objectContaining({ id: expect.stringContaining("mock-image") }),
      ]),
    );

    const responses = await fetch(`${apiBaseUrl}/responses`, {
      method: "POST",
      headers: headers(clientKey),
      body: JSON.stringify({ input: "hello" }),
    });
    expect(responses.status).toBe(200);
    expect((await responses.json() as any).output_text).toBe("hello from mock");

    const responsesStream = await fetch(`${apiBaseUrl}/responses`, {
      method: "POST",
      headers: headers(clientKey),
      body: JSON.stringify({ input: "hello", stream: true }),
    });
    expect(responsesStream.status).toBe(200);
    const responsesEvents = await responsesStream.text();
    expect(responsesEvents).toContain("event: response.output_text.delta");
    expect(responsesEvents).toContain("event: response.completed");

    const chat = await fetch(`${apiBaseUrl}/chat/completions`, {
      method: "POST",
      headers: headers(clientKey),
      body: JSON.stringify({
        messages: [{ role: "user", content: "hello" }],
      }),
    });
    expect(chat.status).toBe(200);
    expect((await chat.json() as any).choices[0].message.content).toBe(
      "hello from mock",
    );

    const chatStream = await fetch(`${apiBaseUrl}/chat/completions`, {
      method: "POST",
      headers: headers(clientKey),
      body: JSON.stringify({
        messages: [{ role: "user", content: "hello" }],
        stream: true,
      }),
    });
    expect(chatStream.status).toBe(200);
    const chatEvents = await chatStream.text();
    expect(chatEvents).toContain('"object":"chat.completion.chunk"');
    expect(chatEvents).toContain("data: [DONE]");

    const image = await fetch(`${apiBaseUrl}/images/generations`, {
      method: "POST",
      headers: headers(clientKey),
      body: JSON.stringify({ prompt: "draw a lane" }),
    });
    expect(image.status).toBe(200);
    expect((await image.json() as any).data[0].b64_json).toBeTruthy();

    expect(
      context.upstream.requests.every(
        (request) => request.authorization === "Bearer mock-upstream-key",
      ),
    ).toBe(true);

    await page.getByRole("button", { name: "Open Activity" }).click();
    const scrollViewport = page.locator('[data-slot="scroll-area-viewport"]');
    const activityOverflow = await scrollViewport.evaluate((element) => ({
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
      scrollTop: element.scrollTop,
    }));
    expect(activityOverflow.scrollHeight).toBeGreaterThan(activityOverflow.clientHeight);
    expect(activityOverflow.scrollTop).toBe(0);
    await scrollViewport.hover();
    await page.mouse.wheel(0, 800);
    await expect.poll(() =>
      scrollViewport.evaluate((element) => element.scrollTop),
    ).toBeGreaterThan(0);
    await scrollViewport.evaluate((element) => element.scrollTo({ top: 0 }));
    await expect(activity.getByText("/v1/responses", { exact: true }).first()).toBeVisible();
    await expect(activity.getByText(/mock-model/).first()).toBeVisible();
    await expect(activity.getByText(/\d+ in · \d+ out/).first()).toBeVisible();
    await expect(activity.getByText("/v1/images/generations", { exact: true })).toBeVisible();
    await expect(activity.getByText(/1 image/).first()).toBeVisible();
    await activity
      .getByRole("button", { name: /POST.*\/v1\/responses.*200/ })
      .first()
      .click();
    await expect(activity.getByRole("tab", { name: "Request" })).toBeVisible();
    const requestPanel = activity.getByRole("tabpanel", { name: "Request" });
    await expect(requestPanel.getByLabel("Captured body")).toContainText('"input": "hello"');
    await activity.getByRole("tab", { name: "Response" }).click();
    const responsePanel = activity.getByRole("tabpanel", { name: "Response" });
    await expect(activity.getByText(/response events/)).toBeVisible();
    await expect(activity.getByRole("button", { name: /Generated text/ })).toBeVisible();
    await expect(responsePanel.getByLabel("Captured body")).toContainText("hello from mock");
    await responsePanel.getByRole("button", { name: "Raw" }).click();
    await expect(responsePanel.getByLabel("Captured body")).toContainText("hello from mock");
    await activity.getByRole("button", { name: "Clear activity" }).click();
    await expect(activity.getByText("No recent activity", { exact: true })).toBeVisible();
  });

  test("copies an endpoint cURL and exposes Quit in the menu bar", async () => {
    const { app, page } = context.session!;
    const { apiBaseUrl, clientKey } = await startGateway(page);
    await app.evaluate(({ clipboard }) => {
      const capture = globalThis as typeof globalThis & { laneE2eClipboard?: string };
      capture.laneE2eClipboard = "";
      clipboard.writeText = (text: string) => {
        capture.laneE2eClipboard = text;
      };
    });

    await page.getByRole("button", { name: "View API endpoints" }).click();
    await expect(page.getByText("Not tested", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Test connection" }).click();
    await expect(page.getByText("Ready", { exact: true })).toBeVisible();
    await expect(page.getByText("The model returned a successful response")).toBeVisible();
    await expect(page.getByRole("button", { name: "Test again" })).toBeVisible();
    const copyModelsCurl = page.getByRole("button", { name: "Copy Models cURL" });
    await copyModelsCurl.click();
    await expect(copyModelsCurl).toContainText("Copied");
    const copied = await app.evaluate(() =>
      (globalThis as typeof globalThis & { laneE2eClipboard?: string })
        .laneE2eClipboard,
    );
    expect(copied).toBe(
      `curl --fail-with-body '${apiBaseUrl}/models' \\
  -H 'Authorization: Bearer ${clientKey}'`,
    );

    await page.evaluate(() => window.lane.setMenuBarIconVisible(true));
    await expect.poll(() => app.windows().length).toBe(2);
    const menubarPage = app.windows().find((candidate) =>
      candidate.url().includes("menubar.html"),
    );
    expect(menubarPage).toBeDefined();
    await expect(menubarPage!.getByRole("button", { name: "Open Lane" })).toBeVisible();
    await expect(menubarPage!.getByRole("button", { name: "Quit Lane" })).toBeVisible();
  });

  test("opens exactly one Settings panel through the packaged platform controls", async () => {
    const { app, page } = context.session!;

    if (process.platform === "darwin") {
      const menuLabels = await app.evaluate(({ Menu }) =>
        Menu.getApplicationMenu()?.items[0]?.submenu?.items.map((item) => item.label) ?? [],
      );
      expect(menuLabels).toEqual(
        expect.arrayContaining(["About Lane", "Settings…", "Check for Updates…", "Quit Lane"]),
      );

      await app.evaluate(({ BrowserWindow, Menu }) => {
        const settings = Menu.getApplicationMenu()?.items[0]?.submenu?.items.find(
          (item) => item.label === "Settings…",
        );
        if (!settings?.click) throw new Error("Packaged Settings menu item is unavailable");
        settings.click(settings, BrowserWindow.getFocusedWindow(), {} as KeyboardEvent);
      });
    } else {
      await page.getByRole("button", { name: "Open Settings" }).click();
    }

    await expect(page.getByText("Theme", { exact: true })).toHaveCount(1);
    await expect(page.getByRole("switch", { name: /Show Lane in (Dock|taskbar)/ })).toHaveCount(1);
    await expect.poll(() =>
      app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().some((window) => window.isVisible()),
      )
    ).toBe(false);

    if (process.platform === "darwin") {
      const message = await app.evaluate(async ({ BrowserWindow, Menu, dialog }) => {
        const capture = globalThis as typeof globalThis & {
          laneE2EUpdateMessage: string | undefined;
        };
        capture.laneE2EUpdateMessage = undefined;
        const original = dialog.showMessageBox;
        dialog.showMessageBox = (async (...args) => {
          const options = args.at(-1);
          if (
            typeof options !== "object" ||
            options === null ||
            !("message" in options) ||
            typeof options.message !== "string"
          ) {
            throw new Error("Packaged update dialog options are unavailable");
          }
          capture.laneE2EUpdateMessage = options.message;
          return { response: 0, checkboxChecked: false };
        }) as typeof dialog.showMessageBox;
        try {
          const update = Menu.getApplicationMenu()?.items[0]?.submenu?.items.find(
            (item) => item.label === "Check for Updates…",
          );
          if (!update?.click) throw new Error("Packaged update menu item is unavailable");
          update.click(update, BrowserWindow.getFocusedWindow(), {} as KeyboardEvent);
          await new Promise((resolve) => setTimeout(resolve, 50));
          return capture.laneE2EUpdateMessage;
        } finally {
          dialog.showMessageBox = original;
        }
      });
      expect(message).toBe("Updates are unavailable in this build.");
    }
  });

  test("fits the default window and changes model defaults in the UI", async (
    { browserName: _browserName },
    testInfo,
  ) => {
    let { page } = await restartWithCodexProvider(context, testInfo);
    const effort = page.getByRole("combobox", { name: "Effort" });
    const speed = page.getByRole("combobox", { name: "Speed" });
    await expect(effort).toContainText("High");
    await expect(speed).toContainText("Standard");

    await page.getByRole("button", { name: "Open Settings" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(1);
    await expect(page.getByRole("combobox", { name: "Theme" })).toHaveCount(1);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);

    const overviewOverflow = await page
      .locator('[data-slot="scroll-area-viewport"]')
      .evaluate((element) => ({
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
      }));
    expect(overviewOverflow.scrollHeight).toBeLessThanOrEqual(
      overviewOverflow.clientHeight,
    );

    await effort.click();
    const ultraOption = page.getByRole("option", { name: "Ultra" });
    await ultraOption.click();
    await expect(effort).toContainText("Ultra");
    await expect(ultraOption).not.toBeVisible();

    await speed.click();
    const fastOption = page.getByRole("option", { name: /Fast/ });
    await fastOption.click();
    await expect(speed).toContainText("Fast");
    await expect(fastOption).not.toBeVisible();
    const speedScreenshot = testInfo.outputPath("speed-fast.png");
    await page.screenshot({ path: speedScreenshot });
    await testInfo.attach("speed-fast", {
      path: speedScreenshot,
      contentType: "image/png",
    });

    await closeLane(context, testInfo, false);
    ({ page } = await launchLane(context, testInfo));
    await expect(page.getByRole("combobox", { name: "Effort" })).toContainText(
      "Ultra",
    );
    await expect(page.getByRole("combobox", { name: "Speed" })).toContainText(
      "Fast",
    );
  });

  test("adapts the overview and activity workspace to a wide window", async ({
    browserName: _browserName,
  }, testInfo) => {
    const { app, page } = context.session!;
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setSize(1440, 900);
    });
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBeGreaterThan(1300);

    const gatewayBox = await page.locator('[data-lane-section="gateway"]').boundingBox();
    const providersBox = await page.locator('[data-lane-section="providers"]').boundingBox();
    const modelsBox = await page.locator('[data-lane-section="models"]').boundingBox();
    expect(gatewayBox).not.toBeNull();
    expect(providersBox).not.toBeNull();
    expect(modelsBox).not.toBeNull();
    expect(Math.abs(gatewayBox!.y - providersBox!.y)).toBeLessThan(8);
    expect(providersBox!.x).toBeGreaterThan(gatewayBox!.x + gatewayBox!.width);
    expect(Math.abs(modelsBox!.x - gatewayBox!.x)).toBeLessThan(2);
    expect(Math.abs(modelsBox!.width - gatewayBox!.width)).toBeLessThan(2);
    expect(modelsBox!.y).toBeGreaterThan(gatewayBox!.y + gatewayBox!.height);

    const overviewScreenshot = testInfo.outputPath("responsive-wide-overview.png");
    await page.screenshot({ path: overviewScreenshot });
    await testInfo.attach("responsive-wide-overview", {
      path: overviewScreenshot,
      contentType: "image/png",
    });

    await page.getByRole("button", { name: "Open Activity" }).click();
    const activityBox = await page.getByRole("region", { name: "Activity" }).boundingBox();
    expect(activityBox).not.toBeNull();
    expect(activityBox!.width).toBeGreaterThan(900);
    expect(activityBox!.width).toBeLessThanOrEqual(1152);

    const responsiveScreenshot = testInfo.outputPath("responsive-wide-window.png");
    await page.screenshot({ path: responsiveScreenshot });
    await testInfo.attach("responsive-wide-window", {
      path: responsiveScreenshot,
      contentType: "image/png",
    });
  });

  test("enforces the client boundary and maps upstream failures", async () => {
    const page = context.session!.page;
    await connectMockProvider(page, context.upstream);
    const { apiBaseUrl, clientKey } = await startGateway(page);

    const missingKey = await fetch(`${apiBaseUrl}/models`);
    expect(missingKey.status).toBe(401);

    const wrongKey = await fetch(`${apiBaseUrl}/models`, {
      headers: headers("wrong-key"),
    });
    expect(wrongKey.status).toBe(401);

    const forbiddenOrigin = await fetch(`${apiBaseUrl}/models`, {
      headers: headers(clientKey, "https://untrusted.example"),
    });
    expect(forbiddenOrigin.status).toBe(403);

    const upstreamFailure = await fetch(`${apiBaseUrl}/chat/completions`, {
      method: "POST",
      headers: headers(clientKey),
      body: JSON.stringify({
        messages: [{ role: "user", content: "upstream-error" }],
      }),
    });
    expect(upstreamFailure.status).toBe(502);
    const error = (await upstreamFailure.json() as any).error;
    expect(error.type).toBe("provider_error");
    expect(JSON.stringify(error)).not.toContain("mock upstream exploded");
    expect(JSON.stringify(error)).not.toContain("mock-upstream-key");

    const controller = new AbortController();
    const slow = await fetch(`${apiBaseUrl}/chat/completions`, {
      method: "POST",
      headers: headers(clientKey),
      signal: controller.signal,
      body: JSON.stringify({
        messages: [{ role: "user", content: "slow-stream" }],
        stream: true,
      }),
    });
    const reader = slow.body!.getReader();
    await reader.read();
    controller.abort();
    await expect(reader.read()).rejects.toThrow();
    await expect
      .poll(() => context.upstream.abortedRequests)
      .toBeGreaterThan(0);
  });

  test("serves the packaged CLI", async () => {
    const page = context.session!.page;
    if (process.platform === "win32") {
      await page.getByRole("button", { name: "Open Settings" }).click();
      const settings = page.getByRole("dialog");
      await settings.getByRole("button", { name: "Install…" }).click();
      await expect(settings.getByText("Installed", { exact: true })).toBeVisible();
      await expect.poll(() => readFile(context.cliCommandPath, "utf8")).toContain(
        "@rem Lane CLI launcher v1",
      );
      const version = await runPackagedProcess(
        context,
        process.env.ComSpec ?? "cmd.exe",
        ["/d", "/c", context.cliCommandPath, "--version"],
      );
      expect(version.code, version.stderr).toBe(0);
      const packageVersion = JSON.parse(
        await readFile(resolve("package.json"), "utf8"),
      ) as { version: string };
      expect(version.stdout.toString("utf8")).toContain(packageVersion.version);
      await page.keyboard.press("Escape");
    }
    await connectMockProvider(page, context.upstream);
    const { apiBaseUrl } = await startGateway(page);

    const cli = cliExecutable();
    const status = await runPackagedProcess(
      context,
      cli.executable,
      ["status", "--json", "--no-input"],
      undefined,
      cli.env,
    );
    expect(status.code, status.stderr).toBe(0);
    const statusData = JSON.parse(status.stdout.toString("utf8")) as {
      gateway: { running: boolean; api_base_url: string };
      default_model: string;
      providers: { connected: number; total: number };
    };
    expect(statusData).toMatchObject({
      gateway: {
        running: true,
        api_base_url: apiBaseUrl,
      },
      providers: {
        connected: 1,
        total: 1,
      },
    });
    expect(statusData.default_model).toMatch(/\/mock-model$/);

    const setSpeed = await runPackagedProcess(
      context,
      cli.executable,
      ["models", "set-speed", "--speed", "fast", "--json", "--no-input"],
      undefined,
      cli.env,
    );
    expect(setSpeed.code, setSpeed.stderr).toBe(0);
    expect(JSON.parse(setSpeed.stdout.toString("utf8"))).toEqual({
      speed_mode: "fast",
    });

    const updatedStatus = await runPackagedProcess(
      context,
      cli.executable,
      ["status", "--json", "--no-input"],
      undefined,
      cli.env,
    );
    expect(updatedStatus.code, updatedStatus.stderr).toBe(0);
    expect(JSON.parse(updatedStatus.stdout.toString("utf8"))).toMatchObject({
      speed_mode: "fast",
    });

    const models = await runPackagedProcess(
      context,
      cli.executable,
      ["models", "--json", "--no-input"],
      undefined,
      cli.env,
    );
    expect(models.code, models.stderr).toBe(0);
    const modelData = JSON.parse(models.stdout.toString("utf8")) as Array<{
      id: string;
    }>;
    expect(modelData).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: statusData.default_model }),
        expect.objectContaining({ id: expect.stringMatching(/\/mock-image$/) }),
      ]),
    );

    const closedOutput = await runPackagedProcess(
      context,
      cli.executable,
      ["status", "--json", "--no-input"],
      undefined,
      cli.env,
      { closeStdout: true },
    );
    expect(closedOutput.code, closedOutput.stderr).toBe(0);
    expect(closedOutput.stderr).not.toContain("EPIPE");
  });

  test("serves the approved browser extension through the packaged native host", async () => {
    const page = context.session!.page;
    await connectMockProvider(page, context.upstream);
    const { apiBaseUrl, clientKey } = await startGateway(page);

    const request = nativeFrame({
      protocolVersion: LANE_NATIVE_PROTOCOL_VERSION,
      type: "connect",
    });
    const native = await runPackagedProcess(
      context,
      nativeHostExecutable(),
      [TRANSLY_PRODUCTION_NATIVE_ALLOWED_ORIGIN],
      request,
    );
    const nativeResponse = decodeNativeFrame(native.stdout);
    expect(
      native.code,
      `${native.stderr}\n${JSON.stringify(nativeResponse)}`,
    ).toBe(0);
    expect(nativeResponse).toMatchObject({
      protocolVersion: LANE_NATIVE_PROTOCOL_VERSION,
      ok: true,
      data: {
        service: "lane",
        apiUrl: apiBaseUrl,
        apiKey: clientKey,
        models: expect.arrayContaining([
          expect.stringMatching(/\/mock-model$/),
          expect.stringMatching(/\/mock-image$/),
        ]),
        defaultModel: expect.stringMatching(/\/mock-model$/),
        protocol: "responses",
      },
    });
    expect(native.stdout.toString("utf8")).not.toContain("mock-upstream-key");

    const rejected = await runPackagedProcess(
      context,
      nativeHostExecutable(),
      ["chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/"],
      request,
    );
    expect(rejected.code).toBe(1);
    expect(decodeNativeFrame(rejected.stdout)).toMatchObject({
      protocolVersion: LANE_NATIVE_PROTOCOL_VERSION,
      ok: false,
      error: {
        code: "CALLER_NOT_ALLOWED",
      },
    });
    expect(rejected.stdout.toString("utf8")).not.toContain(clientKey);
    expect(rejected.stdout.toString("utf8")).not.toContain("mock-upstream-key");
  });

  test("restores configuration and gateway state after a real restart", async (
    { browserName: _browserName },
    testInfo,
  ) => {
    let page = context.session!.page;
    await connectMockProvider(page, context.upstream);
    const initial = await startGateway(page);
    await closeLane(context, testInfo, false);

    const secretsBeforeRestart = await readFile(
      join(context.userData, "secrets.json"),
      "utf8",
    );
    expect(secretsBeforeRestart).not.toContain("mock-upstream-key");
    expect(secretsBeforeRestart).not.toContain(initial.clientKey);

    ({ page } = await launchLane(context, testInfo));
    await expect(page.getByText("Mock", { exact: true })).toBeVisible();
    await expect(page.getByText("Connected · 2 models")).toBeVisible();
    await expect(page.getByRole("combobox", { name: "Default model" })).toContainText(
      "mock-model",
    );
    await expect(page.getByRole("switch", { name: "Local gateway" })).toBeChecked();

    const models = await fetch(`${initial.apiBaseUrl}/models`, {
      headers: headers(initial.clientKey),
    });
    expect(models.status).toBe(200);

    await page.getByRole("button", { name: "Remove Mock" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Remove" }).click();
    await expect(page.getByText("No providers")).toBeVisible();

    const storedSecrets = JSON.parse(
      await readFile(join(context.userData, "secrets.json"), "utf8"),
    ) as Record<string, string>;
    expect(Object.keys(storedSecrets)).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/^credential:/)]),
    );
  });

  test("changes ports only after explicit confirmation when the port is occupied", async () => {
    const occupied = createNetServer();
    await new Promise<void>((resolveListen, reject) => {
      occupied.once("error", reject);
      occupied.listen(context.gatewayPort, "127.0.0.1", resolveListen);
    });
    try {
      await context.session!.app.evaluate(({ dialog }) => {
        dialog.showMessageBox = async () => ({
          response: 0,
          checkboxChecked: false,
        });
      });
      const page = context.session!.page;
      const gateway = page.getByRole("switch", { name: "Local gateway" });
      await gateway.click();
      await expect(gateway).toBeChecked();
      const changedUrl =
        (await page.getByLabel("API base URL value").textContent())?.trim() ?? "";
      expect(changedUrl).not.toContain(`:${context.gatewayPort}/`);

      await page.getByRole("button", { name: "Reveal client key" }).click();
      const clientKey =
        (await page.getByLabel("Client key value").textContent())?.trim() ?? "";
      const health = await fetch(`${changedUrl.replace(/\/v1$/, "")}/health`, {
        headers: headers(clientKey),
      });
      expect(health.status).toBe(200);
    } finally {
      await new Promise<void>((resolveClose, reject) => {
        occupied.close((error) => (error ? reject(error) : resolveClose()));
      });
    }
  });
});
