/**
 * Webhook payload normalization: Meta's nested entries/changes flattened
 * into messages you can act on, plus the GET verification handshake.
 */

import type {
  MetaWebhookMessage,
  MetaWebhookPayload,
  NormalizedIncomingMessage,
  WebhookMessageJob,
} from "./types.js";

/**
 * Flattens a webhook payload into its incoming messages.
 *
 * - Skips payloads whose `object` is not `whatsapp_business_account`
 *   (Instagram/other Meta webhooks reuse the envelope).
 * - Skips changes that carry only `statuses` (delivery/read receipts).
 * - Resolves `contactName` by matching `contacts[].wa_id` to `message.from`.
 */
export function normalizeWebhookPayload(
  payload: MetaWebhookPayload,
): NormalizedIncomingMessage[] {
  if (!payload || payload.object !== "whatsapp_business_account") {
    return [];
  }

  const out: NormalizedIncomingMessage[] = [];
  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change?.value;
      const messages = value?.messages ?? [];
      if (messages.length === 0) continue; // statuses-only / empty change

      const phoneNumberId = value.metadata?.phone_number_id ?? "";
      const displayPhoneNumber = value.metadata?.display_phone_number;
      const contacts = value.contacts ?? [];

      for (const message of messages) {
        const contact = contacts.find((c) => c.wa_id === message.from);
        out.push({
          message,
          phoneNumberId,
          displayPhoneNumber,
          contactName: contact?.profile?.name,
        });
      }
    }
  }
  return out;
}

/**
 * Maps a Meta message into a `WebhookMessageJob`:
 * text bodies, media captions, or human-readable type markers; media
 * id/mime travel in `metadata` for downstream fetch/transcription.
 */
export function jobForMessage(
  message: MetaWebhookMessage,
  phoneNumberId: string,
  contactName?: string,
): WebhookMessageJob {
  let messageContent: string;
  switch (message.type) {
    case "text":
      messageContent = message.text?.body ?? "";
      break;
    case "image":
      messageContent = message.image?.caption || "[Image]";
      break;
    case "audio":
      messageContent = "[Audio message]";
      break;
    case "video":
      messageContent = message.video?.caption || "[Video]";
      break;
    case "document":
      messageContent =
        message.document?.caption ||
        `[Document: ${message.document?.filename || "file"}]`;
      break;
    default:
      messageContent = `[${message.type} message]`;
  }

  const mediaId =
    message.image?.id ||
    message.video?.id ||
    message.audio?.id ||
    message.document?.id;
  const mimeType =
    message.image?.mime_type ||
    message.video?.mime_type ||
    message.audio?.mime_type ||
    message.document?.mime_type;

  return {
    id: message.id,
    phoneNumberId,
    userPhone: message.from,
    userMessage: messageContent,
    messageType: message.type,
    contactName,
    timestamp: Date.now(),
    metadata: mediaId ? { mediaId, mimeType } : undefined,
  };
}

/**
 * Answers Meta's one-time webhook verification handshake (GET).
 * Returns the `hub.challenge` to echo back, or null to reject.
 */
export function webhookVerificationResponse(
  query: {
    "hub.mode"?: string;
    "hub.verify_token"?: string;
    "hub.challenge"?: string;
  },
  verifyToken: string,
): string | null {
  if (query["hub.mode"] !== "subscribe") return null;
  if (query["hub.verify_token"] !== verifyToken) return null;
  return query["hub.challenge"] ?? null;
}
