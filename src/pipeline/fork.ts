type ForkablePipeline = { id: string; name: string; description?: string };

export const forkPipelineDefinition = <T extends ForkablePipeline>(
  source: T,
  id: string,
  name: string,
): T => ({
  ...structuredClone(source),
  id,
  name,
  description: `Fork of ${source.name}${source.description ? ` — ${source.description}` : ""}`,
});
