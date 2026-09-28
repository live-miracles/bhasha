// One full calendar day of grace past endDate, so a translator/listener/approver
// in a timezone ahead of UTC never sees "expired" while it's still event day for
// them. Expressed as "two days past endDate" (rather than "the day after") so the
// UTC-vs-local boundary itself can't cause an off-by-one.
const GRACE_DAYS = 2;

/** A program remains available through its configured end date, plus a grace period. */
export function isProgramExpired(endDate: string | null, now = new Date()): boolean {
    if (!endDate) {
        return false;
    }
    const today = now.toISOString().slice(0, 10);
    const expiresOn = new Date(`${endDate}T00:00:00.000Z`);
    expiresOn.setUTCDate(expiresOn.getUTCDate() + GRACE_DAYS);
    return today >= expiresOn.toISOString().slice(0, 10);
}
