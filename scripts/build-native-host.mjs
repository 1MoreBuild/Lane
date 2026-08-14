import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { access, mkdir, readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const GO_VERSION = "1.26.5";
const GO_ARCHIVE_URL = `https://go.dev/dl/go${GO_VERSION}.windows-amd64.zip`;
const GO_ARCHIVE_SHA256 =
  "97e6b2a833b6d89f9ff17d25419ac0a7e3b482a044e9ab18cdef834bd834fd38";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDirectory, "..");
const toolRoot = join(
  process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"),
  "LaneBuildTools",
  `go-${GO_VERSION}`,
);
const archivePath = join(toolRoot, `go-${GO_VERSION}.zip`);
const goDirectory = join(toolRoot, "go");
const goExecutable = join(goDirectory, "bin/go.exe");

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function run(executable, args, options = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(executable, args, {
      stdio: "inherit",
      windowsHide: true,
      ...options,
    });
    child.once("error", rejectRun);
    child.once("exit", (code) => {
      if (code === 0) resolveRun();
      else rejectRun(new Error(`${executable} exited with code ${code}`));
    });
  });
}

async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function downloadToolchain() {
  await mkdir(toolRoot, { recursive: true });
  if (!(await exists(archivePath)) || (await sha256(archivePath)) !== GO_ARCHIVE_SHA256) {
    await rm(archivePath, { force: true });
    console.log(`Downloading Go ${GO_VERSION} from go.dev...`);
    const response = await fetch(GO_ARCHIVE_URL, { redirect: "follow" });
    if (!response.ok || !response.body) {
      throw new Error(`Go download failed: HTTP ${response.status}`);
    }
    await pipeline(response.body, createWriteStream(archivePath, { flags: "wx" }));
  }
  const actualHash = await sha256(archivePath);
  if (actualHash !== GO_ARCHIVE_SHA256) {
    throw new Error(`Go archive checksum mismatch: ${actualHash}`);
  }
  if (!(await exists(goExecutable))) {
    await rm(goDirectory, { recursive: true, force: true });
    await run("tar.exe", ["-xf", archivePath, "-C", toolRoot]);
  }
}

if (process.platform !== "win32") {
  throw new Error("The Windows native host must be built on Windows");
}

await downloadToolchain();
const binaries = [
  ["lane-native-host.go", "lane-native-host.exe"],
  ["lane-cli.go", "lane-cli.exe"],
];
for (const [sourceName] of binaries) {
  await readFile(resolve(projectRoot, `native-host/${sourceName}`), "utf8");
}
for (const [arch, goArch] of [
  ["x64", "amd64"],
  ["arm64", "arm64"],
]) {
  const outputDirectory = resolve(projectRoot, `build/native-host/${arch}`);
  await mkdir(outputDirectory, { recursive: true });
  for (const [sourceName, outputName] of binaries) {
    const output = join(outputDirectory, outputName);
    await run(goExecutable, [
      "build",
      "-trimpath",
      "-buildvcs=false",
      "-ldflags=-s -w",
      "-o",
      output,
      resolve(projectRoot, `native-host/${sourceName}`),
    ], {
      env: {
        ...process.env,
        GOOS: "windows",
        GOARCH: goArch,
        CGO_ENABLED: "0",
      },
    });
    console.log(`Built ${output}`);
  }
}
