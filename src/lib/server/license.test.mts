import { strict as assert } from "node:assert";
import { test } from "node:test";

process.env.IGG_VIP_MASTER = "test-master-key-with-enough-length";
process.env.IGG_VIP_OWNER = "IGG-OWNER-TESTKEY";

const license = await import("./license.server.ts");

const ownerToken = license.verifyLicenseKey("IGG-OWNER-TESTKEY", "OWNER-DEV-1").token;
const demoToken = license.verifyLicenseKey("VIP-DEMO", "DEMO-DEV-1").token;

test("owner can delete an issued key and it stops working everywhere", () => {
  const row = license.issueLicense(ownerToken, { plan: "week", note: "del-me" });
  const before = license.verifyLicenseKey(row.key, "VICTIM-DEV-1");
  assert.ok(before.token, "key must verify before deletion");
  const res = license.deleteLicense(ownerToken, row.key);
  assert.equal(res.key, row.key);
  assert.throws(() => license.verifyLicenseKey(row.key, "VICTIM-DEV-2"), /Invalid key/, "deleted key must not verify");
  assert.throws(() => license.licenseStatus(before.token), /./, "tokens minted before deletion must stop working");
});

test("the owner key itself cannot be removed", () => {
  assert.throws(() => license.deleteLicense(ownerToken, "IGG-OWNER-TESTKEY"), /owner key/i);
  // Owner still works afterwards.
  assert.ok(license.verifyLicenseKey("IGG-OWNER-TESTKEY", "OWNER-DEV-2").token);
});

test("non-admin tokens cannot delete keys", () => {
  assert.throws(() => license.deleteLicense(demoToken, "VIP-TRIAL"), /Admin key required/);
  // The targeted seed key is untouched.
  assert.ok(license.verifyLicenseKey("VIP-TRIAL", "TRIAL-DEV-9").token);
});

test("deleting an unknown key fails without side effects", () => {
  assert.throws(() => license.deleteLicense(ownerToken, "NOPE-NOPE"), /Unknown key/);
});
