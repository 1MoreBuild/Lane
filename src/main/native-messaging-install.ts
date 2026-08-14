import { execFile } from "node:child_process";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  LANE_NATIVE_HOST_NAME,
  TRANSLY_NATIVE_ALLOWED_ORIGINS,
} from "../shared/native-messaging.ts";

export interface NativeMessagingInstallerOptions {
  executablePath: string;
  platform?: NodeJS.Platform;
  homePath?: string;
  localAppDataPath?: string;
  registerWindowsHost?(manifestPath: string): Promise<void>;
}

export interface NativeMessagingIntegrationState {
  installed: boolean;
  manifestPath?: string;
  error?: string;
}

function chromeManifestPath(homePath: string) {
  return join(
    homePath,
    "Library/Application Support/Google/Chrome/NativeMessagingHosts",
    `${LANE_NATIVE_HOST_NAME}.json`,
  );
}

function windowsManifestPath(localAppDataPath: string) {
  return join(
    localAppDataPath,
    "Lane/NativeMessagingHosts",
    `${LANE_NATIVE_HOST_NAME}.json`,
  );
}

const execFileAsync = promisify(execFile);

async function registerWindowsChromeHost(manifestPath: string): Promise<void> {
  await execFileAsync("reg.exe", [
    "add",
    `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${LANE_NATIVE_HOST_NAME}`,
    "/ve",
    "/t",
    "REG_SZ",
    "/d",
    manifestPath,
    "/f",
  ], { windowsHide: true });
}

export class NativeMessagingInstaller {
  private readonly executablePath: string;
  private readonly platform: NodeJS.Platform;
  private readonly manifestPath: string;
  private readonly registerWindowsHost: (manifestPath: string) => Promise<void>;

  constructor(options: NativeMessagingInstallerOptions) {
    this.executablePath = resolve(options.executablePath);
    this.platform = options.platform ?? process.platform;
    this.manifestPath = this.platform === "win32"
      ? windowsManifestPath(
          options.localAppDataPath ??
            process.env.LOCALAPPDATA ??
            join(homedir(), "AppData/Local"),
        )
      : chromeManifestPath(options.homePath ?? homedir());
    this.registerWindowsHost = options.registerWindowsHost ?? registerWindowsChromeHost;
  }

  async install(): Promise<NativeMessagingIntegrationState> {
    if (this.platform !== "darwin" && this.platform !== "win32") {
      return { installed: false, error: "Native messaging is not supported on this platform." };
    }
    const manifest = {
      name: LANE_NATIVE_HOST_NAME,
      description: "Connect approved browser extensions to the Lane local AI gateway",
      path: this.executablePath,
      type: "stdio",
      allowed_origins: TRANSLY_NATIVE_ALLOWED_ORIGINS,
    };
    await mkdir(dirname(this.manifestPath), { recursive: true, mode: 0o700 });
    const temporary = `${this.manifestPath}.tmp`;
    await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporary, this.manifestPath);
    if (this.platform === "win32") {
      await this.registerWindowsHost(this.manifestPath);
    }
    return { installed: true, manifestPath: this.manifestPath };
  }
}
