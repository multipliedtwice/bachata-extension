import type { JsonFetch } from "./localModelDiscovery";

/**
 * How one consumer's local-backend requests are allowed to be made.
 *
 * Discovery is the first half of the same conversation interpretation goes on to have, so it is
 * made under the same policy: the same deadline, the same credential, and the same reach. A reader
 * who opts a documented remote endpoint in gets it discovered; one who does not is held to the
 * loopback, which is what keeps a mistyped endpoint from becoming an outbound request on their
 * behalf.
 */
export type LocalBackendFetchPolicy = {
  timeoutMs: number;
  allowRemote: boolean;
  /** Used to make the request and never recorded anywhere: not logged, keyed, or rendered. */
  apiKey?: string | undefined;
};

const loopbackHostnames = ["localhost", "127.0.0.1", "::1", "[::1]"];

/**
 * One JSON reader for every local backend question: bounded, refusing redirects, and reaching no
 * further than the policy allows.
 */
export const createLocalBackendFetch = (
  policy: LocalBackendFetchPolicy,
  fetchImpl: typeof fetch = fetch,
): JsonFetch =>
  async (url, init) => {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("Local model endpoints must be HTTP(S) addresses");
    }
    if (!policy.allowRemote && !loopbackHostnames.includes(parsed.hostname.toLowerCase())) {
      throw new Error("Local model endpoints must be loopback HTTP(S) addresses");
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), policy.timeoutMs);
    try {
      const response = await fetchImpl(url, {
        ...init,
        ...(policy.apiKey
          ? { headers: { ...init?.headers, authorization: `Bearer ${policy.apiKey}` } }
          : {}),
        redirect: "error",
        signal: controller.signal,
      });
      // A redirect is an instruction to ask somewhere else, and where it points was never checked
      // against the reach this consumer was granted.
      if (response.redirected) {
        throw new Error("Local model endpoint attempted an off-host redirect");
      }
      if (!response.ok) {
        throw new Error(`HTTP ${String(response.status)}`);
      }
      return await response.json();
    } finally {
      clearTimeout(timer);
    }
  };
