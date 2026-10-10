import { strict as assert } from "node:assert";
import { test } from "node:test";

// Must be set before license.server is imported: IGG_VIP_OWNER seeds the owner
// key at module load, and IGG_VIP_MASTER keys the HMAC that fingerprints it.
process.env.IGG_VIP_MASTER = "test-master-key-with-enough-length";
process.env.IGG_VIP_OWNER = "IGG-OWNER-DELETE-TEST";
process.env.IGG_VIP_URL = "";
// No DATABASE_URL in this process, so the license store stays memory-only —
// which is what lets these tests exercise the delete path without a database.
delete process.env.DATABASE_URL;

const { deleteLicense, issueLicense, listLicenses, requireToken, restoreLicense, verifyLicenseKey } =
  await import("./server/license.server.ts");
const { LICENSE_STORE, licensesPersisted } = await import("./server/license-store.server.ts");

const OWNER_KEY = "IGG-OWNER-DELETE-TEST";

/** The owner token. Reusing one device id keeps the owner key's device list small. */
const owner = () => verifyLicenseKey(OWNER_KEY, "OWNER-DEVICE").token;

test("the store is inert without a database, so nothing here needs one", () => {
  assert.equal(LICENSE_STORE, "memory");
  assert.equal(licensesPersisted(), false);
});

test("delete: a deleted key is dead for the client and for the session it already opened", async () => {
  const token = owner();
  const row = await issueLicense(token, { plan: "month", note: "client A" });

  // the key works, and the client is now holding a live 12-hour token
  const session = verifyLicenseKey(row.key, "VIP-CLIENT-0001");
  assert.equal(requireToken(session.token).snap.status, "active");

  const res = await deleteLicense(token, row.key);
  assert.equal(res.ok, true);
  assert.equal(res.key, row.key);

  // gone from the panel
  assert.ok(
    !listLicenses(token).some((k) => k.key === row.key),
    "a deleted key must disappear from the key list",
  );

  // the string itself is dead — this is what the customer sees
  assert.throws(() => verifyLicenseKey(row.key, "VIP-CLIENT-0001"), /Invalid key/);

  // and the token they were already using dies with it
  assert.throws(() => requireToken(session.token), /License expired/);
});

test("delete: it is a delete, not a revocation — restore cannot bring the key back", async () => {
  const token = owner();
  const row = await issueLicense(token, { plan: "week", note: "client B" });
  await deleteLicense(token, row.key);

  await assert.rejects(async () => restoreLicense(token, { key: row.key }), /Unknown key/);
  assert.throws(() => verifyLicenseKey(row.key, "VIP-CLIENT-0002"), /Invalid key/);
});

test("delete: removing one key leaves every other key untouched", async () => {
  const token = owner();
  const doomed = await issueLicense(token, { plan: "week", note: "doomed" });
  const kept = await issueLicense(token, { plan: "month", note: "kept" });

  await deleteLicense(token, doomed.key);

  const still = verifyLicenseKey(kept.key, "VIP-CLIENT-0003");
  assert.equal(still.deviceId, "VIP-CLIENT-0003");
  assert.equal(requireToken(still.token).snap.status, "active");
});

test("delete: a group key dies for every device on it", async () => {
  const token = owner();
  const row = await issueLicense(token, { plan: "month", group: true, maxDevices: 3 });
  const a = verifyLicenseKey(row.key, "VIP-GROUP-0001").token;
  const b = verifyLicenseKey(row.key, "VIP-GROUP-0002").token;

  await deleteLicense(token, row.key);

  assert.throws(() => verifyLicenseKey(row.key, "VIP-GROUP-0003"), /Invalid key/);
  assert.throws(() => requireToken(a), /License expired/);
  assert.throws(() => requireToken(b), /License expired/);
});

test("delete: the owner key is protected — it is what opens this panel", async () => {
  const token = owner();
  await assert.rejects(async () => deleteLicense(token, OWNER_KEY), /owner key cannot be deleted/);
  assert.ok(listLicenses(token).some((k) => k.admin), "the owner key must still be listed");
  // still unlocks after the refused attempt
  assert.ok(verifyLicenseKey(OWNER_KEY, "OWNER-DEVICE").token);
});

test("delete: a customer's token cannot delete anything", async () => {
  const token = owner();
  const row = await issueLicense(token, { plan: "month", note: "client C" });
  const customer = verifyLicenseKey(row.key, "VIP-CLIENT-0004").token;

  await assert.rejects(async () => deleteLicense(customer, row.key), /Admin key required/);
  assert.ok(
    listLicenses(token).some((k) => k.key === row.key),
    "a refused delete must not remove the key",
  );
  // the customer's own key is unaffected
  assert.equal(requireToken(customer).snap.status, "active");
});

test("delete: an unknown key is refused rather than silently succeeding", async () => {
  const token = owner();
  await assert.rejects(
    async () => deleteLicense(token, "IGG-NOPE-1111-2222-3333-4444"),
    /Unknown key/,
  );
});

test("delete: a key reissued for the same machine comes back, because it is derived from the device", async () => {
  const token = owner();
  const first = await issueLicense(token, { plan: "week", bindDevice: "VIP-RENEW-0001" });
  await deleteLicense(token, first.key);
  assert.throws(() => verifyLicenseKey(first.key, "VIP-RENEW-0001"), /Invalid key/);

  // Deleting a key is not a device ban, and it cannot be one: a single-device
  // key with no custom string is `stableBoundKey(deviceId)`, so re-issuing to
  // that machine reproduces the same string. That is the documented renewal
  // behaviour ("create again = add time"), and it only happens when the owner
  // deliberately issues to that device again — nothing revives a deleted key
  // on its own.
  const second = await issueLicense(token, { plan: "week", bindDevice: "VIP-RENEW-0001" });
  assert.equal(second.key, first.key, "a reissued bound key is the same string by design");
  assert.equal(requireToken(verifyLicenseKey(second.key, "VIP-RENEW-0001").token).snap.status, "active");
});
