import { describe, expect, it } from "vitest";

import {
  readLimitedUtf8,
  validateWindowsCliStdinPipe,
} from "../src/main/cli-stdin.ts";

async function* chunks(...values: Array<string | Buffer>): AsyncGenerator<string | Buffer> {
  for (const value of values) yield value;
}

describe("CLI stdin transport", () => {
  it("accepts only Lane one-shot Windows named pipe paths", () => {
    expect(
      validateWindowsCliStdinPipe(
        String.raw`\\.\pipe\lane-cli-stdin-0123456789abcdef0123456789abcdef`,
      ),
    ).toBe(String.raw`\\.\pipe\lane-cli-stdin-0123456789abcdef0123456789abcdef`);
    expect(() => validateWindowsCliStdinPipe(String.raw`\\.\pipe\another-app`)).toThrow(
      "Invalid Lane CLI stdin pipe",
    );
    expect(() => validateWindowsCliStdinPipe("/tmp/lane-cli-stdin-test")).toThrow(
      "Invalid Lane CLI stdin pipe",
    );
  });

  it("reads a bounded UTF-8 secret without logging or rewriting it", async () => {
    await expect(readLimitedUtf8(chunks("sk-test-", Buffer.from("secret\n")))).resolves.toBe(
      "sk-test-secret\n",
    );
  });

  it("rejects stdin larger than the provider-key limit", async () => {
    await expect(readLimitedUtf8(chunks("x".repeat(64 * 1024 + 1)))).rejects.toThrow(
      "Provider API key is too large",
    );
  });
});
