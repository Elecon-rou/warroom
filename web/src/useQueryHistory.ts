import { useEffect, useRef, useState } from 'react';
import type { HistoryEntry } from './explorer';
import type { Kind } from './types';

/** History belongs to the server-issued session cookie, shared by tabs. */
export function useQueryHistory() {
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [error, setError] = useState('');
  const queue = useRef<Promise<void>>(Promise.resolve());
  const alive = useRef(true);
  const channel = useRef<BroadcastChannel | null>(null);
  function request(
    method: 'GET' | 'POST' | 'DELETE',
    entry?: { kind: Kind; sourceId?: string; query: string },
  ) {
    // Serialize initialization, completed queries and clears so stale responses
    // cannot resurrect history after a clear or replace a newer result.
    queue.current = queue.current.then(async () => {
      try {
        const response = await fetch('/api/history', {
          method,
          credentials: 'same-origin',
          cache: 'no-store',
          headers: entry ? { 'Content-Type': 'application/json' } : undefined,
          body: entry ? JSON.stringify(entry) : undefined,
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || 'Query history unavailable.');
        if (alive.current) {
          setHistory(result);
          setError('');
        }
        if (method !== 'GET') channel.current?.postMessage('changed');
      } catch (err) {
        if (alive.current) setError((err as Error).message);
      }
    });
  }
  function refresh() {
    request('GET');
  }
  useEffect(() => {
    alive.current = true;
    // Discard legacy persistent history instead of importing it into this session.
    try {
      localStorage.removeItem('warroom.history');
    } catch {}
    refresh();
    window.addEventListener('focus', refresh);
    try {
      channel.current = new BroadcastChannel('warroom.query-history');
      channel.current.onmessage = refresh;
    } catch {}
    return () => {
      alive.current = false;
      window.removeEventListener('focus', refresh);
      channel.current?.close();
      channel.current = null;
    };
  }, []);
  return {
    history,
    error,
    refresh,
    record: (kind: Kind, query: string, sourceId?: string) =>
      request('POST', { kind, query, sourceId }),
    clear: () => request('DELETE'),
  };
}
