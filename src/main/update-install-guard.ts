import { execFile } from "node:child_process";
import {
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const INSTALL_MARKER_MAX_AGE_MS = 2 * 60 * 1_000;

interface UpdateInstallOptions {
  markerPath: string;
  executablePath: string;
  currentPid: number;
  platform: NodeJS.Platform;
  listProcesses?: () => Promise<string>;
  killProcess?: (pid: number, signal: NodeJS.Signals) => void;
  wait?: (milliseconds: number) => Promise<void>;
  now?: () => number;
}

function removeMarker(markerPath: string): void {
  try {
    unlinkSync(markerPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export function clearUpdateInstallPending(markerPath: string): void {
  removeMarker(markerPath);
}

export function isUpdateInstallPending(
  markerPath: string,
  now: () => number = Date.now,
): boolean {
  try {
    const value = JSON.parse(readFileSync(markerPath, "utf8")) as {
      startedAt?: unknown;
    };
    if (typeof value.startedAt !== "number") {
      removeMarker(markerPath);
      return false;
    }
    const age = now() - value.startedAt;
    if (age >= 0 && age <= INSTALL_MARKER_MAX_AGE_MS) return true;
    removeMarker(markerPath);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    if (error instanceof SyntaxError) {
      removeMarker(markerPath);
      return false;
    }
    throw error;
  }
}

export function findAuxiliaryLaneProcessIds(
  processTable: string,
  executablePath: string,
  currentPid: number,
): number[] {
  const matches: number[] = [];
  for (const line of processTable.split("\n")) {
    const parsed = line.trim().match(/^(\d+)\s+(.+)$/);
    if (!parsed) continue;
    const pid = Number(parsed[1]);
    const command = parsed[2]!;
    if (
      pid !== currentPid &&
      (command === executablePath || command.startsWith(`${executablePath} `))
    ) {
      matches.push(pid);
    }
  }
  return matches;
}

async function defaultListProcesses(): Promise<string> {
  const { stdout } = await execFileAsync("/bin/ps", ["-axo", "pid=,command="]);
  return stdout;
}

function signal(
  processIds: number[],
  value: NodeJS.Signals,
  killProcess: (pid: number, signal: NodeJS.Signals) => void,
): void {
  for (const pid of processIds) {
    try {
      killProcess(pid, value);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
}

export async function prepareForUpdateInstall(
  options: UpdateInstallOptions,
): Promise<number[]> {
  const now = options.now ?? Date.now;
  writeFileSync(
    options.markerPath,
    `${JSON.stringify({ pid: options.currentPid, startedAt: now() })}\n`,
    { mode: 0o600 },
  );
  if (options.platform !== "darwin") return [];

  const listProcesses = options.listProcesses ?? defaultListProcesses;
  const killProcess = options.killProcess ?? process.kill.bind(process);
  const wait =
    options.wait ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const initial = findAuxiliaryLaneProcessIds(
    await listProcesses(),
    options.executablePath,
    options.currentPid,
  );
  signal(initial, "SIGTERM", killProcess);
  if (initial.length > 0) await wait(600);

  const remaining = findAuxiliaryLaneProcessIds(
    await listProcesses(),
    options.executablePath,
    options.currentPid,
  );
  signal(remaining, "SIGKILL", killProcess);
  return [...new Set([...initial, ...remaining])];
}
