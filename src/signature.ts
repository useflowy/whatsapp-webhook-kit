/**
 * X-Hub-Signature-256 verification for Meta (WhatsApp / Facebook) webhooks.
 *
 * Meta signs the RAW request body with your App Secret:
 *   X-Hub-Signature-256: sha256=<hex HMAC-SHA256>
 *
 * Always verify against the raw body string/Buffer — re-serialized JSON
 * produces a different signature.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

export function computeHubSignature256(
  rawBody: string | Buffer,
  appSecret: string,
): string {
  return `sha256=${createHmac("sha256", appSecret).update(rawBody).digest("hex")}`;
}

export function verifyMetaHubSignature(
  rawBody: string | Buffer,
  headerValue: string | null | undefined,
  appSecret: string,
): boolean {
  if (!headerValue || !appSecret) return false;
  if (!headerValue.startsWith("sha256=")) return false;

  const expected = Buffer.from(
    computeHubSignature256(rawBody, appSecret),
    "utf8",
  );
  const provided = Buffer.from(headerValue, "utf8");
  if (expected.length !== provided.length) return false;
  return timingSafeEqual(expected, provided);
}
