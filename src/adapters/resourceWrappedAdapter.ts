import type { AgentAdapter } from "./types";
import type { ProviderResourceBroker, ProviderResourceLease } from "../runtime/providerResourceBroker";
import { classifyProviderFailure, ProviderFailureError } from "./providerFailure";

export type ResourceWrappedAdapterOptions = {
  resourceId: string;
  broker: ProviderResourceBroker;
};

const releaseLease = (lease: ProviderResourceLease | undefined): void => {
  lease?.release();
};

export const wrapAdapterWithProviderResource = (
  adapter: AgentAdapter,
  options: ResourceWrappedAdapterOptions,
): AgentAdapter => new Proxy(adapter, {
  get(target, property, receiver) {
    if (property !== "send") {
      return Reflect.get(target, property, receiver);
    }
    return async function* wrappedSend(...args: unknown[]) {
      const signal = args.find((value): value is AbortSignal => value instanceof AbortSignal);
      let lease: ProviderResourceLease | undefined;
      try {
        lease = await options.broker.acquire(options.resourceId, signal);
      } catch (error) {
        const failure = classifyProviderFailure(
          error,
          String(adapter.adapterType ?? adapter.id),
          options.resourceId,
          "none",
        );
        options.broker.reportFailure(failure);
        throw new ProviderFailureError(failure, error);
      }
      try {
        const send = Reflect.get(target, "send", receiver) as (...values: unknown[]) => AsyncIterable<unknown>;
        yield* send.apply(target, args);
      } catch (error) {
        if (error instanceof ProviderFailureError) {
          options.broker.reportFailure(error.failure);
          throw error;
        }
        const failure = classifyProviderFailure(
          error,
          String(adapter.adapterType ?? adapter.id),
          options.resourceId,
          "possible",
        );
        options.broker.reportFailure(failure);
        throw new ProviderFailureError(failure, error);
      } finally {
        releaseLease(lease);
      }
    };
  },
}) as AgentAdapter;

export const resourceWrapAdapter = wrapAdapterWithProviderResource;
