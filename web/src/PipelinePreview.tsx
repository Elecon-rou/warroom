import { useEffect, useRef, useState } from 'react';
import { LoaderCircle, Play, Square } from 'lucide-react';
import type { LogBuildResult } from './logsBuilder';

type PipelinePreviewProps = { result: LogBuildResult; label: string; start: number; end: number };
type Preview = { rows: Record<string, unknown>[]; elapsedMs: number };
export function PipelinePreview({ result, label, start, end }: PipelinePreviewProps) {
  const [data, setData] = useState<Preview | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const controller = useRef<AbortController | null>(null);
  useEffect(() => {
    controller.current?.abort();
    controller.current = null;
    setData(null);
    setPending(false);
    setError('');
    return () => controller.current?.abort();
  }, [result.query, result.error, start, end]);
  async function run() {
    controller.current?.abort();
    const request = new AbortController();
    controller.current = request;
    setPending(true);
    setError('');
    setData(null);
    try {
      if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end)
        throw new Error('Invalid time range.');
      const response = await fetch('/api/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind: 'logs',
          query: `${result.query}\n| limit 20`,
          start,
          end,
          limit: 20,
        }),
        signal: request.signal,
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Preview failed.');
      if (!Array.isArray(body.data)) throw new Error('Invalid log preview response.');
      if (controller.current === request)
        setData({ rows: body.data.slice(0, 20), elapsedMs: body.elapsedMs });
    } catch (error) {
      if (controller.current === request && (error as Error).name !== 'AbortError')
        setError((error as Error).message);
    } finally {
      if (controller.current === request) {
        setPending(false);
        controller.current = null;
      }
    }
  }
  const fields = [...new Set(data?.rows.flatMap((row) => Object.keys(row)) || [])];
  const columns = fields.slice(0, 8);
  const display = (value: unknown): string =>
    value === undefined || value === null
      ? ''
      : typeof value === 'object'
        ? JSON.stringify(value)
        : String(value);
  return (
    <section className="pipe-preview" aria-label="Pipeline stage preview">
      <div className="pipe-preview-heading">
        <span>Preview · {label}</span>
        <span className="pipe-preview-cap">Up to 20 rows</span>
        <button
          className="subtle-button"
          disabled={!pending && (!!result.error || !result.query)}
          onClick={pending ? () => controller.current?.abort() : () => void run()}
        >
          {pending ? <Square size={12} /> : <Play size={12} />}
          {pending ? 'Cancel' : 'Run to here'}
        </button>
      </div>
      {pending && (
        <div className="pipe-preview-status" role="status">
          <LoaderCircle size={13} className="spin" />
          Loading…
        </div>
      )}
      {error && (
        <p className="inline-error" role="status">
          {error}
        </p>
      )}
      {data && (
        <>
          <div className="pipe-preview-status">
            {data.rows.length} rows · {data.elapsedMs} ms
            {fields.length > 8 && ` · showing 8 of ${fields.length} fields`}
          </div>
          {data.rows.length ? (
            <div className="pipe-preview-scroll">
              <table>
                <thead>
                  <tr>
                    {columns.map((field) => (
                      <th key={field}>{field}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((row, index) => (
                    <tr key={index}>
                      {columns.map((field) => (
                        <td key={field} title={display(row[field])}>
                          {display(row[field]).slice(0, 300)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="pipe-preview-status">No results</p>
          )}
        </>
      )}
    </section>
  );
}
