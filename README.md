# whatsapp-webhook-kit

**Exactly-once, in-order WhatsApp Cloud API webhook processing for TypeScript.** Signature verification, payload normalization, idempotent claims, and a per-conversation sharded queue with retries and dead-letter handling — zero runtime dependencies.

[![CI](https://github.com/useflowy/whatsapp-webhook-kit/actions/workflows/ci.yml/badge.svg)](https://github.com/useflowy/whatsapp-webhook-kit/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

## The four ways WhatsApp webhooks bite

Every serious WhatsApp Cloud API integration hits the same walls:

1. **Meta redelivers.** Timeouts, retries, webhook replays — the same `wamid.*` arrives twice, and a naive `GET → check → SET` dedup has a TOCTOU race: two concurrent deliveries both pass the check and both process. Your bot answers twice.
2. **Conversations need order.** If "yes" and "no" from the same user are processed out of order, your bot replies to the wrong one. But a single global queue serializes *every* conversation behind the slowest one (head-of-line blocking).
3. **Retries must not reorder.** When processing fails, the retry has to stay inside its conversation's ordering — without letting one poison message block every newer message.
4. **The queue will go down.** When it does, you lose the message silently: Meta already got its `200 OK` and will not redeliver.

This kit is the pipeline we run in production at [UseFlowy](https://useflowy.com/?ref=github) — a WhatsApp-first bot platform — extracted and generalized. It is not a sketch: the idempotency races, the sharded queue and the dead-letter path were all found and fixed the hard way, under real traffic.

## Install

```bash
bun add github:useflowy/whatsapp-webhook-kit
# or
npm install github:useflowy/whatsapp-webhook-kit
```

> npm registry publishing is planned once the API stabilizes. The package has **zero runtime dependencies** and exports plain TypeScript.

## Quick start (Express)

```ts
import express from "express";
import {
  MemoryRedis, // bring your own ioredis/node-redis client instead
  createMessageIdempotency,
  createShardedQueue,
  enqueueOrProcessInline,
  jobForMessage,
  normalizeWebhookPayload,
  verifyMetaHubSignature,
  webhookVerificationResponse,
} from "whatsapp-webhook-kit";

const APP_SECRET = process.env.META_APP_SECRET!;
const VERIFY_TOKEN = process.env.META_VERIFY_TOKEN!;

const redis = new MemoryRedis(); // e.g. new Redis(url) from ioredis
const idempotency = createMessageIdempotency({ redis });
const queue = createShardedQueue({ redis, shardCount: 8 });

// Your actual business logic — one job per message, in order per conversation
const processor = async (job: any) => {
  console.log(`[${job.userPhone}] ${job.userMessage}`);
};

void queue.startWorker(processor, {
  onDropped: (job, error) => {
    // Dead-letter: retries exhausted. Persist it — Meta will not redeliver.
    console.error("dropped", { job: job.id, error });
  },
});

const app = express();

// 1) One-time webhook verification handshake
app.get("/webhook/whatsapp", (req, res) => {
  const challenge = webhookVerificationResponse(req.query as any, VERIFY_TOKEN);
  challenge ? res.send(challenge) : res.sendStatus(403);
});

// 2) Incoming messages — verify → normalize → claim → enqueue
app.post(
  "/webhook/whatsapp",
  express.raw({ type: "*/*" }), // signature is over the RAW body
  async (req, res) => {
    const raw = req.body as Buffer;
    if (!verifyMetaHubSignature(raw, req.header("X-Hub-Signature-256"), APP_SECRET)) {
      return res.sendStatus(401);
    }

    for (const incoming of normalizeWebhookPayload(JSON.parse(raw.toString()))) {
      const job = jobForMessage(
        incoming.message,
        incoming.phoneNumberId,
        incoming.contactName,
      );

      // Exactly-once: skip Meta redeliveries (atomic SET NX under the hood)
      if (!(await idempotency.claimWebhookMessage(job.id))) continue;

      // Queue it; if Redis is down, process inline instead of losing it
      await enqueueOrProcessInline(queue, processor, job);
    }
    res.sendStatus(200); // fast 200 — work happens in the worker
  },
);

app.listen(3000);
```

Fastify works the same: verify `req.rawBody` with `verifyMetaHubSignature`, then the kit's functions are framework-free.

## How the sharded queue works

```
                conversation = (phoneNumberId, userPhone)
                          │
                    FNV-1a hash  (stable across processes & deploys)
                          │
        ┌─────────┬───────┴──────┬─────────┐   N shards = N parallel lanes
        ▼         ▼              ▼         ▼
   :queue:s0  :queue:s1     :queue:s2  :queue:s3
   [B,A]      [D]           [F,E]      []        LPUSH in / RPOP out
        │         │              │         │
      loop0     loop1          loop2     loop3    one worker loop per shard
```

- Messages of one conversation always hash to the **same shard** → strict FIFO per conversation.
- Different conversations spread across shards → parallel processing, no head-of-line blocking.
- A failed job is retried **inside its own shard** with `retryCount + 1` — order is preserved and a poison message defers to fresher messages instead of blocking the conversation.
- After `maxRetries`, the job is dropped and your `onDropped` hook fires. **Always pass it** — that is your only chance to persist a lost message.

Retry metadata travels in `job.metadata.retryCount` / `job.metadata.lastError`.

## Exactly-once, honestly

Two atomic `SET NX` layers, both fail-open:

| Layer | What it prevents | When |
| --- | --- | --- |
| `claimWebhookMessage(id)` | The same webhook delivery processed twice (Meta redelivery / concurrent races) | Webhook handler, before enqueueing |
| `acquireTurnLock(id)` → `"acquired" \| "duplicate" \| "unavailable"` | A worker retry re-executing a turn that already produced a response | Inside your processor |

**Fail-open by design:** if Redis is down, claims return `true` (proceed) and locks return `"unavailable"` (apply your own fallback, e.g. a DB-level guard). A degraded dedup window beats silently dropping messages — you already answered 200 to Meta.

## Migrating from a single queue

If you already LPUSH jobs into one list, move them into their shards without downtime:

```ts
const moved = await queue.drainFrom("my-old-queue-key"); // → number of jobs migrated
```

## Redis compatibility

`RedisLike` needs five commands — `SET key value EX ttl NX`, `DEL`, `LPUSH`, `RPOP`, `LLEN` — in the positional-args style that both **ioredis** and **node-redis v4+** accept, so pass your client directly. No Redis at all? `MemoryRedis` implements the interface in-process (dev, tests, tiny single-instance deployments — note it is not durable).

## API

Everything is exported from the package root:

| Export | Purpose |
| --- | --- |
| `verifyMetaHubSignature(rawBody, header, appSecret)` / `computeHubSignature256(...)` | `X-Hub-Signature-256` HMAC-SHA256, timing-safe |
| `webhookVerificationResponse(query, verifyToken)` | One-time GET handshake (`hub.challenge`) |
| `normalizeWebhookPayload(payload)` | entries/changes → messages, skips statuses, resolves contact names |
| `jobForMessage(message, phoneNumberId, contactName?)` | Meta message → `WebhookMessageJob` (media → `metadata.mediaId/mimeType`) |
| `createMessageIdempotency({ redis, keyPrefix?, dedupTtlSeconds?, turnLockTtlSeconds? })` | `claimWebhookMessage` / `acquireTurnLock` / `releaseTurnLock` |
| `createShardedQueue({ redis, shardCount?, keyPrefix?, maxRetries? })` | `enqueue` / `dequeueFrom` / `fail` / `getStats` / `drainFrom` / `startWorker` / `stopWorker` |
| `hashFnv1a32` / `shardKeyFor` / `shardIndexFor` / `shardQueueKey` | Pure sharding helpers (stable, dependency-free) |
| `enqueueOrProcessInline(queue, processor, job)` | Survive Redis outages: queue it or process it inline |

## Who builds this

[UseFlowy](https://useflowy.com/?ref=github) — a WhatsApp-first bot platform for Latin-American businesses. This kit is the same receive pipeline our production traffic runs on, extracted as-is (same semantics, brand-free keys). If you'd rather not run pipelines at all, that's literally our product.

Contributions welcome — especially adapter experiences with different Redis clients and runtimes.

## License

[MIT](LICENSE) © UseFlowy
