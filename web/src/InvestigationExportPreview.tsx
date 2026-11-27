import { useDataSources, sourceName } from './dataSources';
import { useEffect, useRef } from 'react';
import { Download, LayoutDashboard, X } from 'lucide-react';
import { dashboardExportFilename, type Dashboard } from './dashboard';
import { DashboardLivePreview } from './DashboardLivePreview';
import { downloadContextFile } from './investigationExport';
import type { InvestigationExportDraft } from './useInvestigationExport';
const ignoreResults = () => {};
export function InvestigationExportPreview({
  draft,
  onClose,
  onDashboard,
}: {
  draft: InvestigationExportDraft;
  onClose: () => void;
  onDashboard: (dashboard: Dashboard) => void;
}) {
  const sources = useDataSources();
  const panel = useRef<HTMLElement>(null);
  useEffect(() => {
    panel.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [draft]);
  return (
    <section
      className="investigation-export"
      ref={panel}
      aria-label={
        draft.type === 'dashboard' ? 'Dashboard context export' : 'vmalert context export'
      }
    >
      <div className="investigation-export-heading">
        <h2>{draft.type === 'dashboard' ? 'Dashboard draft' : 'vmalert draft'}</h2>
        <button className="subtle-button" onClick={onClose} aria-label="Close context export">
          <X size={14} />
          Close
        </button>
      </div>
      <details open>
        <summary>Context summary</summary>
        <p className="export-summary">{draft.summary}</p>
      </details>
      {draft.contextNotice && <p className="investigation-warning">{draft.contextNotice}</p>}
      {draft.dashboard && (
        <>
          <div className="investigation-export-actions">
            <button className="run-button" onClick={() => onDashboard(draft.dashboard!)}>
              <LayoutDashboard size={14} />
              Open dashboard
            </button>
            <button
              className="subtle-button"
              onClick={() =>
                downloadContextFile(
                  dashboardExportFilename(draft.dashboard!.title),
                  JSON.stringify(draft.dashboard, null, 2),
                )
              }
            >
              <Download size={14} />
              Download JSON
            </button>
          </div>
          <DashboardLivePreview
            draft={draft.dashboard}
            window={{ start: draft.start, end: draft.end }}
            onResults={ignoreResults}
          />
        </>
      )}
      {draft.notes && <p className="export-summary">{draft.notes}</p>}
      {draft.rules?.map((rule) => (
        <article className="export-rule" key={rule.alert}>
          <h3>{rule.alert}</h3>
          <p>{rule.rationale}</p>
        </article>
      ))}
      {draft.files?.map((file) => (
        <section key={file.name}>
          <div className="investigation-export-heading">
            <h3>
              {sourceName(sources, file.source, file.sourceId)} · {file.name}
            </h3>
            <button
              className="subtle-button"
              onClick={() => downloadContextFile(file.name, file.yaml, 'application/yaml')}
            >
              <Download size={14} />
              Download YAML
            </button>
          </div>
          <pre>
            <code>{file.yaml}</code>
          </pre>
        </section>
      ))}
      {!!draft.files?.length && (
        <p className="export-caption">
          Draft only. Review thresholds and run vmalert -dryRun before loading. Use each file with
          its corresponding datasource; mixed sources require routing or separate instances.
        </p>
      )}
    </section>
  );
}
