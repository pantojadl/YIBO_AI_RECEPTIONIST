ALTER TABLE appointments ADD COLUMN version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1);

-- A durable, location-scoped mutex shared by API and voice processes. No automatic
-- expiry: a slow provider or crashed process must not allow a second writer.
CREATE TABLE appointment_operation_locks (
  region_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  location_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  owner_pid INTEGER NOT NULL,
  acquired_at TEXT NOT NULL,
  PRIMARY KEY (region_id, tenant_id, location_id)
);
