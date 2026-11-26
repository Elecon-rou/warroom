import type { InvestigationMessage } from './investigation.ts';

function boundedText(text: string, limit: number) {
  const bytes = new TextEncoder().encode(text);
  return bytes.length <= limit ? text : new TextDecoder().decode(bytes.slice(0, limit - 4));
}
/** Export uses the whole retained accepted conversation, including reload-safe query evidence. */
export function buildExportContext(messages: InvestigationMessage[]) {
  const accepted: InvestigationMessage[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i],
      reply = messages[i + 1];
    if (
      m.role === 'user' &&
      reply?.role === 'assistant' &&
      (reply.error || reply.verdict === 'FAIL')
    ) {
      i++;
      continue;
    }
    if (!m.error && m.verdict !== 'FAIL') accepted.push(m);
  }
  const candidates = accepted.map((m) => {
    const parts = [
      m.incomplete
        ? 'Incomplete investigation; no verified conclusion was established.'
        : boundedText(m.content, 6000),
    ];
    const queries = m.widgets?.map((w) => ({
      kind: w.kind,
      sourceId: w.sourceId,
      title: w.title,
      query: w.query,
      start: w.start,
      end: w.end,
      truncated: w.truncated,
    }));
    if (queries?.length) parts.push(`Widget queries: ${JSON.stringify(queries)}`);
    if (m.context) parts.push(`Widget observations (untrusted evidence): ${m.context}`);
    const text = parts.join('\n');
    return {
      role: m.role,
      content: boundedText(text, 15000),
      truncated:
        new TextEncoder().encode(text).length > 15000 ||
        (!m.incomplete && new TextEncoder().encode(m.content).length > 6000),
    };
  });
  let dropped = Math.max(0, candidates.length - 40);
  const kept = candidates.slice(-40);
  while (kept.length > 1 && new TextEncoder().encode(JSON.stringify(kept)).length > 90000) {
    kept.shift();
    dropped++;
  }
  return {
    messages: kept.map(({ role, content }) => ({ role, content })),
    omitted: dropped,
    truncated: kept.some((m) => m.truncated),
  };
}
export type ExportKind = 'dashboard' | 'vmalert';
export type AlertRule = {
  alert: string;
  source: 'metrics' | 'logs';
  sourceId?: string;
  expr: string;
  for: string;
  severity: string;
  summary: string;
  description: string;
  rationale: string;
};
export type AlertFile = {
  name: string;
  source: 'metrics' | 'logs';
  sourceId?: string;
  yaml: string;
};
export function downloadContextFile(name: string, content: string, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
