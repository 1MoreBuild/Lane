import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const INSTALL_MARKER_MAX_AGE_MS = 2 * 60 * 1_000;
const FORCE_KILL_EXIT_POLL_ATTEMPTS = 10;
const FORCE_KILL_EXIT_POLL_INTERVAL_MS = 100;

interface UpdateInstallOptions {
  markerPath: string;
  executablePath: string;
  currentPid: number;
  sourceVersion: string;
  currentUserId?: number;
  platform: NodeJS.Platform;
  listProcesses?: () => Promise<string>;
  killProcess?: (pid: number, signal: NodeJS.Signals) => void;
  wait?: (milliseconds: number) => Promise<void>;
  now?: () => number;
  canonicalizeExecutable?: (path: string) => string;
}

interface UpdateInstallMarker {
  startedAt: number;
  sourceVersion?: string;
}

function removeMarker(markerPath: string): void {
  try {
    unlinkSync(markerPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function writeMarkerAtomically(
  markerPath: string,
  marker: UpdateInstallMarker & { pid: number },
): void {
  const temporaryPath = `${markerPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(marker)}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    renameSync(temporaryPath, markerPath);
  } catch (error) {
    removeMarker(temporaryPath);
    throw error;
  }
}

function readPendingMarker(
  markerPath: string,
  now: () => number,
): UpdateInstallMarker | undefined {
  try {
    const value = JSON.parse(readFileSync(markerPath, "utf8")) as {
      startedAt?: unknown;
      sourceVersion?: unknown;
    };
    if (typeof value.startedAt !== "number") {
      removeMarker(markerPath);
      return undefined;
    }
    const age = now() - value.startedAt;
    if (age < 0 || age > INSTALL_MARKER_MAX_AGE_MS) {
      removeMarker(markerPath);
      return undefined;
    }
    return {
      startedAt: value.startedAt,
      ...(typeof value.sourceVersion === "string"
        ? { sourceVersion: value.sourceVersion }
        : {}),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    if (error instanceof SyntaxError) {
      removeMarker(markerPath);
      return undefined;
    }
    throw error;
  }
}

export function clearUpdateInstallPending(markerPath: string): void {
  removeMarker(markerPath);
}

export function isUpdateInstallPending(
  markerPath: string,
  now: () => number = Date.now,
): boolean {
  return readPendingMarker(markerPath, now) !== undefined;
}

export function isUpdateSourceVersionPending(
  markerPath: string,
  currentVersion: string,
  now: () => number = Date.now,
): boolean {
  const marker = readPendingMarker(markerPath, now);
  return marker?.sourceVersion === currentVersion;
}

export function findAuxiliaryLaneProcessIds(
  processTable: string,
  executablePath: string,
  currentPid: number,
  currentUserId: number,
  canonicalizeExecutable: (path: string) => string = realpathSync,
): number[] {
  const matches: number[] = [];
  const executableBasename = executablePath.slice(
    executablePath.lastIndexOf("/") + 1,
  );
  const executableSuffix = `/${executableBasename}`;
  for (const line of processTable.split("\n")) {
    const parsed = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
    if (!parsed) continue;
    const userId = Number(parsed[1]);
    const pid = Number(parsed[2]);
    const command = parsed[3]!;
    if (userId !== currentUserId) continue;
    if (pid === currentPid) continue;
    if (command === executablePath || command.startsWith(`${executablePath} `)) {
      matches.push(pid);
      continue;
    }
    let suffixIndex = command.indexOf(executableSuffix);
    while (suffixIndex >= 0) {
      const candidateEnd = suffixIndex + executableSuffix.length;
      if (candidateEnd === command.length || command[candidateEnd] === " ") {
        const candidate = command.slice(0, candidateEnd);
        try {
          if (
            canonicalizeExecutable(candidate) ===
            canonicalizeExecutable(executablePath)
          ) {
            matches.push(pid);
            break;
          }
        } catch {
          // The process may exit while ps output is being inspected.
        }
      }
      suffixIndex = command.indexOf(executableSuffix, suffixIndex + 1);
    }
  }
  return matches;
}

async function defaultListProcesses(): Promise<string> {
  const { stdout } = await execFileAsync("/bin/ps", [
    "-axo",
    "uid=,pid=,command=",
  ]);
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
  writeMarkerAtomically(
    options.markerPath,
    {
      pid: options.currentPid,
      sourceVersion: options.sourceVersion,
      startedAt: now(),
    },
  );
  if (options.platform !== "darwin") return [];

  const currentUserId = options.currentUserId ?? process.getuid?.();
  if (currentUserId === undefined) {
    removeMarker(options.markerPath);
    throw new Error("Cannot determine the current user for update installation");
  }

  const listProcesses = options.listProcesses ?? defaultListProcesses;
  const killProcess = options.killProcess ?? process.kill.bind(process);
  const wait =
    options.wait ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  try {
    const initial = findAuxiliaryLaneProcessIds(
      await listProcesses(),
      options.executablePath,
      options.currentPid,
      currentUserId,
      options.canonicalizeExecutable,
    );
    signal(initial, "SIGTERM", killProcess);
    const stopped = new Set(initial);
    if (initial.length > 0) await wait(600);

    const remaining = findAuxiliaryLaneProcessIds(
      await listProcesses(),
      options.executablePath,
      options.currentPid,
      currentUserId,
      options.canonicalizeExecutable,
    );
    signal(remaining, "SIGKILL", killProcess);
    const forceKilled = new Set(remaining);
    for (const pid of remaining) stopped.add(pid);

    let running: number[] = [];
    for (let attempt = 0; attempt < FORCE_KILL_EXIT_POLL_ATTEMPTS; attempt += 1) {
      await wait(FORCE_KILL_EXIT_POLL_INTERVAL_MS);
      running = findAuxiliaryLaneProcessIds(
        await listProcesses(),
        options.executablePath,
        options.currentPid,
        currentUserId,
        options.canonicalizeExecutable,
      );
      const newlyStarted = running.filter((pid) => !forceKilled.has(pid));
      signal(newlyStarted, "SIGKILL", killProcess);
      for (const pid of newlyStarted) {
        forceKilled.add(pid);
        stopped.add(pid);
      }
      if (running.length === 0) return [...stopped];
    }
    throw new Error(
      `Lane helper process${running.length === 1 ? "" : "es"} did not exit before update installation`,
    );
  } catch (error) {
    removeMarker(options.markerPath);
    throw error;
  }
}
