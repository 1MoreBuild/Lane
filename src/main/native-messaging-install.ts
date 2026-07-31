import { execFile } from "node:child_process";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  LANE_NATIVE_HOST_NAME,
  TRANSLY_NATIVE_ALLOWED_ORIGINS,
} from "../shared/native-messaging.ts";

const execFileAsync = promisify(execFile);

export interface NativeMessagingInstallerOptions {
  executablePath: string;
  platform?: NodeJS.Platform;
  homePath?: string;
  userDataPath: string;
  runRegistryCommand?: (args: string[]) => Promise<void>;
}

export interface NativeMessagingIntegrationState {
  installed: boolean;
  manifestPath?: string;
  error?: string;
}

function chromeManifestPath(platform: NodeJS.Platform, homePath: string, userDataPath: string) {
  if (platform === "darwin") {
    return join(
      homePath,
      "Library/Application Support/Google/Chrome/NativeMessagingHosts",
      `${LANE_NATIVE_HOST_NAME}.json`,
    );
  }
  if (platform === "win32") {
    return join(userDataPath, "native-messaging", `${LANE_NATIVE_HOST_NAME}.json`);
  }
  return join(
    homePath,
    ".config/google-chrome/NativeMessagingHosts",
    `${LANE_NATIVE_HOST_NAME}.json`,
  );
}

export class NativeMessagingInstaller {
  private readonly executablePath: string;
  private readonly platform: NodeJS.Platform;
  private readonly manifestPath: string;
  private readonly runRegistryCommand: (args: string[]) => Promise<void>;

  constructor(options: NativeMessagingInstallerOptions) {
    this.executablePath = resolve(options.executablePath);
    this.platform = options.platform ?? process.platform;
    this.manifestPath = chromeManifestPath(
      this.platform,
      options.homePath ?? homedir(),
      options.userDataPath,
    );
    this.runRegistryCommand =
      options.runRegistryCommand ??
      (async (args) => {
        await execFileAsync("reg.exe", args);
      });
  }

  async install(): Promise<NativeMessagingIntegrationState> {
    if (!["darwin", "win32", "linux"].includes(this.platform)) {
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
      await this.runRegistryCommand([
        "ADD",
        `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${LANE_NATIVE_HOST_NAME}`,
        "/ve",
        "/t",
        "REG_SZ",
        "/d",
        this.manifestPath,
        "/f",
      ]);
    }
    return { installed: true, manifestPath: this.manifestPath };
  }
}
