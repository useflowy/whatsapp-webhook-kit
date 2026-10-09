/**
 * Sharded message queue: per-conversation FIFO without global
 * head-of-line blocking.
 *
 * One Redis list per shard (`<prefix>s0..sN-1`), one worker loop per shard.
 * A stable hash of `(phoneNumberId, userPhone)` maps a conversation to
 * ALWAYS the same shard, so:
 *
 *   - messages of one conversation are processed strictly in order
 *     (single loop, LPUSH in / RPOP out)
 *   - different conversations land on different shards and run in parallel
 *
 * FNV-1a 32-bit is used for hashing: deterministic across processes and
 * deploys, dependency-free, uniform enough for small shard counts.
 *
 * Robustness:
 *   - retries re-enter THEIR OWN shard (conversation order preserved; a
 *     poison message defers to fresher ones instead of blocking them)
 *   - `onDropped` dead-letter callback when retries are exhausted
 *   - circuit breaker + exponential backoff on consecutive loop errors
 *   - `drainFrom` migrates jobs from any list key (e.g. your old
 *     single-queue setup) into their shards
 */

import type { RedisLike } from "./redis.js";
import { silentLogger, type LoggerLike } from "./logger.js";
import type { WebhookMessageJob } from "./types.js";

export const DEFAULT_QUEUE_KEY_PREFIX = "wa-kit:queue:";
export const DEFAULT_SHARD_COUNT = 4;
export const DEFAULT_MAX_RETRIES = 3;
const MAX_SHARD_COUNT = 64;

// Circuit breaker
const MAX_CONSECUTIVE_ERRORS = 5;
const INITIAL_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30000;
const BACKOFF_MULTIPLIER = 2;

// ─── Sharding (pure functions) ──────────────────────────────────────────────

