/** How long a claim is believable without a heartbeat. */
export const CLAIM_LEASE_MS = 90_000;

/** Largest integer interval whose first three opportunities are strictly before lease expiry. */
export const MAX_CLAIM_HEARTBEAT_INTERVAL_MS = Math.floor((CLAIM_LEASE_MS - 1) / 3);

/** The default uses the full safe interval while retaining three pre-expiry opportunities. */
export const CLAIM_HEARTBEAT_INTERVAL_MS = MAX_CLAIM_HEARTBEAT_INTERVAL_MS;
