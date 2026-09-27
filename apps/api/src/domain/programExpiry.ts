/** A program remains available through its configured end date. */
export function isProgramExpired(endDate: string | null, now = new Date()): boolean {
    if (!endDate) {
        return false;
    }
    const today = now.toISOString().slice(0, 10);
    return today > endDate;
}
