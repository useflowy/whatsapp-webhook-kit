/**
 * Shared types for the WhatsApp Cloud API webhook pipeline.
 */

/** A message as delivered by Meta inside a webhook `value.messages[]` array. */
export interface MetaWebhookMessage {
  from: string;
  id: string;
  timestamp: string;
  type: string;
  text?: { body?: string };
  image?: {
    id?: string;
    mime_type?: string;
    caption?: string;
    sha256?: string;
  };
  audio?: { id?: string; mime_type?: string; sha256?: string };
  video?: {
    id?: string;
    mime_type?: string;
    caption?: string;
    sha256?: string;
  };
  document?: {
    id?: string;
    filename?: string;
    mime_type?: string;
    caption?: string;
    sha256?: string;
  };
  /** Present when the message is a reply to another message. */
  context?: { id?: string };
}

/**
 * The POST body Meta sends to your webhook URL.
 * Reference: https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks/payload-examples
 */
export interface MetaWebhookPayload {
  object: string;
  entry: Array<{
    id: string;
    changes: Array<{
      field?: string;
      value: {
        messaging_product?: string;
        metadata?: {
          display_phone_number?: string;
          phone_number_id?: string;
        };
        contacts?: Array<{ profile?: { name?: string }; wa_id?: string }>;
        messages?: MetaWebhookMessage[];
        statuses?: unknown[];
      };
    }>;
  }>;
}

/** A single incoming message, contextualized after normalization. */
export interface NormalizedIncomingMessage {
  message: MetaWebhookMessage;
  /** The business phone number the message was sent to. */
  phoneNumberId: string;
  displayPhoneNumber?: string;
  /** Contact profile name, when Meta provides it for the sender. */
  contactName?: string;
}

/**
 * The unit of work your processor receives. `userMessage` carries the text
 * body, the media caption, or a type marker (`[Audio message]`,
 * `[Document: menu.pdf]`, ...). Media travels in `metadata` as
 * `{ mediaId, mimeType }` so the processor can fetch/transcribe it.
 */
export interface WebhookMessageJob {
  id: string;
  phoneNumberId: string;
  userPhone: string;
  userMessage: string;
  messageType: string;
  contactName?: string;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

/** Minimal logger contract. See `silentLogger` / `consoleLogger`. */
export interface LoggerLike {
  debug(msg: string, meta?: unknown): void;
  info(msg: string, meta?: unknown): void;
  warn(msg: string, meta?: unknown): void;
  error(msg: string, meta?: unknown): void;
}

export const silentLogger: LoggerLike = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

export const consoleLogger: LoggerLike = {
  debug: (msg, meta) => console.debug(meta ?? "", msg),
  info: (msg, meta) => console.info(meta ?? "", msg),
  warn: (msg, meta) => console.warn(meta ?? "", msg),
  error: (msg, meta) => console.error(meta ?? "", msg),
};
