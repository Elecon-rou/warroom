import { ArrowRight, Trash2 } from 'lucide-react';
import { sourceMetadata, type HistoryEntry } from './explorer';

type HistoryPageProps = {
  entries: HistoryEntry[];
  error?: string;
  onRestore: (entry: HistoryEntry) => void;
  onClear: () => void;
};

export function HistoryPage({ entries, onRestore, onClear, error }: HistoryPageProps) {
  return (
    <main className="explore content-page">
      <div className="page-heading">
        <h1>
          Query history<span className="heading-dot">.</span>
        </h1>
        {entries.length > 0 && (
          <button className="subtle-button" onClick={onClear}>
            <Trash2 size={14} />
            Clear history
          </button>
        )}
      </div>
      {error && (
        <p className="inline-error" role="status">
          {error}
        </p>
      )}
      {entries.length ? (
        <div className="history-page-list">
          {entries.map((entry, index) => {
            const Icon = sourceMetadata[entry.kind].icon;
            return (
              <article className="history-page-entry" key={index}>
                <div className="history-entry-meta">
                  <Icon size={15} />
                  <span>{sourceMetadata[entry.kind].name}</span>
                  <time>{new Date(entry.at).toLocaleString()}</time>
                </div>
                <code>{entry.query}</code>
                <button className="text-button" onClick={() => onRestore(entry)}>
                  Open in Explore
                  <ArrowRight size={13} />
                </button>
              </article>
            );
          })}
        </div>
      ) : (
        <p className="page-empty">No history.</p>
      )}
    </main>
  );
}
