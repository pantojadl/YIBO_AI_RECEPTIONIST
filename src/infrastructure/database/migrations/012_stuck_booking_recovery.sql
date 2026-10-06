-- Pending rows record when they were last written so crash recovery can ignore
-- an in-flight booking, and whether a failed calendar cancel still needs undoing.
ALTER TABLE appointments ADD COLUMN updated_at TEXT;
ALTER TABLE appointments ADD COLUMN compensation_required INTEGER NOT NULL DEFAULT 0
  CHECK (compensation_required IN (0, 1));

-- Stable results for cancel and reschedule retries. A second delivery of the same
-- key returns this row instead of calling the calendar again.
CREATE TABLE appointment_mutations (
  region_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('cancel', 'reschedule')),
  appointment_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  appointment_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (region_id, tenant_id, idempotency_key)
);

-- Caller-hung-up marks shared by every process that opens this database.
-- expires_at_ms is unix milliseconds; readers delete rows once they are due.
CREATE TABLE ended_calls (
  call_id TEXT NOT NULL PRIMARY KEY,
  ended_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL
);
