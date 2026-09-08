const capabilityDescriptions: Record<string, string> = {
  streaming: "streamed output",
  resume: "session resume",
  interrupt: "confirmed interruption",
  attachments: "image attachments",
  repositoryTools: "repository tools",
  browserSessionSelection: "a selected browser conversation",
  passiveActionLoop: "the autonomous action loop",
};

export const describeCapability = (capability: string): string =>
  capabilityDescriptions[capability] ?? capability;

export const describeCapabilities = (capabilities: string[]): string =>
  capabilities.map(describeCapability).join(", ");
