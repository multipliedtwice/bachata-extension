/**
 * Optional-property writes that keep an absent key absent.
 *
 * Under exactOptionalPropertyTypes an optional property has two distinct states: absent, and
 * present holding undefined. Object spread, structuredClone, Object.keys, JSON round trips
 * and the persisted patch merges all observe that difference, so a record that must read as
 * "no value" has to lose the key rather than hold undefined. Assigning undefined instead of
 * deleting is what let a cleared queue-start claim survive a patch merge.
 */

type OptionalPropertyKeys<T> = {
  [K in keyof T]-?: Record<never, never> extends Pick<T, K> ? K : never;
}[keyof T];

export const setOptionalProperty = <T extends object, K extends OptionalPropertyKeys<T>>(
  target: T,
  key: K,
  value: T[K],
): void => {
  if (value === undefined) {
    delete target[key];
    return;
  }
  target[key] = value;
};
