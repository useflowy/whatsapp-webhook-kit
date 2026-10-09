import { describe, it, expect } from "vitest";
import {
  hashFnv1a32,
  shardIndexFor,
  shardKeyFor,
} from "../src/queue.js";
import type { WebhookMessageJob } from "../src/types.js";

function job(phoneNumberId: string, userPhone: string): WebhookMessageJob {
  return {
    id: `wamid.${phoneNumberId}:${userPhone}`,
    phoneNumberId,
    userPhone,
    userMessage: "hi",
    messageType: "text",
    timestamp: Date.now(),
  };
}

describe("sharding: FNV-1a 32-bit (deterministic across processes)", () => {
  it("E4.2 — matches the canonical FNV-1a 32-bit reference vectors", () => {
    // Reference vectors from the FNV-1a specification
    expect(hashFnv1a32("")).toBe(0x811c9dc5);
    expect(hashFnv1a32("a")).toBe(0xe40c292c);
    expect(hashFnv1a32("foobar")).toBe(0xbf9cf968);
  });

  it("E4.1 — the same conversation always maps to the same shard", () => {
    const a = job("pnid-1", "+51999999999");
    for (const shardCount of [2, 4, 8, 16]) {
      const first = shardIndexFor(a, shardCount);
      for (let i = 0; i < 25; i++) {
        expect(shardIndexFor(a, shardCount)).toBe(first);
      }
      expect(first).toBeGreaterThanOrEqual(0);
      expect(first).toBeLessThan(shardCount);
    }
  });

  it("E4.1b — shard key is the stable conversation identity", () => {
    expect(shardKeyFor(job("pnid-1", "+51111"))).toBe("pnid-1:+51111");
    expect(shardKeyFor(job("pnid-1", "+51111"))).toBe(
      shardKeyFor(job("pnid-1", "+51111")),
    );
    expect(shardKeyFor(job("pnid-1", "+51111"))).not.toBe(
      shardKeyFor(job("pnid-2", "+51111")),
    );
  });

  it("E4.3 — distinct conversations spread across shards", () => {
    const shardCount = 8;
    const indices = new Set<number>();
    for (let i = 0; i < 200; i++) {
      indices.add(shardIndexFor(job(`pnid-${i % 5}`, `+51900${i}`), shardCount));
    }
    // With 200 conversations over 8 shards, hitting at least 6 different
    // shards is virtually guaranteed for any sane hash.
    expect(indices.size).toBeGreaterThanOrEqual(6);
  });
});
