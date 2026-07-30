import { spawn } from "node:child_process";
import { access, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

const buildArch = process.env.LANE_SMOKE_ARCH ?? "arm64";
const buildDirectory = buildArch === "x64" ? "mac" : `mac-${buildArch}`;
const executable = new URL(
  `../release/${buildDirectory}/Lane.app/Contents/MacOS/Lane`,
  import.meta.url,
).pathname;
const packagedLauncher = new URL(
  `../release/${buildDirectory}/Lane.app/Contents/Resources/bin/lane`,
  import.meta.url,
).pathname;
await access(executable);
await access(packagedLauncher);

const directory = await mkdtemp(join(tmpdir(), "lane-cli-smoke-"));
const socketPath = join(directory, "lane.sock");
const settingsPath = join(directory, "settings.json");
const launcher = join(directory, "lane");
await symlink(packagedLauncher, launcher);

const port = await new Promise((resolve, reject) => {
  const server = createNetServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (!address || typeof address === "string") {
      reject(new Error("Could not allocate a smoke-test port"));
      return;
    }
    const allocated = address.port;
    server.close((error) => (error ? reject(error) : resolve(allocated)));
  });
});

const providerServer = createHttpServer((request, response) => {
  if (
    request.url === "/v1/models" &&
    request.headers.authorization === "Bearer smoke-api-key"
  ) {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ data: [{ id: "mock-model", name: "Mock model" }] }));
    return;
  }
  response.writeHead(401, { "content-type": "application/json" });
  response.end(JSON.stringify({ error: "unauthorized" }));
});
const providerPort = await new Promise((resolve, reject) => {
  providerServer.once("error", reject);
  providerServer.listen(0, "127.0.0.1", () => {
    const address = providerServer.address();
    if (!address || typeof address === "string") {
      reject(new Error("Could not allocate a mock-provider port"));
      return;
    }
    resolve(address.port);
  });
});

