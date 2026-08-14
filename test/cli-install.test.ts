import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  CliInstaller,
  restoreEnabledCliIntegration,
  WINDOWS_CLI_MARKER,
} from "../src/main/cli-install.ts";
import { tempPath } from "./helpers.ts";

describe("CLI installer", () => {
  it("restores a missing command when CLI integration was already enabled", async () => {
    const install = vi.fn(async () => ({
      enabled: true,
      installed: true,
      command: "lane",
    }));
    const getState = vi.fn(async () => ({
      enabled: true,
      installed: false,
      command: "lane",
    }));

    await restoreEnabledCliIntegration({ getState, install }, true);

    expect(getState).toHaveBeenCalledWith(true);
    expect(install).toHaveBeenCalledOnce();
  });

  it("leaves command integration untouched when it was disabled", async () => {
    const integration = {
      getState: vi.fn(),
      install: vi.fn(),
    };

    await restoreEnabledCliIntegration(integration, false);

    expect(integration.getState).not.toHaveBeenCalled();
    expect(integration.install).not.toHaveBeenCalled();
  });

  it("installs and detects the launcher through an injected privileged boundary", async () => {
    const executable = await tempPath("Lane");
    const launcher = await tempPath("lane-cli");
    const first = await tempPath("usr-local/bin/lane");
    const second = await tempPath("homebrew/bin/lane");
    await writeFile(executable, "binary");
    await writeFile(launcher, "launcher");
    const installer = new CliInstaller({
      executablePath: executable,
      launcherPath: launcher,
      platform: "darwin",
      linkPaths: [first, second],
      runPrivileged: async () => {
        for (const path of [first, second]) {
          await mkdir(dirname(path), { recursive: true });
          await symlink(launcher, path);
        }
      },
    });

    expect(await installer.getState(false)).toMatchObject({
      enabled: false,
      installed: false,
      command: "lane",
    });
    expect(await installer.install()).toMatchObject({
      enabled: true,
      installed: true,
      command: "lane",
      path: first,
    });
  });

  it("refuses to replace an unrelated command", async () => {
    const executable = await tempPath("Lane");
    const launcher = await tempPath("lane-cli");
    const link = await tempPath("bin/lane");
    await writeFile(executable, "binary");
    await writeFile(launcher, "launcher");
    await mkdir(dirname(link), { recursive: true });
    await writeFile(link, "unrelated");
    const installer = new CliInstaller({
      executablePath: executable,
      launcherPath: launcher,
      platform: "darwin",
      linkPaths: [link],
      runPrivileged: async () => {
        throw new Error("must not run");
      },
    });
    await expect(installer.install()).rejects.toThrow(
      `Another command already exists at ${link}`,
    );
  });

  it("installs and detects a Windows command launcher without elevation", async () => {
    const executable = await tempPath("Lane.exe");
    const nativeLauncher = await tempPath("resources/bin/lane-cli.exe");
    const command = await tempPath("WindowsApps/lane.cmd");
    await writeFile(executable, "binary");
    await mkdir(dirname(nativeLauncher), { recursive: true });
    await writeFile(nativeLauncher, "binary");
    const installer = new CliInstaller({
      executablePath: executable,
      launcherPath: "unused-on-windows",
      platform: "win32",
      windowsCommandPath: command,
      windowsNativeLauncherPath: nativeLauncher,
    });

    expect(await installer.getState(false)).toMatchObject({
      enabled: false,
      installed: false,
      command: "lane",
    });
    expect(await installer.install()).toMatchObject({
      enabled: true,
      installed: true,
      command: "lane",
      path: command,
    });
    expect(await readFile(command, "utf8")).toContain(WINDOWS_CLI_MARKER);
    expect(await readFile(command, "utf8")).toContain(nativeLauncher);
    expect(await installer.getState(true)).toMatchObject({
      enabled: true,
      installed: true,
      path: command,
    });
  });

  it("refuses to replace an unrelated Windows command", async () => {
    const executable = await tempPath("Lane.exe");
    const nativeLauncher = await tempPath("resources/bin/lane-cli.exe");
    const command = await tempPath("WindowsApps/lane.cmd");
    await writeFile(executable, "binary");
    await mkdir(dirname(nativeLauncher), { recursive: true });
    await writeFile(nativeLauncher, "binary");
    await mkdir(dirname(command), { recursive: true });
    await writeFile(command, "@echo off\r\necho unrelated\r\n");
    const installer = new CliInstaller({
      executablePath: executable,
      launcherPath: "unused-on-windows",
      platform: "win32",
      windowsCommandPath: command,
      windowsNativeLauncherPath: nativeLauncher,
    });

    await expect(installer.install()).rejects.toThrow(
      `Another command already exists at ${command}`,
    );
  });
});
