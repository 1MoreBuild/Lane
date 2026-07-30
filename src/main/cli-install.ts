import { execFile } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { promisify } from "node:util";
import type { CliIntegrationState } from "../shared/contracts.ts";

const execFileAsync = promisify(execFile);
export const CLI_LINK_PATHS = ["/usr/local/bin/lane", "/opt/homebrew/bin/lane"] as const;

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

export interface CliInstallerOptions {
  executablePath: string;
  launcherPath: string;
  platform?: NodeJS.Platform;
  linkPaths?: readonly string[];
  runPrivileged?: (command: string) => Promise<void>;
}

export class CliInstaller {
  private readonly executablePath: string;
  private readonly launcherPath: string;
  private readonly platform: NodeJS.Platform;
  private readonly linkPaths: readonly string[];
  private readonly runPrivileged: (command: string) => Promise<void>;

  constructor(options: CliInstallerOptions) {
    this.executablePath = options.executablePath;
    this.launcherPath = options.launcherPath;
    this.platform = options.platform ?? process.platform;
    this.linkPaths = options.linkPaths ?? CLI_LINK_PATHS;
    this.runPrivileged =
      options.runPrivileged ??
      (async (command) => {
        await execFileAsync("/usr/bin/osascript", [
          "-e",
          `do shell script "${appleScriptString(command)}" with administrator privileges`,
        ]);
      });
  }

  async getState(enabled: boolean): Promise<CliIntegrationState> {
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
    if (this.platform !== "darwin") {
      throw new Error("CLI installation is currently available on macOS only");
    }
    await realpath(this.executablePath);
    await realpath(this.launcherPath);

    for (const path of this.linkPaths) {
      try {
        const entry = await lstat(path);
        const owned =
          entry.isSymbolicLink() &&
          ((await isLinkTo(path, this.launcherPath)) ||
            (await isLinkTo(path, this.executablePath)));
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
