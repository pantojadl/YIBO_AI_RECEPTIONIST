-- A location claim stays live only while its owner refreshes heartbeat_ms.
-- Stealing increments fence. A writer may commit only while it still holds that fence.
ALTER TABLE appointment_operation_locks ADD COLUMN fence INTEGER NOT NULL DEFAULT 0;
ALTER TABLE appointment_operation_locks ADD COLUMN heartbeat_ms INTEGER NOT NULL DEFAULT 0;

ALTER TABLE appointments ADD COLUMN write_fence INTEGER NOT NULL DEFAULT 0;
ALTER TABLE appointments ADD COLUMN operation_intent TEXT;
ALTER TABLE appointments ADD COLUMN intent_key TEXT;
ALTER TABLE appointments ADD COLUMN intent_fingerprint TEXT;

-- in_flight keeps a hangup mark readable until the tool that was already running finishes.
ALTER TABLE ended_calls ADD COLUMN in_flight INTEGER NOT NULL DEFAULT 0;
