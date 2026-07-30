import { spawn, spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

const releaseDirectory = new URL("../release/", import.meta.url).pathname;
const pkg = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);
const buildArch = process.env.LANE_SMOKE_ARCH ?? process.arch;
if (buildArch !== "arm64" && buildArch !== "x64") {
  throw new Error(`Unsupported macOS smoke-test architecture: ${buildArch}`);
}
const dmgName = `Lane-${pkg.version}-mac-${buildArch}.dmg`;

const temporaryRoot = await realpath(tmpdir());
const temporaryDirectory = await mkdtemp(join(temporaryRoot, "lane-dmg-smoke-"));
const mountPoint = join(temporaryDirectory, "mounted");
const installedApp = join(temporaryDirectory, "Applications", "Lane.app");
const marker = join(temporaryDirectory, "lane-smoke-ready");
const dmg = join(releaseDirectory, dmgName);
let mounted = false;
let child;

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

  const sourceApp = join(mountPoint, "Lane.app");
  await access(sourceApp);
  await mkdir(join(temporaryDirectory, "Applications"), { recursive: true });
  const copied = spawnSync("/usr/bin/ditto", [sourceApp, installedApp], {
    encoding: "utf8",
  });
  if (copied.status !== 0) {
    throw new Error(`Could not install app from DMG:\n${copied.stdout}\n${copied.stderr}`);
  }

  const executable = join(installedApp, "Contents", "MacOS", "Lane");
  await access(executable);
  child = spawn(executable, [], {
    env: { ...process.env, LANE_SMOKE_TEST: "1", LANE_SMOKE_MARKER: marker },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let output = "";
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.stdout.on("data", (chunk) => (output += chunk.toString()));
  child.stderr.on("data", (chunk) => (output += chunk.toString()));

  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      await access(marker);
      await exited;
      child = undefined;
      console.log(`DMG install and launch smoke test passed: ${dmgName}`);
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  if (child) {
    child.kill("SIGTERM");
    throw new Error(`Installed app did not report ready within 20s.\n${output}`);
  }
} finally {
  if (child) child.kill("SIGTERM");
  if (mounted) {
    spawnSync("hdiutil", ["detach", mountPoint, "-force"], { encoding: "utf8" });
  }
  await rm(temporaryDirectory, { recursive: true, force: true });
}
