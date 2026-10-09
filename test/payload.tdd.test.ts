import { describe, it, expect } from "vitest";
import {
  normalizeWebhookPayload,
  jobForMessage,
  webhookVerificationResponse,
} from "../src/payload.js";
import type { MetaWebhookPayload } from "../src/types.js";

function metaPayload(
  overrides: Partial<MetaWebhookPayload> = {},
): MetaWebhookPayload {
  return {
    object: "whatsapp_business_account",
    entry: [],
    ...overrides,
  };
}

describe("payload: webhook normalization", () => {
  it("E2.1 — flattens N entries x M changes x K messages with phoneNumberId and contactName", () => {
    const payload = metaPayload({
      entry: [
        {
          id: "wba-1",
          changes: [
            {
              field: "messages",
              value: {
                messaging_product: "whatsapp",
                metadata: {
                  display_phone_number: "+11111111111",
                  phone_number_id: "pnid-1",
                },
                contacts: [{ profile: { name: "Alice" }, wa_id: "+51999999999" }],
                messages: [
                  {
                    from: "+51999999999",
                    id: "wamid.A",
                    timestamp: "1760000000",
                    type: "text",
                    text: { body: "hola" },
                  },
                  {
                    from: "+51999999999",
                    id: "wamid.B",
                    timestamp: "1760000001",
                    type: "text",
                    text: { body: "segundo" },
                  },
                ],
              },
            },
          ],
        },
        {
          id: "wba-2",
          changes: [
            {
              field: "messages",
              value: {
                metadata: { phone_number_id: "pnid-2" },
                messages: [
                  {
                    from: "+51988888888",
                    id: "wamid.C",
                    timestamp: "1760000002",
                    type: "text",
                    text: { body: "otro numero" },
                  },
                ],
              },
            },
          ],
        },
      ],
    });

    const result = normalizeWebhookPayload(payload);

    expect(result).toHaveLength(3);
    expect(result[0]).toMatchObject({
      phoneNumberId: "pnid-1",
      contactName: "Alice",
      message: { id: "wamid.A" },
    });
    expect(result[1]!.message.id).toBe("wamid.B");
    expect(result[2]!.phoneNumberId).toBe("pnid-2");
    expect(result[2]!.contactName).toBeUndefined();
  });

  it("E2.2 — ignores changes that only carry statuses (delivery receipts)", () => {
    const payload = metaPayload({
      entry: [
        {
          id: "wba-1",
          changes: [
            {
              value: {
                metadata: { phone_number_id: "pnid-1" },
                statuses: [
                  { id: "wamid.X", status: "delivered", timestamp: "1" },
                ],
              },
            },
          ],
        },
      ],
    });

    expect(normalizeWebhookPayload(payload)).toHaveLength(0);
  });

  it("E2.2b — ignores entries whose object is not whatsapp_business_account", () => {
    const payload = metaPayload({
      object: "something_else",
      entry: [
        {
          id: "x",
          changes: [
            {
              value: {
                metadata: { phone_number_id: "pnid" },
                messages: [
                  {
                    from: "1",
                    id: "wamid.Z",
                    timestamp: "1",
                    type: "text",
                    text: { body: "?" },
                  },
                ],
              },
            },
          ],
        },
      ],
    });

    expect(normalizeWebhookPayload(payload)).toHaveLength(0);
  });

  it("E2.3 — maps message types into a job (text/media/document markers)", () => {
    const base = { phoneNumberId: "pnid-1" };

    const textJob = jobForMessage(
      {
        from: "+51999999999",
        id: "wamid.1",
        timestamp: "1760000000",
        type: "text",
        text: { body: "hola mundo" },
      },
      base.phoneNumberId,
    );
    expect(textJob.userMessage).toBe("hola mundo");
    expect(textJob.messageType).toBe("text");
    expect(textJob.userPhone).toBe("+51999999999");
    expect(textJob.metadata).toBeUndefined();

    const imageJob = jobForMessage(
      {
        from: "+51999999999",
        id: "wamid.2",
        timestamp: "1760000000",
        type: "image",
        image: { id: "media-2", mime_type: "image/jpeg", caption: "mira esto" },
      },
      base.phoneNumberId,
    );
    expect(imageJob.userMessage).toBe("mira esto");
    expect(imageJob.metadata).toEqual({
      mediaId: "media-2",
      mimeType: "image/jpeg",
    });

    const audioJob = jobForMessage(
      {
        from: "+51999999999",
        id: "wamid.3",
        timestamp: "1760000000",
        type: "audio",
        audio: { id: "media-3", mime_type: "audio/ogg" },
      },
      base.phoneNumberId,
    );
    expect(audioJob.userMessage).toBe("[Audio message]");
    expect(audioJob.metadata).toEqual({
      mediaId: "media-3",
      mimeType: "audio/ogg",
    });

    const docJob = jobForMessage(
      {
        from: "+51999999999",
        id: "wamid.4",
        timestamp: "1760000000",
        type: "document",
        document: { id: "media-4", mime_type: "application/pdf", filename: "menu.pdf" },
      },
      base.phoneNumberId,
    );
    expect(docJob.userMessage).toBe("[Document: menu.pdf]");

    const unknownJob = jobForMessage(
      {
        from: "+51999999999",
        id: "wamid.5",
        timestamp: "1760000000",
        type: "sticker",
      },
      base.phoneNumberId,
    );
    expect(unknownJob.userMessage).toBe("[sticker message]");
  });

  it("E2.3b — job carries contactName when provided", () => {
    const job = jobForMessage(
      {
        from: "+51999999999",
        id: "wamid.N",
        timestamp: "1",
        type: "text",
        text: { body: "x" },
      },
      "pnid",
      "Bob",
    );
    expect(job.contactName).toBe("Bob");
    expect(job.id).toBe("wamid.N");
    expect(typeof job.timestamp).toBe("number");
  });

  it("E2.4 — webhook verification returns hub.challenge on subscribe with valid token", () => {
    const challenge = "314159265358979";
    const ok = webhookVerificationResponse(
      {
        "hub.mode": "subscribe",
        "hub.verify_token": "my-verify-token",
        "hub.challenge": challenge,
      },
      "my-verify-token",
    );
    expect(ok).toBe(challenge);
  });

  it("E2.4b — webhook verification rejects wrong token or wrong mode", () => {
    expect(
      webhookVerificationResponse(
        {
          "hub.mode": "subscribe",
          "hub.verify_token": "nope",
          "hub.challenge": "123",
        },
        "my-verify-token",
      ),
    ).toBeNull();

    expect(
      webhookVerificationResponse(
        {
          "hub.mode": "unsubscribe",
          "hub.verify_token": "my-verify-token",
          "hub.challenge": "123",
        },
        "my-verify-token",
      ),
    ).toBeNull();
  });
});