/** FNV-1a 32-bit over a string. Deterministic across processes. */
export function hashFnv1a32(key: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Stable conversation identity: the business number + the user's phone. */
export function shardKeyFor(
  job: Pick<WebhookMessageJob, "phoneNumberId" | "userPhone">,
): string {
  return `${job.phoneNumberId}:${job.userPhone}`;
}

/** Shard index for a conversation — stable for a given shardCount. */
export function shardIndexFor(
  job: Pick<WebhookMessageJob, "phoneNumberId" | "userPhone">,
  shardCount: number,
): number {
  return hashFnv1a32(shardKeyFor(job)) % shardCount;
}

/** Redis list key of shard `index`. */
export function shardQueueKey(index: number, prefix = DEFAULT_QUEUE_KEY_PREFIX): string {
  return `${prefix}s${index}`;
}

// ─── Queue ──────────────────────────────────────────────────────────────────

export interface ShardedQueueOptions {
  redis: RedisLike;
  /** Number of shards (parallel conversation lanes). Default 4, clamp 1..64. */
  shardCount?: number;
  /** Redis key prefix for the shard lists. Default `wa-kit:queue:`. */
  keyPrefix?: string;
  /** Attempts per job before dropping (passed to `onDropped`). Default 3. */
  maxRetries?: number;
  logger?: LoggerLike;
}

export interface QueueStats {
  queued: number;
  shardCount: number;
  shardQueued: number[];
  isRunning: boolean;
  consecutiveErrors: number;
  currentBackoffMs: number;
  lastError: string | null;
  lastSuccessfulDequeue: number | null;
}

export interface ShardedQueue {
  /** Adds a job, routed to its conversation's shard. `false` = Redis down. */
  enqueue(job: WebhookMessageJob): Promise<boolean>;
  /** Non-blocking pop from a specific shard list (used by the worker). */
  dequeueFrom(key: string): Promise<WebhookMessageJob | null>;
  complete(jobId: string): Promise<void>;
  /**
   * Handles a processing failure: re-queues into the job's own shard with
   * `retryCount + 1`, or drops it after max retries (`false`).
   */
  fail(job: WebhookMessageJob, error: string): Promise<boolean>;
  getStats(): Promise<QueueStats>;
  /** Moves every job from `sourceKey` into its shard (best-effort). */
  drainFrom(sourceKey: string): Promise<number>;
  shouldPause(): boolean;
  /**
   * Starts one loop per shard calling `processor(job)`. Returns a stop
   * function. `onDropped(job, error)` is your dead-letter hook — without
   * it, exhausted jobs vanish silently (Meta already got its 200).
   */
  startWorker(
    processor: (job: WebhookMessageJob) => Promise<void>,
    opts?: {
      idlePollMs?: number;
      shardCount?: number;
      onDropped?: (job: WebhookMessageJob, error: string) => void;
    },
  ): Promise<() => void>;
  stopWorker(): void;
}

interface WorkerState {
  isRunning: boolean;
  consecutiveErrors: number;
  lastError: string | null;
  lastSuccessfulDequeue: number | null;
  currentBackoffMs: number;
}

function calculateBackoff(
  currentBackoffMs: number,
  consecutiveErrors: number,
): number {
  const backoff = Math.min(
    currentBackoffMs * Math.pow(BACKOFF_MULTIPLIER, consecutiveErrors - 1),
    MAX_BACKOFF_MS,
  );
  return Math.max(backoff, INITIAL_BACKOFF_MS);
}

export function createShardedQueue(
  options: ShardedQueueOptions,
): ShardedQueue {
  const {
    redis,
    keyPrefix = DEFAULT_QUEUE_KEY_PREFIX,
    maxRetries = DEFAULT_MAX_RETRIES,
    logger = silentLogger,
  } = options;
  const configuredShardCount = Math.min(
    MAX_SHARD_COUNT,
    Math.max(1, options.shardCount ?? DEFAULT_SHARD_COUNT),
  );

  // Shard count frozen while a worker runs, so enqueue and the loops agree
  // even if the queue is reconfigured.
  let activeShardCount: number | null = null;

  const state: WorkerState = {
    isRunning: false,
    consecutiveErrors: 0,
    lastError: null,
    lastSuccessfulDequeue: null,
    currentBackoffMs: INITIAL_BACKOFF_MS,
  };

  function resetBackoff(): void {
    state.consecutiveErrors = 0;
    state.currentBackoffMs = INITIAL_BACKOFF_MS;
  }

  const queue: ShardedQueue = {
    async enqueue(job: WebhookMessageJob): Promise<boolean> {
      try {
        const shards = activeShardCount ?? configuredShardCount;
        const key = shardQueueKey(shardIndexFor(job, shards), keyPrefix);
        await redis.lpush(key, JSON.stringify(job));
        logger.debug("message enqueued", { jobId: job.id, shard: key });
        return true;
      } catch (error) {
        logger.error("enqueue failed", { error: String(error), jobId: job.id });
        return false;
      }
    },

    async dequeueFrom(key: string): Promise<WebhookMessageJob | null> {
      try {
        const jobJson = await redis.rpop(key);
        if (!jobJson) return null;
        state.lastSuccessfulDequeue = Date.now();
        resetBackoff();
        return JSON.parse(jobJson) as WebhookMessageJob;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        state.lastError = `dequeue failed: ${message}`;
        logger.error("dequeue failed", { error: message, key });
        return null;
      }
    },

    async complete(jobId: string): Promise<void> {
      logger.debug("job completed", { jobId });
    },

    async fail(job: WebhookMessageJob, error: string): Promise<boolean> {
      try {
        const retryCount = Number(job.metadata?.retryCount ?? 0) + 1;
        if (retryCount > maxRetries) {
          logger.error("job dropped after max retries", {
            jobId: job.id,
            error,
            retryCount,
          });
          return false;
        }
        const shards = activeShardCount ?? configuredShardCount;
        const key = shardQueueKey(shardIndexFor(job, shards), keyPrefix);
        const retryJob: WebhookMessageJob = {
          ...job,
          metadata: { ...job.metadata, retryCount, lastError: error },
        };
        await redis.lpush(key, JSON.stringify(retryJob));
        logger.warn("job re-queued for retry", {
          jobId: job.id,
          retryCount,
          shard: key,
        });
        return true;
      } catch (requeueError) {
        logger.error("failed to requeue job", {
          error: String(requeueError),
          jobId: job.id,
        });
        return false;
      }
    },

    async getStats(): Promise<QueueStats> {
      const base = {
        shardCount: activeShardCount ?? configuredShardCount,
        isRunning: state.isRunning,
        consecutiveErrors: state.consecutiveErrors,
        currentBackoffMs: state.currentBackoffMs,
        lastError: state.lastError,
        lastSuccessfulDequeue: state.lastSuccessfulDequeue,
      };
      try {
        const shards = activeShardCount ?? configuredShardCount;
        const shardQueued: number[] = [];
        for (let i = 0; i < shards; i++) {
          shardQueued.push(await redis.llen(shardQueueKey(i, keyPrefix)));
        }
        return {
          queued: shardQueued.reduce((acc, n) => acc + n, 0),
          shardQueued,
          ...base,
        };
      } catch (error) {
        logger.error("stats failed", { error: String(error) });
        return { queued: 0, shardQueued: [], ...base };
      }
    },

    async drainFrom(sourceKey: string): Promise<number> {
      let drained = 0;
      try {
        for (;;) {
          const jobJson = await redis.rpop(sourceKey);
          if (!jobJson) break;
          try {
            const job = JSON.parse(jobJson) as WebhookMessageJob;
            const ok = await this.enqueue(job);
            if (ok) drained++;
            else break; // enqueue unavailable: stop instead of losing more
          } catch (parseError) {
            logger.error("drain: invalid job discarded", {
              error: String(parseError),
            });
          }
        }
        if (drained > 0) {
          logger.info("queue drained into shards", { drained, sourceKey });
        }
        return drained;
      } catch (error) {
        logger.error("drain failed", { error: String(error), sourceKey });
        return drained;
      }
    },

    shouldPause(): boolean {
      return state.consecutiveErrors >= MAX_CONSECUTIVE_ERRORS;
    },

    async startWorker(
      processor: (job: WebhookMessageJob) => Promise<void>,
      opts?: {
        idlePollMs?: number;
        shardCount?: number;
        onDropped?: (job: WebhookMessageJob, error: string) => void;
      },
    ): Promise<() => void> {
      if (state.isRunning) {
        logger.warn("worker already running");
        return () => this.stopWorker();
      }

      const idlePollMs = opts?.idlePollMs ?? 1000;
      const shardCount = Math.min(
        MAX_SHARD_COUNT,
        Math.max(1, opts?.shardCount ?? configuredShardCount),
      );
      activeShardCount = shardCount;
      state.isRunning = true;
      resetBackoff();

      logger.info("starting sharded queue workers", {
        shardCount,
        shardKeys: Array.from({ length: shardCount }, (_, i) =>
          shardQueueKey(i, keyPrefix),
        ),
      });

      const loop = async (index: number): Promise<void> => {
        const key = shardQueueKey(index, keyPrefix);
        while (state.isRunning) {
          try {
            if (queue.shouldPause()) {
              logger.warn("circuit breaker OPEN — backing off", {
                shard: key,
                consecutiveErrors: state.consecutiveErrors,
                backoffMs: state.currentBackoffMs,
              });
              await new Promise((resolve) =>
                setTimeout(resolve, state.currentBackoffMs),
              );
              state.currentBackoffMs = calculateBackoff(
                state.currentBackoffMs,
                state.consecutiveErrors,
              );
              continue;
            }

            const job = await queue.dequeueFrom(key);
            if (job) {
              try {
                await processor(job);
                await queue.complete(job.id);
              } catch (error) {
                const message =
                  error instanceof Error ? error.message : String(error);
                const requeued = await queue.fail(job, message);
                if (!requeued) {
                  try {
                    opts?.onDropped?.(job, message);
                  } catch (callbackError) {
                    logger.error("onDropped callback failed (non-fatal)", {
                      error: String(callbackError),
                      jobId: job.id,
                    });
                  }
                }
              }
            } else {
              await new Promise((resolve) => setTimeout(resolve, idlePollMs));
            }
          } catch (error) {
            state.consecutiveErrors++;
            state.currentBackoffMs = calculateBackoff(
              state.currentBackoffMs,
              state.consecutiveErrors,
            );
            logger.error("worker loop error", {
              error: String(error),
              shard: key,
              consecutiveErrors: state.consecutiveErrors,
            });
            await new Promise((resolve) =>
              setTimeout(resolve, state.currentBackoffMs),
            );
          }
        }
      };

      for (let i = 0; i < shardCount; i++) {
        void loop(i);
      }

      return () => this.stopWorker();
    },

    stopWorker(): void {
      if (!state.isRunning) return;
      logger.info("stopping sharded queue workers");
      state.isRunning = false;
      resetBackoff();
    },
  };

  return queue;
}
