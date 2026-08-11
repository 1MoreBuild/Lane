import { execFileSync } from "node:child_process";

const LEGACY_SERVICE = "lane-local-ai-gateway Safe Storage";
// v0.1.5 was the first Developer ID signed public build. An older Keychain
// item was necessarily created by an ad-hoc development or preview build.
const FIRST_SIGNED_RELEASE_AT = Date.parse("2026-08-09T20:18:24Z");

export interface LegacyKeychainRecord {
  found: boolean;
  createdAt?: number;
}

export interface SafeStorageProfile {
  appName?: string;
  secretsFile: string;
  notice?: string;
}

export function parseKeychainCreatedAt(output: string): number | undefined {
  const value = output.match(/"cdat"<timedate>=.*?"(\d{14})Z/)?.[1];
  if (!value) return undefined;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(4, 6));
  const day = Number(value.slice(6, 8));
  const hour = Number(value.slice(8, 10));
  const minute = Number(value.slice(10, 12));
  const second = Number(value.slice(12, 14));
  const timestamp = Date.UTC(year, month - 1, day, hour, minute, second);
  return Number.isNaN(timestamp) ? undefined : timestamp;
}

export function readLegacyKeychainRecord(): LegacyKeychainRecord {
  if (process.platform !== "darwin") return { found: false };
  try {
    const output = execFileSync(
      "/usr/bin/security",
      ["find-generic-password", "-s", LEGACY_SERVICE],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    const createdAt = parseKeychainCreatedAt(output);
    return { found: true, ...(createdAt === undefined ? {} : { createdAt }) };
  } catch (error) {
    const stderr = (error as { stderr?: string | Buffer }).stderr?.toString() ?? "";
    if (/could not be found/i.test(stderr)) return { found: false };
    // Preserve an unknown existing profile instead of risking credential loss.
    return { found: true };
  }
}

export function resolveSafeStorageProfile(input: {
  releaseBuild: boolean;
  packaged: boolean;
  e2e: boolean;
  platform: NodeJS.Platform;
  legacy: LegacyKeychainRecord;
  newProfileExists: boolean;
}): SafeStorageProfile {
  if (input.e2e || input.platform !== "darwin") {
    return { secretsFile: "secrets.json" };
  }
  if (!input.releaseBuild || !input.packaged) {
    return {
      appName: "Lane Development",
      secretsFile: "secrets-development.json",
    };
  }
  if (
    input.legacy.found &&
    (input.legacy.createdAt === undefined ||
      input.legacy.createdAt >= FIRST_SIGNED_RELEASE_AT)
  ) {
    return { secretsFile: "secrets.json" };
  }
  return {
    appName: "Lane",
    secretsFile: "secrets-v2.json",
    ...(input.legacy.found && !input.newProfileExists
      ? {
          notice:
            "Reconnect providers once to finish moving from a development build.",
        }
      : {}),
  };
}
