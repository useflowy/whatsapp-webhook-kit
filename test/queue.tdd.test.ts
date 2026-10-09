import { describe, it, expect, vi } from "vitest";
import {
  createShardedQueue,
  shardIndexFor,
  shardQueueKey,
} from "../src/queue.js";
import { MemoryRedis } from "../src/redis.js";
import { silentLogger } from "../src/logger.js";
import type { WebhookMessageJob } from "../src/types.js";

let seq = 0;
function job(
  phoneNumberId: string,
  userPhone: string,
  message: string,
): WebhookMessageJob {
  seq += 1;
  return {
    id: `wamid-${seq}`,
    phoneNumberId,
    userPhone,
    userMessage: message,
    messageType: "text",
    timestamp: Date.now(),
  };
}

const opts = { logger: silentLogger };

describe("queue: per-conversation FIFO within a shard", () => {
  it("E5.1 — two messages of the same conversation dequeue in order", async () => {
    const redis = new MemoryRedis();
    const queue = createShardedQueue({ redis, ...opts });
    const first = job("pnid", "+51111", "primero");
    const second = job("pnid", "+51111", "segundo");

    await queue.enqueue(first);
    await queue.enqueue(second);

    const key = shardQueueKey(shardIndexFor(first, 4), "wa-kit:queue:");
    expect(await queue.dequeueFrom(key)).toMatchObject({ id: first.id });
    expect(await queue.dequeueFrom(key)).toMatchObject({ id: second.id });
    expect(await queue.dequeueFrom(key)).toBeNull();
  });

  it("E5.4 — enqueue returns false (never throws) when Redis is unavailable", async () => {
    const broken = new MemoryRedis();
    broken.failNext = true;
    const queue = createShardedQueue({ redis: broken, ...opts });
    await expect(queue.enqueue(job("pnid", "+51111", "x"))).resolves.toBe(false);
  });

  it("E5.2 — a failed job is re-queued into ITS OWN shard behind fresher messages, with retryCount+1", async () => {
    const redis = new MemoryRedis();
    const queue = createShardedQueue({ redis, ...opts });
    const failed = job("pnid", "+51111", "falla");
    await queue.enqueue(failed);

    const key = shardQueueKey(shardIndexFor(failed, 4), "wa-kit:queue:");
    const popped = (await queue.dequeueFrom(key))!; // worker took it
    await queue.enqueue(job("pnid", "+51111", "llego mientras")); // fresher, same conversation

    expect(await queue.fail(popped, "boom")).toBe(true);

    const firstOut = (await queue.dequeueFrom(key))!;
    const secondOut = (await queue.dequeueFrom(key))!;
    // The fresher message goes first; the retry defers to it (a poison
    // message never blocks the conversation) but stays in its own shard.
    expect(firstOut.userMessage).toBe("llego mientras");
    expect(secondOut.id).toBe(popped.id);
    expect(secondOut.metadata?.retryCount).toBe(1);
    expect(secondOut.metadata?.lastError).toBe("boom");
  });

  it("E5.3 — after max retries the job is dropped (fail returns false)", async () => {
    const redis = new MemoryRedis();
    const queue = createShardedQueue({ redis, maxRetries: 2, ...opts });
    const doomed = {
      ...job("pnid", "+51111", "muere"),
      metadata: { retryCount: 2 },
    };

    const requeued = await queue.fail(
      doomed as unknown as WebhookMessageJob,
      "fatal",
    );
    expect(requeued).toBe(false);
    expect(await queue.getStats()).toMatchObject({ queued: 0 });
  });

  it("E5.3b — the worker invokes onDropped exactly once when retries are exhausted", async () => {
    const redis = new MemoryRedis();
    const queue = createShardedQueue({ redis, maxRetries: 1, ...opts });
    const dropped: WebhookMessageJob[] = [];

    const stop = await queue.startWorker(
      async () => {
        throw new Error("always fails");
      },
      { idlePollMs: 1, onDropped: (j) => dropped.push(j) },
    );

    const target = job("pnid", "+51111", "dlq");
    await queue.enqueue(target);

    await vi.waitFor(() => {
      expect(dropped).toHaveLength(1);
    });
    expect(dropped[0]!.id).toBe(target.id);
    stop();
  });

  it("E5.5 — getStats reports queued per shard and shard count", async () => {
    const redis = new MemoryRedis();
    const queue = createShardedQueue({ redis, ...opts });
    await queue.enqueue(job("pnid", "+51111", "a"));
    await queue.enqueue(job("pnid", "+51111", "b"));

    const stats = await queue.getStats();
    expect(stats.queued).toBe(2);
    expect(stats.shardCount).toBe(4);
    expect(stats.shardQueued).toHaveLength(4);
    expect(stats.shardQueued.reduce((a, b) => a + b, 0)).toBe(2);
    expect(stats.isRunning).toBe(false);
  });

  it("E5.6 — drainFrom moves jobs from an arbitrary list key into their shards", async () => {
    const redis = new MemoryRedis();
    const queue = createShardedQueue({ redis, ...opts });
    const legacyKey = "my-old-queue";
    await redis.lpush(legacyKey, JSON.stringify(job("pnid", "+51111", "1")));
    await redis.lpush(legacyKey, JSON.stringify(job("pnid", "+51999", "2")));
    await redis.lpush(legacyKey, "not-json");

    const drained = await queue.drainFrom(legacyKey);
    expect(drained).toBe(2);
    expect(await redis.llen(legacyKey)).toBe(0);
    const stats = await queue.getStats();
    expect(stats.queued).toBe(2);
  });

  it("E5.7 — the worker processes each conversation's messages in order, then stops", async () => {
    const redis = new MemoryRedis();
    const queue = createShardedQueue({ redis, ...opts });
    const processed: string[] = [];

    const stop = await queue.startWorker(
      async (j) => {
        processed.push(j.userMessage);
      },
      { idlePollMs: 1 },
    );

    for (const msg of ["1", "2", "3"]) {
      await queue.enqueue(job("pnid", "+51111", msg));
    }

    await vi.waitFor(() => {
      expect(processed).toEqual(["1", "2", "3"]);
    });
    stop();
  });
});
