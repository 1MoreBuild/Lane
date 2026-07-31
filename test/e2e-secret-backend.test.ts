import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { E2ESecretBackend } from "../src/main/e2e-secret-backend.ts";

describe("E2ESecretBackend", () => {
  it("round-trips secrets without storing plaintext", () => {
    const backend = new E2ESecretBackend(randomBytes(32).toString("base64url"));
    const ciphertext = backend.encrypt("private-test-secret");

    expect(ciphertext.toString()).not.toContain("private-test-secret");
    expect(backend.decrypt(ciphertext)).toBe("private-test-secret");
  });

  it("rejects invalid keys and ciphertext from another run", () => {
    expect(() => new E2ESecretBackend("short")).toThrow(
      "Lane E2E secret key must contain 32 bytes",
    );
    const first = new E2ESecretBackend(randomBytes(32).toString("base64url"));
    const second = new E2ESecretBackend(randomBytes(32).toString("base64url"));

    expect(() => second.decrypt(first.encrypt("secret"))).toThrow();
  });
});
