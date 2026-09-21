import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

export const getCatalogs = createServerFn({ method: "POST" })
  .validator(z.object({ token: z.string() }))
  .handler(async ({ data }) => {
    const { requireToken } = await import("./server/license.server");
    requireToken(data.token);
    const { catalogs } = await import("./server/studio.server");
    return catalogs();
  });

export const verifyLicense = createServerFn({ method: "POST" })
  .validator(z.object({ key: z.string(), deviceId: z.string() }))
  .handler(async ({ data }) => {
    const { verifyLicenseKey } = await import("./server/license.server");
    return verifyLicenseKey(data.key, data.deviceId);
  });

export const getLicense = createServerFn({ method: "POST" })
  .validator(z.object({ token: z.string() }))
  .handler(async ({ data }) => {
    const { licenseStatus } = await import("./server/license.server");
    return licenseStatus(data.token);
  });

export const getRelease = createServerFn({ method: "POST" })
  .validator(z.object({ token: z.string() }))
  .handler(async ({ data }) => {
    const { getRelease: run } = await import("./server/update.server");
    return run(data.token);
  });

export const sendFeedback = createServerFn({ method: "POST" })
  .validator(z.object({ token: z.string(), message: z.string() }))
  .handler(async ({ data }) => {
    const { submitFeedback } = await import("./server/license.server");
    return submitFeedback(data.token, data.message);
  });

export const getDevices = createServerFn({ method: "POST" })
  .validator(z.object({ token: z.string() }))
  .handler(async ({ data }) => {
    const { requireToken } = await import("./server/license.server");
    requireToken(data.token);
    const { listDevices } = await import("./server/studio.server");
    return listDevices();
  });

export const connectLoad = createServerFn({ method: "POST" })
  .validator(
    z.object({
      token: z.string(),
      device: z.string(),
      saveXml: z.string().max(12_000_000).optional(),
      saveB64: z.string().max(24_000_000).optional(),
    }),
  )
  .handler(async ({ data }) => {
    const { connectLoad: run } = await import("./server/studio.server");
    return run(data.token, data.device, data.saveXml, undefined, data.saveB64);
  });

const saveSchema = z.object({
  token: z.string(),
  sessionId: z.string(),
  stats: z.record(z.string(), z.string()).optional(),
  profile: z.record(z.string(), z.array(z.string())).optional(),
  avatars: z.array(z.string()).optional(),
  skins: z.record(z.string(), z.array(z.string())).optional(),
  items: z.record(z.string(), z.number()).optional(),
  decor: z.array(z.string()).optional(),
  decorQty: z.number().optional(),
  sticker: z.array(z.string()).optional(),
  barnUpgrades: z.number().optional(),
  barnItems: z.record(z.string(), z.number()).optional(),
  regatta: z.boolean().optional(),
  season: z.boolean().optional(),
  unbanMode: z.enum(["inicial", "completo", "novo"]).optional(),
  decorFragments: z.boolean().optional(),
  decorClone: z.boolean().optional(),
  decorMaxAll: z.boolean().optional(),
});

export const saveAll = createServerFn({ method: "POST" })
  .validator(saveSchema)
  .handler(async ({ data }) => {
    const { applySave } = await import("./server/studio.server");
    return applySave(data);
  });

export const runRegatta = createServerFn({ method: "POST" })
  .validator(z.object({ token: z.string(), sessionId: z.string() }))
  .handler(async ({ data }) => {
    const { applyRegatta } = await import("./server/studio.server");
    return applyRegatta(data.token, data.sessionId);
  });

export const runSeason = createServerFn({ method: "POST" })
  .validator(z.object({ token: z.string(), sessionId: z.string() }))
  .handler(async ({ data }) => {
    const { applySeason } = await import("./server/studio.server");
    return applySeason(data.token, data.sessionId);
  });

export const refreshBarn = createServerFn({ method: "POST" })
  .validator(z.object({ token: z.string(), sessionId: z.string() }))
  .handler(async ({ data }) => {
    const { refreshBarn } = await import("./server/studio.server");
    return refreshBarn(data.token, data.sessionId);
  });

export const refreshOwn = createServerFn({ method: "POST" })
  .validator(z.object({ token: z.string(), sessionId: z.string(), saveB64: z.string().max(24_000_000) }))
  .handler(async ({ data }) => {
    const { refreshOwnSave } = await import("./server/studio.server");
    return refreshOwnSave(data.token, data.sessionId, data.saveB64);
  });

export const refreshFriends = createServerFn({ method: "POST" })
  .validator(z.object({ token: z.string(), sessionId: z.string() }))
  .handler(async ({ data }) => {
    const { loadFriends } = await import("./server/studio.server");
    return loadFriends(data.token, data.sessionId);
  });

export const fetchCity = createServerFn({ method: "POST" })
  .validator(z.object({ token: z.string(), sessionId: z.string(), cityId: z.string() }))
  .handler(async ({ data }) => {
    const { fetchFriendCity } = await import("./server/studio.server");
    return fetchFriendCity(data.token, data.sessionId, data.cityId);
  });

export const applyUnban = createServerFn({ method: "POST" })
  .validator(
    z.object({
      token: z.string(),
      sessionId: z.string(),
      mode: z.enum(["inicial", "completo", "novo"]),
    }),
  )
  .handler(async ({ data }) => {
    const { applyUnban } = await import("./server/studio.server");
    return applyUnban(data.token, data.sessionId, data.mode);
  });

export const attachFriendCity = createServerFn({ method: "POST" })
  .validator(z.object({ token: z.string(), sessionId: z.string(), xml: z.string().max(12_000_000) }))
  .handler(async ({ data }) => {
    const { attachFriendXml } = await import("./server/studio.server");
    return attachFriendXml(data.token, data.sessionId, data.xml);
  });

export const attachLocal = createServerFn({ method: "POST" })
  .validator(z.object({ token: z.string(), sessionId: z.string(), b64: z.string().max(2_000_000) }))
  .handler(async ({ data }) => {
    const { attachLocalInfoBase64 } = await import("./server/studio.server");
    return attachLocalInfoBase64(data.token, data.sessionId, data.b64);
  });

export const runDecor = createServerFn({ method: "POST" })
  .validator(
    z.object({
      token: z.string(),
      sessionId: z.string(),
      action: z.enum(["stash", "fragments", "emoji", "clone"]),
      ids: z.array(z.string()).optional(),
    }),
  )
  .handler(async ({ data }) => {
    const { applyDecorActions } = await import("./server/studio.server");
    return applyDecorActions(data.token, data.sessionId, data.action, data.ids ?? []);
  });
