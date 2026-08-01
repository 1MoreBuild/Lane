import { spawn, spawnSync } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

const releaseDirectory = new URL("../release/", import.meta.url).pathname;
const pkg = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);
const buildArch = process.env.LANE_E2E_ARCH ?? process.arch;
if (buildArch !== "arm64" && buildArch !== "x64") {
  throw new Error(`Unsupported macOS E2E architecture: ${buildArch}`);
}

const temporaryRoot = await realpath(tmpdir());
const directory = await mkdtemp(join(temporaryRoot, "lane-dmg-e2e-"));
const mountPoint = join(directory, "mounted");
const installedApp = join(directory, "Applications", "Lane.app");
const dmg = join(
  releaseDirectory,
  `Lane-${pkg.version}-mac-${buildArch}.dmg`,
);
let mounted = false;

try {
  await access(dmg);
  const attached = spawnSync(
    "hdiutil",
    ["attach", dmg, "-mountpoint", mountPoint, "-nobrowse", "-readonly"],
    { encoding: "utf8" },
  );
  if (attached.status !== 0) {
    throw new Error(`Could not mount DMG:\n${attached.stdout}\n${attached.stderr}`);
  }
  mounted = true;

  await mkdir(join(directory, "Applications"), { recursive: true });
  const copied = spawnSync(
    "/usr/bin/ditto",
    [join(mountPoint, "Lane.app"), installedApp],
    { encoding: "utf8" },
  );
  if (copied.status !== 0) {
    throw new Error(`Could not install app from DMG:\n${copied.stdout}\n${copied.stderr}`);
  }

  const executable = join(installedApp, "Contents", "MacOS", "Lane");
  await access(executable);
  const signature = spawnSync(
    "codesign",
    ["--verify", "--deep", "--strict", "--verbose=4", installedApp],
    { encoding: "utf8" },
  );
  if (signature.status !== 0) {
    throw new Error(
      `Installed app has an invalid bundle signature:\n${signature.stdout}\n${signature.stderr}`,
    );
  }

  const child = spawn("npm", ["run", "e2e"], {
    env: { ...process.env, LANE_E2E_APP_PATH: executable },
    stdio: "inherit",
  });
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
  if (exitCode !== 0) {
    throw new Error(`Lane DMG E2E failed with exit code ${exitCode}`);
  }
} finally {
  if (mounted) {
    spawnSync("hdiutil", ["detach", mountPoint, "-force"], {
      encoding: "utf8",
    });
  }
  await rm(directory, { recursive: true, force: true });
}
