/**
 * Minimal Redis surface the kit depends on.
 *
 * The positional-args `SET key value EX ttl NX` style matches ioredis and
 * node-redis v4+, so you can pass your existing client directly.
 */

export interface RedisLike {
  /** SET with expiry, only-if-absent. Returns "OK" or null when the key exists. */
  set(
    key: string,
    value: string,
    mode: "EX",
    ttlSeconds: number,
    nx: "NX",
  ): Promise<string | null>;
  del(key: string): Promise<number>;
  /** Push to the head of a list (left side). */
  lpush(key: string, value: string): Promise<number>;
  /** Pop from the tail of a list (right side). Pairs with lpush for FIFO. */
  rpop(key: string): Promise<string | null>;
  llen(key: string): Promise<number>;
}

/**
 * In-memory RedisLike implementation — reference adapter for tests, local
 * development, and embedding the kit without a Redis instance.
 *
 * Set `failNext = true` to simulate one failed command (fault injection).
 */
export class MemoryRedis implements RedisLike {
  public readonly strings = new Map<
    string,
    { value: string; expiresAt: number | null }
  >();
  public readonly lists = new Map<string, string[]>();
  public failNext = false;

  private readonly now: () => number;

  constructor(opts: { now?: () => number } = {}) {
    this.now = opts.now ?? (() => Date.now());
  }

  private maybeThrow(): void {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("MemoryRedis: simulated failure");
    }
  }

  private purgeIfExpired(key: string): void {
    const entry = this.strings.get(key);
    if (entry && entry.expiresAt !== null && entry.expiresAt <= this.now()) {
      this.strings.delete(key);
    }
  }

  async set(
    key: string,
    value: string,
    _mode: "EX",
    ttlSeconds: number,
    _nx: "NX",
  ): Promise<string | null> {
    this.maybeThrow();
    this.purgeIfExpired(key);
    if (this.strings.has(key)) return null; // NX semantics
    this.strings.set(key, {
      value,
      expiresAt: this.now() + ttlSeconds * 1000,
    });
    return "OK";
  }

  async del(key: string): Promise<number> {
    this.maybeThrow();
    this.purgeIfExpired(key);
    return this.strings.delete(key) ? 1 : 0;
  }

  async lpush(key: string, value: string): Promise<number> {
    this.maybeThrow();
    const list = this.lists.get(key) ?? [];
    list.unshift(value);
    this.lists.set(key, list);
    return list.length;
  }

  async rpop(key: string): Promise<string | null> {
    this.maybeThrow();
    const list = this.lists.get(key);
    if (!list || list.length === 0) return null;
    return list.pop() ?? null;
  }

  async llen(key: string): Promise<number> {
    this.maybeThrow();
    return this.lists.get(key)?.length ?? 0;
  }
}
