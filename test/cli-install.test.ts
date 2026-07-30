import { mkdir, symlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { describe, expect, it } from "vitest";
import { CliInstaller } from "../src/main/cli-install.ts";
import { tempPath } from "./helpers.ts";

describe("CLI installer", () => {
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
});
