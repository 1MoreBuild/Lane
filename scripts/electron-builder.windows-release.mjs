import { readFileSync } from "node:fs";

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

export default {
  ...build,
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
