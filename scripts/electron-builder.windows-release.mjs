import { readFileSync } from "node:fs";
import { join } from "node:path";

const { build } = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);

function requireEnvironmentVariable(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required for an Azure Artifact Signing release`);
  }
  return value;
}

async function signBundledWindowsExecutables(context) {
  if (context.electronPlatformName !== "win32") return;

  for (const executable of ["lane-cli.exe", "lane-native-host.exe"]) {
    const path = join(context.appOutDir, "resources", "bin", executable);
    const signed = await context.packager.signIf(path);
    if (!signed) {
      throw new Error(`Azure Artifact Signing did not sign ${path}`);
    }
  }
}

export default {
  ...build,
  afterPack: signBundledWindowsExecutables,
  win: {
    ...build.win,
    azureSignOptions: {
      publisherName: requireEnvironmentVariable("AZURE_SIGNING_PUBLISHER_NAME"),
      endpoint: requireEnvironmentVariable("AZURE_SIGNING_ENDPOINT"),
      certificateProfileName: requireEnvironmentVariable(
        "AZURE_SIGNING_CERTIFICATE_PROFILE_NAME",
      ),
      codeSigningAccountName: requireEnvironmentVariable(
        "AZURE_SIGNING_ACCOUNT_NAME",
      ),
    },
  },
};
