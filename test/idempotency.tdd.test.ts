import { describe, it, expect } from "vitest";
import { createMessageIdempotency } from "../src/idempotency.js";
import { MemoryRedis } from "../src/redis.js";

describe("idempotency: webhook claims + turn locks (fail-open)", () => {
  it("E3.1 — first claim wins, second claim of the same message is a duplicate", async () => {
    const redis = new MemoryRedis();
    const idem = createMessageIdempotency({ redis });

    expect(await idem.claimWebhookMessage("wamid.1")).toBe(true);
    expect(await idem.claimWebhookMessage("wamid.1")).toBe(false);
    // a different message is independent
    expect(await idem.claimWebhookMessage("wamid.2")).toBe(true);
  });

  it("E3.2 — after the dedup TTL expires, the message is claimable again", async () => {
    let now = 1_000_000;
    const redis = new MemoryRedis({ now: () => now });
    const idem = createMessageIdempotency({ redis, dedupTtlSeconds: 600 });

    expect(await idem.claimWebhookMessage("wamid.old")).toBe(true);
    expect(await idem.claimWebhookMessage("wamid.old")).toBe(false);

    now += 601 * 1000;
    expect(await idem.claimWebhookMessage("wamid.old")).toBe(true);
  });

  it("E3.3 — a Redis error fails OPEN: the webhook proceeds (availability over dedup)", async () => {
    const broken = new MemoryRedis();
    broken.failNext = true;
    const idem = createMessageIdempotency({ redis: broken });

    await expect(idem.claimWebhookMessage("wamid.x")).resolves.toBe(true);
  });

  it("E3.4 — turn lock: acquired -> duplicate -> release -> acquired again", async () => {
    const redis = new MemoryRedis();
    const idem = createMessageIdempotency({ redis });

    expect(await idem.acquireTurnLock("wamid.t")).toBe("acquired");
    expect(await idem.acquireTurnLock("wamid.t")).toBe("duplicate");

    await idem.releaseTurnLock("wamid.t");
    expect(await idem.acquireTurnLock("wamid.t")).toBe("acquired");
  });

  it("E3.4b — turn lock reports unavailable when Redis throws", async () => {
    const broken = new MemoryRedis();
    broken.failNext = true;
    const idem = createMessageIdempotency({ redis: broken });

    await expect(idem.acquireTurnLock("wamid.t")).resolves.toBe("unavailable");
  });

  it("E3.4c — releaseTurnLock never throws, even if Redis is broken", async () => {
    const broken = new MemoryRedis();
    broken.failNext = true;
    const idem = createMessageIdempotency({ redis: broken });

    await expect(idem.releaseTurnLock("wamid.t")).resolves.toBeUndefined();
  });

  it("E3.5 — keys are namespaced by the configured prefix (multi-app safety)", async () => {
    const redis = new MemoryRedis();
    const idem = createMessageIdempotency({ redis, keyPrefix: "myapp:" });

    await idem.claimWebhookMessage("wamid.k");
    const keys = [...redis.strings.keys()];
    expect(keys).toHaveLength(1);
    expect(keys[0]!.startsWith("myapp:")).toBe(true);
  });
});
