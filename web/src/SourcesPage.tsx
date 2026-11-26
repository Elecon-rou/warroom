import { ArrowRight } from 'lucide-react';
import { sourceMetadata } from './explorer';
import type { Source } from './types';

type SourcesPageProps = {
  sources: Source[];
  error: string;
  onExplore: (source: Source) => void;
};

export function SourcesPage({ sources, error, onExplore }: SourcesPageProps) {
  return (
    <main className="explore content-page">
      <div className="page-heading">
        <h1>
          Data sources<span className="heading-dot">.</span>
        </h1>
      </div>
      {error && <p className="inline-error">{error}</p>}
      <div className="sources-page-grid">
        {sources.map((source) => {
          const Icon = sourceMetadata[source.kind].icon;
          return (
            <article className="source-card" key={source.id}>
              <div>
                <span className="source-icon">
                  <Icon size={20} />
                </span>
                <h3>
                  {source.name}
                  <small>
                    {source.kind === 'metrics'
                      ? 'Prometheus compatible'
                      : source.kind === 'logs'
                        ? 'Native LogsQL'
                        : 'Jaeger compatible'}
                  </small>
                </h3>
                <span className="count">Configured</span>
              </div>
              <code>{source.url}</code>
              <button className="text-button" onClick={() => onExplore(source)}>
                Explore
                <ArrowRight size={13} />
              </button>
            </article>
          );
        })}
      </div>
    </main>
  );
}
