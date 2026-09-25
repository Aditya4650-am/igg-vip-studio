import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const planEnum = z.enum(["trial", "week", "month", "year", "lifetime", "custom"]);

export const issueKey = createServerFn({ method: "POST" })
  .validator(
    z.object({
      token: z.string(),
      plan: planEnum,
      customKey: z.string().optional(),
      days: z.number().optional(),
      hours: z.number().optional(),
      group: z.boolean().optional(),
      maxDevices: z.number().optional(),
      note: z.string().optional(),
      bindDevice: z.string().optional(),
    }),
  )
  .handler(async ({ data }) => {
    const { issueLicense } = await import("./server/license.server");
    const { token, ...rest } = data;
    return issueLicense(token, rest);
  });

export const restoreKey = createServerFn({ method: "POST" })
  .validator(
    z.object({
      token: z.string(),
      key: z.string(),
      plan: planEnum.optional(),
      days: z.number().optional(),
      hours: z.number().optional(),
    }),
  )
  .handler(async ({ data }) => {
    const { restoreLicense } = await import("./server/license.server");
    return restoreLicense(data.token, data);
  });

export const listKeys = createServerFn({ method: "POST" })
  .validator(z.object({ token: z.string() }))
  .handler(async ({ data }) => {
    const { listLicenses } = await import("./server/license.server");
    return listLicenses(data.token);
  });

export const listInbox = createServerFn({ method: "POST" })
  .validator(z.object({ token: z.string() }))
  .handler(async ({ data }) => {
    const { listFeedback } = await import("./server/license.server");
    return listFeedback(data.token);
  });

export const publishUpdate = createServerFn({ method: "POST" })
  .validator(z.object({ token: z.string(), version: z.string(), notes: z.string(), downloadUrl: z.string().url(), sha256: z.string().regex(/^[a-fA-F0-9]{64}$/) }))
  .handler(async ({ data }) => {
    const { publishRelease } = await import("./server/update.server");
    return publishRelease(data.token, { version: data.version, notes: data.notes, downloadUrl: data.downloadUrl, sha256: data.sha256 });
  });
