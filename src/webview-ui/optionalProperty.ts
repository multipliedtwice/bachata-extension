/**
 * Webview copy of src/state/optionalProperty.ts.
 *
 * The webview bundle is concatenated (tsconfig.webview.json, module: none, outFile), so it
 * cannot import the extension-host module. tests/optionalProperty.test.cjs compares the two
 * bodies so the copies cannot drift.
 */

type OptionalPropertyKeys<T> = {
  [K in keyof T]-?: Record<never, never> extends Pick<T, K> ? K : never;
}[keyof T];

const setOptionalProperty = <T extends object, K extends OptionalPropertyKeys<T>>(
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
