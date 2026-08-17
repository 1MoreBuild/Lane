import { join } from "node:path";
import { flipFuses, FuseV1Options, FuseVersion } from "@electron/fuses";

// Electron ships these enabled, which lets any local process run arbitrary code
// through Lane's signed binary and inherit its Keychain access to stored
// provider credentials. Nothing in Lane uses them.
const DISABLED_FUSES = {
  [FuseV1Options.RunAsNode]: false,
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
  [FuseV1Options.EnableNodeCliInspectArguments]: false,
};

export function packagedBinary(context) {
  const name = context.packager.appInfo.productFilename;
  if (context.electronPlatformName === "darwin") {
    return join(context.appOutDir, `${name}.app`);
  }
  if (context.electronPlatformName === "win32") {
    return join(context.appOutDir, `${name}.exe`);
  }
  return join(context.appOutDir, name);
}

export default async function hardenFuses(context) {
  const target = packagedBinary(context);
  await flipFuses(target, {
    version: FuseVersion.V1,
    // Flipping invalidates the signature, so the binary is re-signed ad hoc
    // here and electron-builder replaces that with the real identity after.
    resetAdHocDarwinSignature: context.electronPlatformName === "darwin",
    ...DISABLED_FUSES,
  });
}
