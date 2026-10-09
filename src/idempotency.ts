/**
 * Idempotency: exactly-once message intake and turn locks, backed by
 * atomic SET NX keys.
 *
 * Meta redelivers webhooks aggressively (timeouts, retries, replays).
 * Dedup with GET-then-SET has a TOCTOU race: two concurrent deliveries
 * both pass the GET and both process. `SET ... NX` closes the race —
 * one atomic operation decides the winner.
 *
 * Fail-open philosophy: if Redis is down, claims resolve as "proceed"
 * and turn locks as "unavailable". A degraded dedup window is better
 * than silently dropping messages — the webhook already answered 200.
 */

import type { RedisLike } from "./redis.js";
import { silentLogger, type LoggerLike } from "./logger.js";

export const DEFAULT_KEY_PREFIX = "wa-kit:";
/** Dedup window for webhook redeliveries (Meta retries within minutes). */
export const DEFAULT_DEDUP_TTL_SECONDS = 600;
/** Turn-lock window: covers worker retries and late Meta redeliveries. */
export const DEFAULT_TURN_LOCK_TTL_SECONDS = 900;

export type TurnLockOutcome = "acquired" | "duplicate" | "unavailable";

export interface MessageIdempotencyOptions {
  redis: RedisLike;
  /** Key prefix for namespacing (default `wa-kit:`). */
  keyPrefix?: string;
  dedupTtlSeconds?: number;
  turnLockTtlSeconds?: number;
  logger?: LoggerLike;
}

export interface MessageIdempotency {
  /**
   * Claims an incoming webhook message. `true` = proceed (first delivery,
   * or Redis unavailable — fail-open); `false` = duplicate delivery.
   */
  claimWebhookMessage(messageId: string): Promise<boolean>;
  /**
   * Reserves the processing turn for a message. `duplicate` means the turn
   * already ran (or is in flight) — skip. `unavailable` means Redis is
   * down — apply your own fallback (e.g. a DB-level guard).
   */
  acquireTurnLock(messageId: string): Promise<TurnLockOutcome>;
  /**
   * Releases the turn lock — ONLY when the turn failed before producing
   * a response, so the retry runs clean. Best-effort.
   */
  releaseTurnLock(messageId: string): Promise<void>;
}

export function createMessageIdempotency(
  options: MessageIdempotencyOptions,
): MessageIdempotency {
  const {
    redis,
    keyPrefix = DEFAULT_KEY_PREFIX,
    dedupTtlSeconds = DEFAULT_DEDUP_TTL_SECONDS,
    turnLockTtlSeconds = DEFAULT_TURN_LOCK_TTL_SECONDS,
    logger = silentLogger,
  } = options;

  return {
    async claimWebhookMessage(messageId: string): Promise<boolean> {
      try {
        const claimed = await redis.set(
          `${keyPrefix}msg:${messageId}`,
          "1",
          "EX",
          dedupTtlSeconds,
          "NX",
        );
        return claimed !== null;
      } catch (error) {
        logger.warn("dedup claim failed — proceeding (fail-open)", {
          error: String(error),
          messageId,
        });
        return true;
      }
    },

    async acquireTurnLock(messageId: string): Promise<TurnLockOutcome> {
      try {
        const claimed = await redis.set(
          `${keyPrefix}turn:${messageId}`,
          "1",
          "EX",
          turnLockTtlSeconds,
          "NX",
        );
        return claimed === null ? "duplicate" : "acquired";
      } catch {
        return "unavailable";
      }
    },

    async releaseTurnLock(messageId: string): Promise<void> {
      try {
        await redis.del(`${keyPrefix}turn:${messageId}`);
      } catch {
        // Best-effort: a residual lock makes the next attempt look like a
        // duplicate — worst case, THAT retry is skipped.
      }
    },
  };
}
