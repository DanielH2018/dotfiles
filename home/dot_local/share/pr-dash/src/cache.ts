export type Cache<T> = {
  get(): T | undefined;
  set(value: T): void;
  invalidate(): void;
};

export function createCache<T>(ttlMs: number): Cache<T> {
  let value: T | undefined;
  let storedAt = 0;

  return {
    get() {
      if (value === undefined) return undefined;
      if (Date.now() - storedAt > ttlMs) return undefined;
      return value;
    },
    set(v: T) {
      value = v;
      storedAt = Date.now();
    },
    invalidate() {
      value = undefined;
    },
  };
}
