/**
 * Enqueue-or-inline fallback: survival mode when the queue is down.
 *
 * `enqueue()` resolves `false` (it never throws) when Redis is unavailable.
 * Without a fallback the message is silently lost — Meta already received
 * its 200 and will not redeliver. Processing inline degrades throughput
 * (the webhook request takes the hit) but keeps the bot answering.
 */

import type { ShardedQueue } from "./queue.js";
import { silentLogger, type LoggerLike } from "./logger.js";
import type { WebhookMessageJob } from "./types.js";

export type EnqueueOutcome = "enqueued" | "processed-inline";

export async function enqueueOrProcessInline(
  queue: Pick<ShardedQueue, "enqueue">,
  processor: (job: WebhookMessageJob) => Promise<void>,
  job: WebhookMessageJob,
  logger: LoggerLike = silentLogger,
): Promise<EnqueueOutcome> {
  const enqueued = await queue.enqueue(job).catch((error) => {
    logger.error("enqueue failed", { error: String(error), messageId: job.id });
    return false;
  });

  if (enqueued) return "enqueued";

  logger.error("queue unavailable — processing message inline", {
    messageId: job.id,
  });
  await processor(job);
  return "processed-inline";
}
