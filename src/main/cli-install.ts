import { execFile } from "node:child_process";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";
import type { CliIntegrationState } from "../shared/contracts.ts";

const execFileAsync = promisify(execFile);
export const CLI_LINK_PATHS = ["/usr/local/bin/lane", "/opt/homebrew/bin/lane"] as const;
export const WINDOWS_CLI_MARKER = "@rem Lane CLI launcher v1";
export const LANE_BUNDLE_IDENTIFIER = "works.earendil.lane";

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function appleScriptString(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

async function isLinkTo(path: string, targetPath: string): Promise<boolean> {
  try {
    const entry = await lstat(path);
    if (!entry.isSymbolicLink()) return false;
    return (await realpath(path)) === (await realpath(targetPath));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function laneAppBundleForTarget(targetPath: string): string | undefined {
  const match = /^(.*\.app)\/Contents\/(?:MacOS\/Lane|Resources\/bin\/lane)$/.exec(
    targetPath,
  );
  return match?.[1];
}

async function defaultReadBundleIdentifier(
  appPath: string,
): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("/usr/bin/plutil", [
      "-extract",
      "CFBundleIdentifier",
      "raw",
      "-o",
      "-",
      `${appPath}/Contents/Info.plist`,
    ]);
    const identifier = stdout.trim();
    return identifier || undefined;
  } catch {
    return undefined;
  }
}

function windowsBatchPath(value: string): string {
  if (/[\r\n"]/.test(value)) throw new Error("Lane executable path cannot be used by cmd.exe");
  return value.replaceAll("%", "%%");
}

export function windowsCliLauncher(nativeLauncherPath: string): string {
  return [
    WINDOWS_CLI_MARKER,
    "@echo off",
    `"${windowsBatchPath(nativeLauncherPath)}" %*`,
    "exit /b %ERRORLEVEL%",
    "",
  ].join("\r\n");
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export interface CliInstallerOptions {
  executablePath: string;
  launcherPath: string;
  platform?: NodeJS.Platform;
  linkPaths?: readonly string[];
  windowsCommandPath?: string;
  windowsNativeLauncherPath?: string;
  runPrivileged?: (command: string) => Promise<void>;
  readBundleIdentifier?: (appPath: string) => Promise<string | undefined>;
}

export interface CliIntegrationInstaller {
  getState(enabled: boolean): Promise<CliIntegrationState>;
  install(): Promise<CliIntegrationState>;
}

export async function restoreEnabledCliIntegration(
  installer: CliIntegrationInstaller,
  enabled: boolean,
): Promise<void> {
  if (!enabled) return;
  const state = await installer.getState(true);
  if (!state.installed) await installer.install();
}

export class CliInstaller {
  private readonly executablePath: string;
  private readonly launcherPath: string;
  private readonly platform: NodeJS.Platform;
  private readonly linkPaths: readonly string[];
  private readonly windowsCommandPath: string | undefined;
  private readonly windowsNativeLauncherPath: string | undefined;
  private readonly runPrivileged: (command: string) => Promise<void>;
  private readonly readBundleIdentifier: (
    appPath: string,
  ) => Promise<string | undefined>;

  constructor(options: CliInstallerOptions) {
    this.executablePath = options.executablePath;
    this.launcherPath = options.launcherPath;
    this.platform = options.platform ?? process.platform;
    this.linkPaths = options.linkPaths ?? CLI_LINK_PATHS;
    this.windowsCommandPath = options.windowsCommandPath;
    this.windowsNativeLauncherPath = options.windowsNativeLauncherPath;
    this.readBundleIdentifier =
      options.readBundleIdentifier ?? defaultReadBundleIdentifier;
    this.runPrivileged =
      options.runPrivileged ??
      (async (command) => {
        await execFileAsync("/usr/bin/osascript", [
          "-e",
          `do shell script "${appleScriptString(command)}" with administrator privileges`,
        ]);
      });
  }

  private async isOwnedMacLink(path: string): Promise<boolean> {
    const entry = await lstat(path);
    if (!entry.isSymbolicLink()) return false;
    if (
      (await isLinkTo(path, this.launcherPath)) ||
      (await isLinkTo(path, this.executablePath))
    ) {
      return true;
    }
    let target: string;
    try {
      target = await realpath(path);
    } catch {
      return false;
    }
    const appPath = laneAppBundleForTarget(target);
    if (!appPath) return false;
    return (await this.readBundleIdentifier(appPath)) === LANE_BUNDLE_IDENTIFIER;
  }

  async getState(enabled: boolean): Promise<CliIntegrationState> {
    if (this.platform === "win32") {
      if (!this.windowsCommandPath || !this.windowsNativeLauncherPath) {
        return {
          enabled,
          installed: false,
          command: "lane",
          error: "Windows command installation directory is unavailable.",
        };
      }
      const contents = await readOptional(this.windowsCommandPath);
      if (contents === undefined) return { enabled, installed: false, command: "lane" };
      if (contents === windowsCliLauncher(this.windowsNativeLauncherPath)) {
        return {
          enabled,
          installed: true,
          command: "lane",
          path: this.windowsCommandPath,
        };
      }
      return {
        enabled,
        installed: false,
        command: "lane",
        error: contents.startsWith(WINDOWS_CLI_MARKER)
          ? "The Lane command needs to be reinstalled."
          : `Another command already exists at ${this.windowsCommandPath}`,
      };
    }
    if (this.platform !== "darwin") {
      return {
        enabled,
        installed: false,
        command: "lane",
        error: "CLI installation is currently available on macOS only.",
      };
    }
    for (const path of this.linkPaths) {
      if (await isLinkTo(path, this.launcherPath)) {
        return { enabled, installed: true, command: "lane", path };
      }
    }
    return { enabled, installed: false, command: "lane" };
  }

  async install(): Promise<CliIntegrationState> {
    if (this.platform === "win32") {
      if (!this.windowsCommandPath || !this.windowsNativeLauncherPath) {
        throw new Error("Windows command installation directory is unavailable");
      }
      await realpath(this.executablePath);
      await realpath(this.windowsNativeLauncherPath);
      const existing = await readOptional(this.windowsCommandPath);
      if (existing !== undefined && !existing.startsWith(WINDOWS_CLI_MARKER)) {
        throw new Error(`Another command already exists at ${this.windowsCommandPath}`);
      }
      await mkdir(dirname(this.windowsCommandPath), { recursive: true });
      await writeFile(
        this.windowsCommandPath,
        windowsCliLauncher(this.windowsNativeLauncherPath),
        "utf8",
      );
      const state = await this.getState(true);
      if (!state.installed) throw new Error("Lane command was not installed");
      return state;
    }
    if (this.platform !== "darwin") {
      throw new Error("CLI installation is currently available on macOS only");
    }
    await realpath(this.executablePath);
    await realpath(this.launcherPath);

    for (const path of this.linkPaths) {
      try {
        const owned = await this.isOwnedMacLink(path);
        if (!owned) {
          throw new Error(`Another command already exists at ${path}`);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }

    const target = shellQuote(this.launcherPath);
    const command = this.linkPaths
      .map((path) => {
        const directory = path.slice(0, path.lastIndexOf("/"));
        return `/bin/mkdir -p ${shellQuote(directory)} && /bin/ln -sfn ${target} ${shellQuote(path)}`;
      })
      .join(" && ");
    await this.runPrivileged(command);

    const state = await this.getState(true);
    if (!state.installed) throw new Error("Lane CLI launcher was not installed");
    return state;
  }
}
