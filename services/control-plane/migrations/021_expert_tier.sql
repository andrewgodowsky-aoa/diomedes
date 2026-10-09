-- Add the fourth tier without rewriting any historical charge or job.
-- Deploy before serving Expert; this migration grants no access or model route.
ALTER TABLE control_plane.funded_jobs DROP CONSTRAINT funded_jobs_tier_check;
ALTER TABLE control_plane.funded_jobs ADD CONSTRAINT funded_jobs_tier_check
  CHECK (tier IS NULL OR tier IN ('efficient','focused','thorough','expert'));

ALTER TABLE control_plane.funding_reservations DROP CONSTRAINT funding_reservations_charge_snapshot_check;
ALTER TABLE control_plane.funding_reservations ADD CONSTRAINT funding_reservations_charge_snapshot_check
  CHECK (charge_snapshot IS NULL OR (jsonb_typeof(charge_snapshot) = 'object'
    AND charge_snapshot ?& ARRAY['version','tier','tableVersion','ceilingMicroUsdPerCredit','inputMicroUsdPerMillion',
      'outputMicroUsdPerMillion','cacheReadMicroUsdPerMillion','cacheWriteMicroUsdPerMillion']
    AND charge_snapshot->>'tier' IN ('efficient','focused','thorough','expert')));
