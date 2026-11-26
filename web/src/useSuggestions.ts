import { DataSourceScope } from './dataSources';
import { useEffect, useState, useContext } from 'react';

type Suggestions = { data: string[]; pending: boolean; error: string; truncated: boolean };
const cache = new Map<string, { expires: number; value: Suggestions }>();

// Debounce typing and reuse recent results across filters and panels.
export function useSuggestions(url: string | null): Suggestions {
  const sourceId = useContext(DataSourceScope);
  if (url && sourceId)
    url += (url.includes('?') ? '&' : '?') + 'sourceId=' + encodeURIComponent(sourceId);
  const [result, setResult] = useState<Suggestions>({
    data: [],
    pending: false,
    error: '',
    truncated: false,
  });
  useEffect(() => {
    if (!url) {
      setResult({ data: [], pending: false, error: '', truncated: false });
      return;
    }
    const saved = cache.get(url);
    if (saved && saved.expires > Date.now()) {
      setResult(saved.value);
      return;
    }
    const controller = new AbortController();
    setResult({ data: [], pending: true, error: '', truncated: false });
    const timer = window.setTimeout(async () => {
      try {
        const response = await fetch(url, { signal: controller.signal });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || 'Could not load suggestions.');
        if (
          !Array.isArray(body.data) ||
          body.data.some((value: unknown) => typeof value !== 'string')
        )
          throw new Error('Invalid metadata response.');
        const value = {
          data: body.data as string[],
          pending: false,
          error: '',
          truncated: !!body.truncated,
        };
        if (controller.signal.aborted) return;
        if (cache.size >= 100) cache.delete(cache.keys().next().value!);
        cache.set(url, { expires: Date.now() + 30000, value });
        setResult(value);
      } catch (error) {
        if (!controller.signal.aborted)
          setResult({
            data: [],
            pending: false,
            error: (error as Error).message,
            truncated: false,
          });
      }
    }, 300);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [url]);
  return result;
}
