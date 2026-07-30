import { access, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import process from "node:process";

const buildArch = process.env.LANE_SMOKE_ARCH ?? "arm64";
const executable = new URL(
  `../release/mac-${buildArch}/Lane.app/Contents/MacOS/Lane`,
  import.meta.url,
).pathname;
const marker = new URL("../.lane-smoke-ready", import.meta.url).pathname;
await rm(marker, { force: true });
await access(executable);

const child = spawn(executable, [], {
  env: { ...process.env, LANE_SMOKE_TEST: "1", LANE_SMOKE_MARKER: marker },
  stdio: ["ignore", "pipe", "pipe"],
});
const exited = new Promise((resolve) => child.once("exit", resolve));
let output = "";
child.stdout.on("data", (chunk) => (output += chunk.toString()));
child.stderr.on("data", (chunk) => (output += chunk.toString()));

const deadline = Date.now() + 20_000;
while (Date.now() < deadline) {
  try {
    await access(marker);
    await exited;
    console.log("Packaged macOS launch smoke test passed.");
    process.exit(0);
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}
child.kill("SIGTERM");
throw new Error(`Packaged app did not report ready within 20s.\n${output}`);
