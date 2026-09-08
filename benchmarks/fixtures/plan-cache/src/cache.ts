export type Entry = { value: string; storedAt: number };

const store = new Map<string, Entry>();

export const put = (key: string, value: string, now: number): void => {
  store.set(key, { value, storedAt: now });
};

export const get = (key: string, now: number, ttlMs: number): string | undefined => {
  const entry = store.get(key);
  if (!entry) return undefined;
  return now - entry.storedAt > ttlMs ? undefined : entry.value;
};

export const size = (): number => store.size;
