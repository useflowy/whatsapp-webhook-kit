import { describe, it, expect } from "vitest";
import { enqueueOrProcessInline } from "../src/fallback.js";
import { createShardedQueue } from "../src/queue.js";
import { MemoryRedis } from "../src/redis.js";
import { silentLogger } from "../src/logger.js";
import type { WebhookMessageJob } from "../src/types.js";

function job(id: string): WebhookMessageJob {
  return {
    id,
    phoneNumberId: "pnid",
    userPhone: "+51111",
    userMessage: "hi",
    messageType: "text",
    timestamp: Date.now(),
  };
}

describe("fallback: enqueue-or-inline survival", () => {
  it("E6.1 — when enqueue succeeds, the processor is NOT called", async () => {
    const redis = new MemoryRedis();
    const queue = createShardedQueue({ redis, logger: silentLogger });
    const processor = async () => {
      throw new Error("must not be called");
    };

    const outcome = await enqueueOrProcessInline(
      queue,
      processor,
      job("wamid.ok"),
      silentLogger,
    );
    expect(outcome).toBe("enqueued");
  });

  it("E6.2 — when enqueue is unavailable, the message is processed inline", async () => {
    const broken = new MemoryRedis();
    broken.failNext = true; // first redis op (enqueue) fails
    const queue = createShardedQueue({ redis: broken, logger: silentLogger });
    const calls: string[] = [];
    const processor = async (j: WebhookMessageJob) => {
      calls.push(j.id);
    };

    const outcome = await enqueueOrProcessInline(
      queue,
      processor,
      job("wamid.inline"),
      silentLogger,
    );
    expect(outcome).toBe("processed-inline");
    expect(calls).toEqual(["wamid.inline"]);
  });
});
