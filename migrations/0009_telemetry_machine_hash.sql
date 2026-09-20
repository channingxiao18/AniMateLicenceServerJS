-- Additive only: telemetry-compatible machine hash for identity linking.
--
-- The client sends `machine_hash = sha256("animate-telemetry-v1:" + product_uuid)`
-- in every telemetry envelope. The backend already decrypts the device
-- fingerprint on trial/activation (services/activation.ts), so it can compute
-- the same value and persist it here — that joins paid/trial machines to their
-- behaviour stream without touching the telemetry tables
-- (AniMate repo: docs/product/telemetry-plan.md, G-8).
--
-- No existing column is renamed, retyped or dropped; both new columns are
-- nullable so historical rows remain valid.

ALTER TABLE `trial_grants` ADD COLUMN `telemetry_machine_hash` text;
ALTER TABLE `activations` ADD COLUMN `telemetry_machine_hash` text;

CREATE INDEX `trial_grants_telemetry_machine_idx`
  ON `trial_grants` (`telemetry_machine_hash`);
CREATE INDEX `activations_telemetry_machine_idx`
  ON `activations` (`telemetry_machine_hash`);
