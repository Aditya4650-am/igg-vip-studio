-- License keys, persisted.
--
-- Before this table every key lived only in a Map inside license.server.ts, so
-- a Render restart or redeploy wiped the whole key set: clients came back to
-- "Invalid key" and the Control panel showed an empty list. This table is the
-- durable copy; the in-memory Map stays as the read cache so verifyLicenseKey()
-- / requireToken() keep their synchronous signatures.
--
-- One row per issued key. Deleting a key deletes its row, so a restart cannot
-- bring it back — that is what makes "Delete" permanent.
--
-- The owner/admin key is deliberately NOT stored: license.server.ts seeds it in
-- memory on every boot from IGG_VIP_OWNER, and refusing to delete an admin key
-- means no row for it can ever be orphaned. Keeping the owner key out of the
-- database is also one fewer copy of it in the world.
--
-- Column names are snake_case and avoid SQL reserved words (`group`, `key`)
-- so neither Postgres nor PGLite needs quoting.

create table if not exists licenses (
  license_key  text primary key,
  key_fp       text not null unique,
  plan         text not null,
  created_at   bigint not null,
  expires_at   bigint not null,
  duration_ms  bigint not null,
  is_group     boolean not null default false,
  max_devices  integer not null,
  devices      jsonb not null default '[]'::jsonb,
  bound_device text,
  is_active    boolean not null default true,
  note         text not null default ''
);

-- issueLicense() re-issues by looking a bound device up, so that lookup wants
-- an index rather than a sequential scan over every key ever issued.
create index if not exists licenses_bound_device_idx on licenses (bound_device);
