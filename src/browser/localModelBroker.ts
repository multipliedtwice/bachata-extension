export type LocalModelBackend = "auto" | "lmstudio" | "ollama";

export type LocalModelConfig = {
  backend?: LocalModelBackend;
  endpoint?: string;
  model?: string;
  apiKey?: string;
  timeoutMs?: number;
  /** EX-R26-02. Explicit opt-in for the one remote semantic path; default/absent = loopback-only. */
  allowRemoteEndpoint?: boolean;
};

type QueueTask<T> = {
  run: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
  signal?: AbortSignal;
  abort?: () => void;
};

export class LocalModelBroker {
  private active = 0;
  private readonly queue: Array<QueueTask<unknown>> = [];

  constructor(private readonly concurrency = 1, private readonly maxQueue = 4) {}

  async run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) {
      throw new Error("Local model request interrupted");
    }
    if (this.active < this.concurrency) {
      this.active += 1;
      try {
        return await task();
      } finally {
        this.active -= 1;
        this.drain();
      }
    }
    if (this.queue.length >= this.maxQueue) {
      throw new Error("Local model queue is full");
    }
    return await new Promise<T>((resolve, reject) => {
      const entry: QueueTask<T> = { run: task, resolve, reject, ...(signal ? { signal } : {}) };
      if (signal) {
        entry.abort = (): void => {
          const index = this.queue.indexOf(entry as QueueTask<unknown>);
          if (index < 0) {
            return;
          }
          this.queue.splice(index, 1);
          reject(new Error("Local model request interrupted"));
        };
        signal.addEventListener("abort", entry.abort, { once: true });
      }
      this.queue.push(entry as QueueTask<unknown>);
    });
  }

  private drain(): void {
    while (this.active < this.concurrency && this.queue.length > 0) {
      const entry = this.queue.shift()!;
      if (entry.signal && entry.abort) {
        entry.signal.removeEventListener("abort", entry.abort);
      }
      if (entry.signal?.aborted) {
        entry.reject(new Error("Local model request interrupted"));
        continue;
      }
      this.active += 1;
      void entry.run().then(entry.resolve, entry.reject).finally(() => {
        this.active -= 1;
        this.drain();
      });
    }
  }
}

export const localModelBroker = new LocalModelBroker(1, 4);

const loopbackHostnames = new Set(["localhost", "127.0.0.1", "[::1]"]);

const parseHttpEndpoint = (value: string): URL => {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`Local model endpoint is not a valid URL: ${value}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Local model endpoints must be HTTP(S) addresses");
  }
  return parsed;
};

const assertLoopbackEndpoint = (value: string): void => {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`Local model endpoint is not a valid URL: ${value}`);
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    || !loopbackHostnames.has(parsed.hostname.toLowerCase())
  ) {
    throw new Error("Local model endpoints must be loopback HTTP(S) addresses");
  }
};

const fetchJson = async (
  url: string,
  init: RequestInit,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> => {
  if (signal?.aborted) throw new Error("Local model request interrupted");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const abort = (): void => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  try {
    const response = await fetch(url, { ...init, redirect: "error", signal: controller.signal });
    if (response.redirected || (response.type === "opaqueredirect")) {
      throw new Error("Local model endpoint attempted an off-host redirect");
    }
    if (!response.ok) {
      throw new Error(`Local model request failed with HTTP ${response.status}`);
    }
    const value = await response.json();
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Local model returned an invalid JSON response");
    }
    return value as Record<string, unknown>;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
  }
};

const lmStudio = async (
  prompt: string,
  config: LocalModelConfig,
  signal?: AbortSignal,
): Promise<string> => {
  const endpoint = (config.endpoint ?? "http://127.0.0.1:1234").replace(/\/+$/, "");
  let model = config.model;
  if (!model) {
    const response = await fetchJson(
      `${endpoint}/v1/models`,
      config.apiKey ? { headers: { authorization: `Bearer ${config.apiKey}` } } : {},
      config.timeoutMs ?? 30_000,
      signal,
    );
    const models = Array.isArray(response.data) ? response.data : [];
    const first = models[0] as Record<string, unknown> | undefined;
    model = typeof first?.id === "string" ? first.id : undefined;
  }
  if (!model) {
    throw new Error("LM Studio has no loaded model");
  }
  const response = await fetchJson(`${endpoint}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      max_tokens: 256,
      messages: [
        { role: "system", content: "Return only compact JSON. Select only supplied candidate IDs. Abstain when uncertain." },
        { role: "user", content: prompt },
      ],
    }),
  }, config.timeoutMs ?? 30_000, signal);
  const choices = Array.isArray(response.choices) ? response.choices : [];
  const first = choices[0] as Record<string, unknown> | undefined;
  const message = first?.message as Record<string, unknown> | undefined;
  if (typeof message?.content !== "string") {
    throw new Error("LM Studio returned no message content");
  }
  return message.content;
};

const ollama = async (
  prompt: string,
  config: LocalModelConfig,
  signal?: AbortSignal,
): Promise<string> => {
  const endpoint = (config.endpoint ?? "http://127.0.0.1:11434").replace(/\/+$/, "");
  let model = config.model;
  if (!model) {
    const response = await fetchJson(
      `${endpoint}/api/tags`,
      config.apiKey ? { headers: { authorization: `Bearer ${config.apiKey}` } } : {},
      config.timeoutMs ?? 30_000,
      signal,
    );
    const models = Array.isArray(response.models) ? response.models : [];
    const first = models[0] as Record<string, unknown> | undefined;
    model = typeof first?.name === "string" ? first.name : undefined;
  }
  if (!model) {
    throw new Error("Ollama has no installed model");
  }
  const response = await fetchJson(`${endpoint}/api/chat`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
    },
    body: JSON.stringify({
      model,
      stream: false,
      format: "json",
      options: { temperature: 0, num_predict: 256 },
      messages: [
        { role: "system", content: "Return only compact JSON. Select only supplied candidate IDs. Abstain when uncertain." },
        { role: "user", content: prompt },
      ],
    }),
  }, config.timeoutMs ?? 30_000, signal);
  const message = response.message as Record<string, unknown> | undefined;
  if (typeof message?.content !== "string") {
    throw new Error("Ollama returned no message content");
  }
  return message.content;
};

export const runLocalModel = async (
  prompt: string,
  config: LocalModelConfig = {},
  signal?: AbortSignal,
): Promise<string> => {
  if (signal?.aborted) throw new Error("Local model request interrupted");
  const explicitEndpoint = config.endpoint?.trim();
  if (explicitEndpoint) {
    if (config.allowRemoteEndpoint) {
      parseHttpEndpoint(explicitEndpoint);
    } else {
      assertLoopbackEndpoint(explicitEndpoint);
    }
  }
  const timeoutMs = Math.max(1_000, config.timeoutMs ?? 30_000);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const abort = (): void => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  try {
    return await localModelBroker.run(async () => {
      if (config.backend === "lmstudio") return await lmStudio(prompt, config, controller.signal);
      if (config.backend === "ollama") return await ollama(prompt, config, controller.signal);
      try {
        return await lmStudio(prompt, { ...config, endpoint: config.endpoint ?? "http://127.0.0.1:1234" }, controller.signal);
      } catch (error) {
        if (controller.signal.aborted) throw error;
        return await ollama(prompt, { ...config, endpoint: config.endpoint ?? "http://127.0.0.1:11434" }, controller.signal);
      }
    }, controller.signal);
  } catch (error) {
    if (signal?.aborted) throw new Error("Local model request interrupted");
    if (controller.signal.aborted) throw new Error("Local model request timed out");
    throw error;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
  }
};
