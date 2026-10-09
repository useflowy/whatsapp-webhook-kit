import { describe, it, expect } from "vitest";
import {
  computeHubSignature256,
  verifyMetaHubSignature,
} from "../src/signature.js";

describe("signature: X-Hub-Signature-256 (HMAC-SHA256)", () => {
  it("E1.1 — returns true for a header computed with the same secret", () => {
    const body = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [{ id: "1", changes: [] }],
    });
    const header = computeHubSignature256(body, "app-secret");
    expect(verifyMetaHubSignature(body, header, "app-secret")).toBe(true);
  });

  it("E1.1b — output has the sha256=<hex> shape Meta sends", () => {
    const out = computeHubSignature256("hello", "secret");
    expect(out).toMatch(/^sha256=[0-9a-f]{64}$/);
  });

  it("E1.2 — returns false for a missing header (no throw)", () => {
    expect(verifyMetaHubSignature("body", undefined, "secret")).toBe(false);
    expect(verifyMetaHubSignature("body", "", "secret")).toBe(false);
  });

  it("E1.2b — returns false for a malformed header (no sha256= prefix)", () => {
    expect(verifyMetaHubSignature("body", "deadbeef", "secret")).toBe(false);
  });

  it("E1.2c — returns false when appSecret is empty", () => {
    expect(verifyMetaHubSignature("body", "sha256=abc", "")).toBe(false);
  });

  it("E1.3 — returns false when signed with a different secret", () => {
    const body = "payload";
    const header = computeHubSignature256(body, "correct-secret");
    expect(verifyMetaHubSignature(body, header, "wrong-secret")).toBe(false);
  });

  it("E1.4 — roundtrips multi-byte / unicode bodies", () => {
    const body = JSON.stringify({ text: "hola 🎉 ¿qué tal? ñ" });
    const header = computeHubSignature256(body, "s3cr3t");
    expect(verifyMetaHubSignature(body, header, "s3cr3t")).toBe(true);
    // Same content, different byte length must not verify
    expect(verifyMetaHubSignature(body + " ", header, "s3cr3t")).toBe(false);
  });

  it("E1.4b — accepts Buffer bodies (raw request body)", () => {
    const buf = Buffer.from('{"a":1}', "utf8");
    const header = computeHubSignature256(buf, "k");
    expect(verifyMetaHubSignature(buf, header, "k")).toBe(true);
  });

  it("E1.5 — a tampered body does not verify", () => {
    const header = computeHubSignature256('{"amount":1}', "k");
    expect(verifyMetaHubSignature('{"amount":999}', header, "k")).toBe(false);
  });
});
