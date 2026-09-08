/*
 * Canonical ordering for values whose order is then hashed, written to a manifest, or shipped
 * in an archive.
 *
 * `String.prototype.localeCompare` without an explicit locale answers by the host's locale and
 * ICU data, so the same input can order differently on two machines and yield a different
 * digest — and a digest that depends on the machine is not an identity. Comparing code units
 * is the same everywhere.
 *
 * This is deliberately not for human-facing lists: locale order is the correct answer there.
 */
export const byCodeUnit = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

export const byCodeUnitOn = <T>(select: (value: T) => string) =>
  (left: T, right: T): number => byCodeUnit(select(left), select(right));
