import { mkdir, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  LANE_NATIVE_HOST_NAME,
  TRANSLY_NATIVE_ALLOWED_ORIGINS,
} from "../shared/native-messaging.ts";

export interface NativeMessagingInstallerOptions {
  executablePath: string;
  platform?: NodeJS.Platform;
  homePath?: string;
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

export class NativeMessagingInstaller {
  private readonly executablePath: string;
  private readonly platform: NodeJS.Platform;
  private readonly manifestPath: string;

  constructor(options: NativeMessagingInstallerOptions) {
    this.executablePath = resolve(options.executablePath);
    this.platform = options.platform ?? process.platform;
    this.manifestPath = chromeManifestPath(options.homePath ?? homedir());
  }

  async install(): Promise<NativeMessagingIntegrationState> {
    if (this.platform !== "darwin") {
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
    return { installed: true, manifestPath: this.manifestPath };
  }
}
