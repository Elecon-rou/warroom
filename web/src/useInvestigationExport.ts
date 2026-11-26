import { useEffect, useRef, useState } from 'react';
import { parseDashboard, type Dashboard } from './dashboard';
import { readDashboardGeneration } from './dashboardGeneration';
import {
  buildExportContext,
  type ExportKind,
  type AlertFile,
  type AlertRule,
} from './investigationExport';
import type { InvestigationMessage } from './investigation';

export type InvestigationExportDraft = {
  type: ExportKind;
  summary: string;
  dashboard?: Dashboard;
  rules?: AlertRule[];
  files?: AlertFile[];
  notes?: string;
  start: number;
  end: number;
  contextNotice?: string;
};
export function useInvestigationExport(messages: InvestigationMessage[], chatId: string) {
  const [pending, setPending] = useState(false);
  const [phase, setPhase] = useState('');
  const [error, setError] = useState('');
  const [draft, setDraft] = useState<InvestigationExportDraft | null>(null);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  function clear() {
    controller.current?.abort();
    controller.current = null;
    setPending(false);
    setDraft(null);
    setError('');
    setPhase('');
  }
  async function generate(type: ExportKind, start: number, end: number) {
    if (controller.current) return;
    const context = buildExportContext(messages);
    if (!context.messages.length) return;
    if (!Number.isFinite(start) || !Number.isFinite(end) || start <= 0 || end <= start) {
      setError('Invalid investigation time range.');
      return;
    }
    const active = new AbortController();
    controller.current = active;
    setPending(true);
    setDraft(null);
    setError('');
    setPhase('Summarizing context');
    const base = {
      type,
      start,
      end,
      summary: '',
      contextNotice:
        context.omitted || context.truncated
          ? 'Some older or oversized context was omitted to fit the export limit.'
          : undefined,
    };
    try {
      const response = await fetch('/api/investigate/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' },
        signal: active.signal,
        body: JSON.stringify({ type, messages: context.messages, chatId, start, end }),
      });
      const { status, data } = await readDashboardGeneration(response, (e) => {
        if (controller.current === active) setPhase(e.message);
      });
      if (controller.current !== active) return;
      if (status < 200 || status >= 300) {
        if (typeof data.summary === 'string' && data.summary)
          setDraft({ ...base, summary: data.summary });
        throw new Error(data.error || 'Context export failed.');
      }
      setDraft({
        ...base,
        summary: data.summary,
        dashboard: data.dashboard ? parseDashboard(data.dashboard) : undefined,
        rules: data.rules,
        files: data.files,
        notes: data.notes,
      });
      setPhase('');
    } catch (err) {
      if (controller.current === active)
        setError(
          (err as Error).name === 'AbortError' ? 'Export cancelled.' : (err as Error).message,
        );
    } finally {
      if (controller.current === active) {
        controller.current = null;
        setPending(false);
      }
    }
  }
  return {
    pending,
    phase,
    error,
    draft,
    generate,
    clear,
    cancel: () => controller.current?.abort(),
  };
}