await writeFile(
  settingsPath,
  `${JSON.stringify(
    {
      version: 1,
      gateway: {
        port,
        autoStart: false,
        allowedOrigins: [`http://127.0.0.1:${port}`],
      },
      providers: [],
      launchAtLogin: false,
      visibility: {
        showDockIcon: false,
        showMenuBarIcon: false,
      },
      cli: { enabled: true },
    },
    null,
    2,
  )}\n`,
  { mode: 0o600 },
);

let appOutput = "";
let appProcess;
let appExited;

function startApp() {
  appProcess = spawn(executable, [], {
    env: {
      ...process.env,
      LANE_CLI_CONTROL_ENABLED: "1",
      LANE_CLI_WAKE: "1",
      LANE_CONTROL_SOCKET: socketPath,
      LANE_TEST_USER_DATA: directory,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  appExited = new Promise((resolve) => appProcess.once("exit", resolve));
  appProcess.stdout.on("data", (chunk) => (appOutput += chunk.toString()));
  appProcess.stderr.on("data", (chunk) => (appOutput += chunk.toString()));
}

async function stopApp() {
  if (!appProcess) return;
  appProcess.kill("SIGTERM");
  let exited = false;
  await Promise.race([
    appExited.then(() => {
      exited = true;
    }),
    new Promise((resolve) => setTimeout(resolve, 3_000)),
  ]);
  if (!exited) {
    appProcess.kill("SIGKILL");
    await appExited;
  }
  appProcess = undefined;
  await rm(socketPath, { force: true });
}

async function waitForSocket() {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      await access(socketPath);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  await access(socketPath);
}

startApp();

async function runCliWithInput(args, input) {
  return await new Promise((resolve, reject) => {
    const child = spawn(launcher, args, {
      env: {
        ...process.env,
        LANE_CONTROL_SOCKET: socketPath,
        LANE_TEST_USER_DATA: directory,
      },
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    if (input !== undefined) child.stdin.end(input);
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

async function runCli(...args) {
  return await runCliWithInput(args);
}

try {
  await waitForSocket();

  const status = await runCli("status", "--json", "--no-input");
  if (status.code !== 0) throw new Error(status.stderr || status.stdout);
  const statusValue = JSON.parse(status.stdout);
  if (statusValue.gateway.running !== false) throw new Error("Gateway should start stopped");
  if (
    status.stdout.includes("clientKey") ||
    status.stdout.includes("apiKey") ||
    status.stdout.includes("credential")
  ) {
    throw new Error("CLI status exposed a secret-shaped field");
  }

  const connection = await runCli("connection", "--json", "--no-input");
  const connectionValue = JSON.parse(connection.stdout);
  if (
    connection.code !== 0 ||
    typeof connectionValue.client_key !== "string" ||
    !connectionValue.api_base_url.endsWith("/v1")
  ) {
    throw new Error(connection.stderr || connection.stdout);
  }

  const added = await runCliWithInput(
    [
      "providers",
      "add",
      "--kind",
      "custom-openai",
      "--name",
      "Mock",
      "--base-url",
      `http://127.0.0.1:${providerPort}/v1`,
      "--api-key-stdin",
      "--json",
      "--no-input",
    ],
    "smoke-api-key\n",
  );
  if (added.code !== 0 || added.stdout.includes("smoke-api-key")) {
    throw new Error(added.stderr || added.stdout);
  }

  const providers = await runCli("providers", "list", "--json", "--no-input");
  const providerValues = JSON.parse(providers.stdout);
  if (providers.code !== 0 || providerValues.length !== 1) {
    throw new Error(providers.stderr || providers.stdout);
  }
  const providerId = providerValues[0].id;

  const discovered = await runCli("models", "--json", "--no-input");
  const discoveredModels = JSON.parse(discovered.stdout);
  if (discovered.code !== 0 || discoveredModels.length !== 1) {
    throw new Error(discovered.stderr || discovered.stdout);
  }
  const modelId = discoveredModels[0].id;

  const selected = await runCli(
    "models",
    "set-default",
    "--id",
    modelId,
    "--json",
    "--no-input",
  );
  if (selected.code !== 0 || JSON.parse(selected.stdout).default_model !== modelId) {
    throw new Error(selected.stderr || selected.stdout);
  }

  const started = await runCli("start", "--json", "--no-input");
  if (started.code !== 0 || JSON.parse(started.stdout).gateway.running !== true) {
    throw new Error(started.stderr || started.stdout);
  }

  const activity = await runCli("activity", "--json", "--no-input");
  if (
    activity.code !== 0 ||
    !Array.isArray(JSON.parse(activity.stdout)) ||
    activity.stdout.includes("smoke-api-key")
  ) {
    throw new Error(activity.stderr || activity.stdout);
  }

  await new Promise((resolve) => setTimeout(resolve, 100));
  await stopApp();
  startApp();
  await waitForSocket();

  const restoredActivity = await runCli("activity", "--json", "--no-input");
  const restoredEntries = JSON.parse(restoredActivity.stdout);
  if (
    restoredActivity.code !== 0 ||
    !restoredEntries.some((entry) => entry.message === "Connected Mock; 1 models loaded")
  ) {
    throw new Error(
      restoredActivity.stderr || "Activity did not survive a packaged-app restart",
    );
  }

  const stopped = await runCli("stop", "--json", "--no-input");
  if (stopped.code !== 0 || JSON.parse(stopped.stdout).gateway.running !== false) {
    throw new Error(stopped.stderr || stopped.stdout);
  }

  const removed = await runCli(
    "providers",
    "remove",
    "--id",
    providerId,
    "--force",
    "--json",
    "--no-input",
  );
  if (removed.code !== 0 || JSON.parse(removed.stdout).providers.length !== 0) {
    throw new Error(removed.stderr || removed.stdout);
  }

  console.log(
    "Packaged Lane CLI connection/provider/model/persistent-activity/gateway smoke test passed.",
  );
} catch (error) {
  throw new Error(
    `${error instanceof Error ? error.message : String(error)}\n${appOutput}`,
    { cause: error },
  );
} finally {
  await stopApp();
  await new Promise((resolve) => providerServer.close(resolve));
  await rm(directory, { recursive: true, force: true });
}
