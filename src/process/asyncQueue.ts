export type AsyncQueue<T> = {
  iterable: AsyncIterable<T>;
  push: (value: T) => void;
  end: () => void;
  fail: (error: unknown) => void;
};

export const createAsyncQueue = <T>(): AsyncQueue<T> => {
  const values: T[] = [];
  const readers: Array<{
    resolve: (result: IteratorResult<T>) => void;
    reject: (error: unknown) => void;
  }> = [];
  let completed = false;
  let failure: unknown;

  const flush = (): void => {
    while (readers.length > 0 && values.length > 0) {
      const reader = readers.shift();
      const value = values.shift() as T;

      if (reader) {
        reader.resolve({ value, done: false });
      }
    }

    if (values.length === 0 && readers.length > 0 && completed) {
      const waiting = readers.splice(0);
      waiting.forEach((reader) => {
        if (failure !== undefined) {
          reader.reject(failure);
          return;
        }

        reader.resolve({ value: undefined, done: true });
      });
    }
  };

  const iterable: AsyncIterable<T> = {
    [Symbol.asyncIterator]() {
      return {
        next: () => {
          if (values.length > 0) {
            const value = values.shift() as T;
            return Promise.resolve({ value, done: false });
          }

          if (completed) {
            if (failure !== undefined) {
              return Promise.reject(failure);
            }

            return Promise.resolve({ value: undefined, done: true });
          }

          return new Promise<IteratorResult<T>>((resolve, reject) => {
            readers.push({ resolve, reject });
          });
        },
      };
    },
  };

  return {
    iterable,
    push: (value) => {
      if (completed) {
        return;
      }

      values.push(value);
      flush();
    },
    end: () => {
      completed = true;
      flush();
    },
    fail: (error) => {
      failure = error;
      completed = true;
      flush();
    },
  };
};
