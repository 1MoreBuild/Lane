import { spawn, spawnSync } from "node:child_process";
import {
  access,
  mkdtemp,
  open,
  readdir,
  realpath,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";

if (process.platform !== "win32") {
  throw new Error("Installed NSIS E2E must run on Windows");
}
if (process.arch !== "x64" && process.arch !== "arm64") {
  throw new Error(`Unsupported Windows E2E architecture: ${process.arch}`);
}

const pkg = (await import("../package.json", { with: { type: "json" } })).default;
const installer = resolve(`release/Lane-${pkg.version}-windows-setup.exe`);
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error("npm_execpath is required to run installed product E2E");

function e2eEnvironment(extra = {}) {
  const inherited = Object.fromEntries(
    [
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
      "CI",
      "NO_COLOR",
      "FORCE_COLOR",
    ].flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]]]),
  );
  return { ...inherited, ...extra };
}

function requireSuccess(result, label) {
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${label} failed with exit code ${result.status}:\n${result.stdout ?? ""}\n${result.stderr ?? ""}`,
    );
  }
}

function assertNoExistingLaneInstallation(environment) {
  const systemRoot = environment.SystemRoot ?? environment.WINDIR;
  if (!systemRoot) throw new Error("SystemRoot is required for Windows installed E2E");
  const reg = join(systemRoot, "System32", "reg.exe");
  const uninstallRoots = [
    "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
    "HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
    "HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
  ];
  const laneDisplayName = /^\s*DisplayName\s+REG_\w+\s+Lane(?:\s+\d+(?:\.\d+)*)?\s*$/im;

  for (const root of uninstallRoots) {
    const checked = spawnSync(reg, ["query", root, "/s", "/v", "DisplayName"], {
      encoding: "utf8",
      env: environment,
      timeout: 30_000,
      windowsHide: true,
    });
    if (checked.error) throw checked.error;
    if (checked.status !== 0 && checked.status !== 1) {
      requireSuccess(checked, `Existing Lane installation check for ${root}`);
    }
    if (laneDisplayName.test(checked.stdout ?? "")) {
      throw new Error(`Refusing to run installed E2E while Lane is already installed in ${root}`);
    }
  }
}

function installedLaneDirectories(environment) {
  const systemRoot = environment.SystemRoot ?? environment.WINDIR;
  if (!systemRoot) throw new Error("SystemRoot is required for Windows installed E2E");
  const reg = join(systemRoot, "System32", "reg.exe");
  const uninstallRoots = [
    "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
    "HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
    "HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
  ];
  const directories = new Set();

  for (const root of uninstallRoots) {
    const queried = spawnSync(reg, ["query", root, "/s"], {
      encoding: "utf8",
      env: environment,
      timeout: 30_000,
      windowsHide: true,
    });
    if (queried.error) throw queried.error;
    if (queried.status !== 0 && queried.status !== 1) {
      requireSuccess(queried, `Lane installation discovery for ${root}`);
    }

    const blocks = (queried.stdout ?? "").split(/(?=^HKEY_)/m);
    for (const block of blocks) {
      if (!/^\s*DisplayName\s+REG_\w+\s+Lane(?:\s+\d+(?:\.\d+)*)?\s*$/im.test(block)) {
        continue;
      }
      const displayIcon = block.match(/^\s*DisplayIcon\s+REG_\w+\s+(.+?)(?:,\d+)?\s*$/im)?.[1];
      const uninstall = block.match(/^\s*(?:Quiet)?UninstallString\s+REG_\w+\s+(.+)$/im)?.[1];
      const executable = displayIcon?.replace(/^"|"$/g, "")
        ?? uninstall?.match(/^"([^"]+)"/)?.[1];
      if (executable) directories.add(dirname(executable));
    }
  }

  return [...directories];
}

async function resolveInstalledDirectory(environment, requestedDirectory) {
  let discoveredDirectories = [];
  for (let attempt = 0; attempt < 60; attempt += 1) {
    discoveredDirectories = installedLaneDirectories(environment);
    for (const candidate of new Set([requestedDirectory, ...discoveredDirectories])) {
      try {
        await access(join(candidate, "Lane.exe"));
        return candidate;
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
    await delay(1_000);
  }
  throw new Error(
    `NSIS installation did not create Lane.exe in ${requestedDirectory}`
      + (discoveredDirectories.length > 0
        ? ` or the registered directories: ${discoveredDirectories.join(", ")}`
        : " and did not register an alternate installation directory"),
  );
}

async function peArchitecture(path) {
  const file = await open(path, "r");
  try {
    const dosHeader = Buffer.alloc(64);
    await file.read(dosHeader, 0, dosHeader.length, 0);
    const peOffset = dosHeader.readUInt32LE(0x3c);
    const peHeader = Buffer.alloc(6);
    await file.read(peHeader, 0, peHeader.length, peOffset);
    if (peHeader.subarray(0, 4).toString("binary") !== "PE\0\0") {
      throw new Error(`${path} is not a PE executable`);
    }
    const machine = peHeader.readUInt16LE(4);
    if (machine === 0x8664) return "x64";
    if (machine === 0xaa64) return "arm64";
    throw new Error(`Unsupported PE machine 0x${machine.toString(16)} in ${path}`);
  } finally {
    await file.close();
  }
}

const environment = e2eEnvironment();
assertNoExistingLaneInstallation(environment);
const temporaryRoot = await realpath(tmpdir());
const directory = await mkdtemp(join(temporaryRoot, "lane-nsis-e2e-"));
const requestedInstalledDirectory = join(directory, "Lane");
let installedDirectory = requestedInstalledDirectory;
let installedExecutable;
let runError;
try {
  await access(installer);
  const installed = spawnSync(installer, ["/S", `/D=${requestedInstalledDirectory}`], {
    env: environment,
    stdio: "ignore",
    timeout: 300_000,
    windowsHide: true,
  });
  requireSuccess(installed, "NSIS installation");
  installedDirectory = await resolveInstalledDirectory(environment, requestedInstalledDirectory);
  installedExecutable = join(installedDirectory, "Lane.exe");

  const architecture = await peArchitecture(installedExecutable);
  if (architecture !== process.arch) {
    throw new Error(
      `NSIS installed ${architecture} Lane.exe on a ${process.arch} Windows runner`,
    );
  }
  console.log(`Installed ${architecture} Lane.exe from ${basename(installer)}`);

  const child = spawn(process.execPath, [npmCli, "run", "e2e"], {
    env: e2eEnvironment({ LANE_E2E_APP_PATH: installedExecutable }),
    stdio: "inherit",
    windowsHide: true,
  });
  const exitCode = await new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolveExit(code ?? 1));
  });
  if (exitCode !== 0) {
    throw new Error(`Installed Windows product E2E failed with exit code ${exitCode}`);
  }
} catch (error) {
  runError = error;
}

let cleanupError;
try {
  const entries = await readdir(installedDirectory);
  const uninstallerName = entries.find((name) => /^uninstall.*\.exe$/i.test(name));
  if (!uninstallerName) throw new Error("Installed Lane package has no NSIS uninstaller");
  const uninstalled = spawnSync(
    join(installedDirectory, uninstallerName),
    ["/S", `_?=${installedDirectory}`],
    {
      env: environment,
      stdio: "ignore",
      timeout: 300_000,
      windowsHide: true,
    },
  );
  requireSuccess(uninstalled, "NSIS uninstallation");
} catch (error) {
  if (error?.code !== "ENOENT") cleanupError = error;
}
try {
  const resolvedDirectory = resolve(directory);
  if (resolvedDirectory === temporaryRoot || !resolvedDirectory.startsWith(`${temporaryRoot}\\`)) {
    throw new Error(`Refusing to remove unsafe Windows E2E directory: ${resolvedDirectory}`);
  }
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      await rm(resolvedDirectory, { recursive: true, force: true });
      break;
    } catch (error) {
      const retryable = ["EBUSY", "ENOTEMPTY", "EPERM"].includes(error?.code);
      if (!retryable || attempt === 59) throw error;
      await delay(500);
    }
  }
} catch (error) {
  cleanupError ??= error;
}

if (runError && cleanupError) {
  throw new AggregateError([runError, cleanupError], "Windows NSIS E2E and cleanup both failed");
}
if (runError) throw runError;
if (cleanupError) throw cleanupError;
