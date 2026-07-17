/**
 * THE APPROVED-ONLY RULE, in one place.
 *
 * Customers may only ever see — and order from — APPROVED shops.
 *
 * Every customer-facing query pins this constant rather than repeating the
 * filter by hand, so a newly added query cannot quietly omit it. An unapproved
 * shop must be indistinguishable from one that does not exist, so callers return
 * 404 and never 403, and use `findFirst` rather than `findUnique` (which would
 * confirm the id exists).
 *
 * Verified by deliberately removing it: doing so makes the browse and order
 * tests fail immediately. See mobile/scripts/verify-approved-only.sh.
 */
export const APPROVED_ONLY = { status: "APPROVED" } as const;
