import type { Kind, Source } from './types.ts';
import type { GraphSettings } from './state.ts';

// The ID identifies an instance; kind only determines its query adapter.
export function selectedSourceId(sources: Source[], kind: Kind, id?: string) {
  return id || sources.find((source) => source.kind === kind)?.id;
}
export function sourceName(sources: Source[], kind: Kind, id?: string) {
  const selected = selectedSourceId(sources, kind, id);
  return (
    sources.find((source) => source.id === selected && source.kind === kind)?.name ||
    (selected ? `${selected} (unavailable)` : 'No data source selected')
  );
}

type GraphSelection = Pick<GraphSettings, 'source' | 'metricsSourceId' | 'tracesSourceId'>;
export type GraphSourceOption = { value: string; label: string; selection: GraphSelection };

// The graph can combine one source per supported adapter, but the user selects
// actual configured names rather than choosing adapter types first.
export function graphSourceOptions(sources: Source[]): GraphSourceOption[] {
  const options: GraphSourceOption[] = sources
    .filter((source) => source.kind === 'metrics' || source.kind === 'traces')
    .map((source) => ({
      value: source.id,
      label: source.name,
      selection: {
        source: source.kind as 'metrics' | 'traces',
        metricsSourceId: source.kind === 'metrics' ? source.id : undefined,
        tracesSourceId: source.kind === 'traces' ? source.id : undefined,
      },
    }));
  for (const metrics of sources.filter((source) => source.kind === 'metrics'))
    for (const traces of sources.filter((source) => source.kind === 'traces'))
      options.push({
        value: `${metrics.id}+${traces.id}`,
        label: `${metrics.name} + ${traces.name}`,
        selection: {
          source: 'combined',
          metricsSourceId: metrics.id,
          tracesSourceId: traces.id,
        },
      });
  return options;
}
export function selectedGraphSource(sources: Source[], settings: GraphSelection) {
  const options = graphSourceOptions(sources);
  if (
    settings.source !== 'traces' &&
    settings.metricsSourceId &&
    !sources.some((source) => source.id === settings.metricsSourceId && source.kind === 'metrics')
  )
    return undefined;
  if (
    settings.source !== 'metrics' &&
    settings.tracesSourceId &&
    !sources.some((source) => source.id === settings.tracesSourceId && source.kind === 'traces')
  )
    return undefined;
  const metrics = selectedSourceId(sources, 'metrics', settings.metricsSourceId);
  const traces = selectedSourceId(sources, 'traces', settings.tracesSourceId);
  if (settings.source === 'combined') {
    // Existing share links may select a kind which is no longer configured.
    // Preserve explicit missing IDs rather than silently switching instances.
    if (metrics && traces) return options.find((option) => option.value === `${metrics}+${traces}`);
    return options.find((option) => option.value === (metrics || traces));
  }
  return options.find(
    (option) => option.value === (settings.source === 'metrics' ? metrics : traces),
  );
}
