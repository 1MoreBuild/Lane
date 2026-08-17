import { join } from "node:path";
import { flipFuses, FuseV1Options, FuseVersion } from "@electron/fuses";

// Electron ships these enabled, which lets any local process run arbitrary code
// through Lane's signed binary and inherit its Keychain access to stored
// provider credentials. Nothing in Lane uses them.
//
// EnableNodeCliInspectArguments stays enabled: Playwright drives the packaged
// app through the main-process Node inspector (--inspect=0), and the release
// workflow gates publication on that installed-product E2E. Disabling it needs
// an E2E harness that works without the inspector first.
const DISABLED_FUSES = {
  [FuseV1Options.RunAsNode]: false,
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
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
