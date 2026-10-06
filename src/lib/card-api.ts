import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

/**
 * Server functions for the Cards tab. Same shape as `studio-api.ts`: validate,
 * require the license token, then dynamic-import the server module so the card
 * transport is only loaded when the tab is actually used.
 */

export const cardsLoadInfo = createServerFn({ method: "POST" })
  .validator(z.object({ token: z.string(), sessionId: z.string(), b64: z.string() }))
  .handler(async ({ data }) => {
    const { requireToken } = await import("./server/license.server");
    requireToken(data.token);
    const { loadCardInfo } = await import("./server/township/cardsend.server");
    return loadCardInfo(data.token, data.sessionId, data.b64);
  });

export const cardsSend = createServerFn({ method: "POST" })
  .validator(
    z.object({ token: z.string(), sessionId: z.string(), toCityId: z.string(), cardId: z.string() }),
  )
  .handler(async ({ data }) => {
    const { requireToken } = await import("./server/license.server");
    requireToken(data.token);
    const { sendCard } = await import("./server/township/cardsend.server");
    return sendCard(data.token, data.sessionId, data.toCityId, data.cardId);
  });

export const cardsCheckInbox = createServerFn({ method: "POST" })
  .validator(z.object({ token: z.string(), sessionId: z.string() }))
  .handler(async ({ data }) => {
    const { requireToken } = await import("./server/license.server");
    requireToken(data.token);
    const { checkInbox } = await import("./server/township/cardsend.server");
    return checkInbox(data.token, data.sessionId);
  });
