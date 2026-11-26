import { maxDashboardWidgets, parseDashboard, type DashboardWidget } from './dashboard.ts';
export type DashboardProgress = {
  type: 'progress';
  phase: string;
  message: string;
  elapsedMs: number;
};
export type DashboardWidgetEvent = {
  type: 'widget';
  revision: number;
  index: number;
  widget: DashboardWidget;
  elapsedMs: number;
};
export type DashboardGenerationResult = { status: number; data: any };
/** Read incremental progress without treating an interrupted stream as success. */
export async function readDashboardGeneration(
  response: Response,
  onProgress: (event: DashboardProgress) => void,
  onWidget: (event: DashboardWidgetEvent) => void = () => {},
): Promise<DashboardGenerationResult> {
  if (!response.ok || !response.headers.get('content-type')?.includes('application/x-ndjson'))
    return { status: response.status, data: await response.json() };
  if (!response.body) throw new Error('Dashboard generation returned no response stream.');
  const reader = response.body.getReader(),
    decoder = new TextDecoder();
  let buffer = '',
    size = 0,
    result: DashboardGenerationResult | undefined;
  function line(text: string) {
    if (!text.trim()) return;
    const value = JSON.parse(text);
    if (
      value.type === 'progress' &&
      typeof value.phase === 'string' &&
      typeof value.message === 'string' &&
      Number.isFinite(value.elapsedMs)
    )
      onProgress(value);
    else if (
      value.type === 'widget' &&
      Number.isInteger(value.revision) &&
      value.revision > 0 &&
      Number.isInteger(value.index) &&
      value.index >= 0 &&
      value.index < maxDashboardWidgets
    ) {
      const validated = parseDashboard({
        version: 1,
        id: 'preview',
        title: 'Preview',
        range: 3600,
        refresh: 0,
        widgets: [value.widget],
      });
      onWidget({ ...value, widget: validated.widgets[0] });
    } else if (
      value.type === 'result' &&
      Number.isInteger(value.status) &&
      value.status >= 200 &&
      value.status <= 599 &&
      value.data &&
      typeof value.data === 'object'
    ) {
      if (result) throw new Error('Duplicate dashboard result.');
      result = { status: value.status, data: value.data };
    } else throw new Error('Invalid dashboard generation response.');
  }
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 2 * 1024 * 1024) throw new Error('Dashboard response exceeds 2 MiB.');
      buffer += decoder.decode(value, { stream: true });
      let boundary: number;
      while ((boundary = buffer.indexOf('\n')) >= 0) {
        line(buffer.slice(0, boundary));
        buffer = buffer.slice(boundary + 1);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) line(buffer);
    if (!result)
      throw new Error(
        'Dashboard generation connection ended before a result. Retry or narrow the request.',
      );
    return result;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
export const generationTime = (ms: number) => {
  const seconds = Math.floor(ms / 1000);
  return seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`;
};

export type LiveWidgetState = { revision: number; widgets: Record<number, DashboardWidget> };
export function mergeWidgetEvent(
  state: LiveWidgetState,
  event: DashboardWidgetEvent,
): LiveWidgetState {
  if (event.revision < state.revision) return state;
  return {
    revision: event.revision,
    widgets: {
      ...(event.revision === state.revision ? state.widgets : {}),
      [event.index]: event.widget,
    },
  };
}
