import { useState, type DragEvent } from 'react';
import { ArrowDown, ArrowRight, ArrowUp, Copy, GripVertical, Plus, Trash2 } from 'lucide-react';
import {
  buildLogs,
  logStagePalette,
  logStageQuery,
  logStageLabel,
  moveLogStage,
  newLogStage,
  type LogsBuilder,
  type LogStage,
  type LogStageType,
} from './logsBuilder';
import { LogStageEditor } from './LogStageEditor';
import { PipelinePreview } from './PipelinePreview';
import { useSuggestions } from './useSuggestions';
import { LogSourceConstructor } from './LogSourceConstructor';
import { emptyFilterGroup } from './logFilters';
import { logsqlPipeReference, type NativePipeName } from './nativeLogsQL';

type LogsConstructorProps = {
  value: LogsBuilder;
  start: number;
  end: number;
  onChange: (value: LogsBuilder) => void;
};
const dragFormat = 'application/x-warroom-pipe';
export function LogsConstructor({ value, start, end, onChange }: LogsConstructorProps) {
  const selectedId =
    value.selectedStageId === undefined ? value.stages[0]?.id || null : value.selectedStageId;
  function selectStage(id: string | null) {
    onChange({ ...value, selectedStageId: id });
  }
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const selectedIndex = value.stages.findIndex((stage) => stage.id === selectedId);
  const selected = value.stages[selectedIndex];
  const metadata = useSuggestions(
    `/api/logs/metadata?${new URLSearchParams({ type: 'fields', query: value.filter || '*', start: String(start), end: String(end) })}`,
  );
  const fields = [
    ...new Set([
      '_time',
      '_msg',
      '_stream',
      ...metadata.data,
      ...value.stages.flatMap((stage) =>
        stage.type === 'stats' ? [stage.alias] : stage.type === 'rename' ? [stage.target] : [],
      ),
    ]),
  ]
    .filter(Boolean)
    .sort();
  const palette = logStagePalette.filter((stage) =>
    `${stage.label} ${stage.description}`.toLowerCase().includes(search.toLowerCase()),
  );
  const groups = [...new Set(palette.map((stage) => stage.group))];
  function add(type: LogStageType, beforeId: string | null = null, nativeName?: NativePipeName) {
    if (value.stages.length >= 24) return;
    let stage = newLogStage(type);
    if (stage.type === 'filter')
      stage = { ...stage, mode: 'builder', filterTree: emptyFilterGroup() };
    if (stage.type === 'native' && nativeName) stage = { ...stage, name: nativeName };
    const index =
      beforeId === null
        ? value.stages.length
        : value.stages.findIndex((stage) => stage.id === beforeId);
    if (index < 0) return;
    onChange({
      ...value,
      selectedStageId: stage.id,
      stages: [...value.stages.slice(0, index), stage, ...value.stages.slice(index)],
    });
  }
  function change(stage: LogStage) {
    onChange({
      ...value,
      stages: value.stages.map((current) => (current.id === stage.id ? stage : current)),
    });
  }
  function remove(stage: LogStage) {
    onChange({
      ...value,
      selectedStageId: selectedId === stage.id ? null : selectedId,
      stages: value.stages.filter((current) => current.id !== stage.id),
    });
  }
  function duplicate(stage: LogStage) {
    if (value.stages.length >= 24) return;
    const copy = { ...stage, id: crypto.randomUUID() };
    const index = value.stages.findIndex((current) => current.id === stage.id);
    onChange({
      ...value,
      selectedStageId: copy.id,
      stages: [...value.stages.slice(0, index + 1), copy, ...value.stages.slice(index + 1)],
    });
  }
  function move(index: number, direction: number) {
    const stages = [...value.stages];
    [stages[index], stages[index + direction]] = [stages[index + direction], stages[index]];
    onChange({ ...value, stages });
  }
  function drop(event: DragEvent, beforeId: string | null) {
    event.preventDefault();
    event.stopPropagation();
    setDropTarget(null);
    try {
      const data = JSON.parse(event.dataTransfer.getData(dragFormat));
      if (typeof data.id === 'string')
        onChange({ ...value, stages: moveLogStage(value.stages, data.id, beforeId) });
      else if (
        logStagePalette.some(
          (stage) => stage.type === data.type && stage.nativeName === data.nativeName,
        )
      )
        add(data.type, beforeId, data.nativeName);
    } catch {
      /* Ignore unrelated drag payloads. */
    }
  }
  function dragOver(event: DragEvent, target: string) {
    if (!event.dataTransfer.types.includes(dragFormat)) return;
    event.preventDefault();
    event.stopPropagation();
    setDropTarget(target);
  }
  const through = selectedIndex < 0 ? 0 : selectedIndex + 1;
  const preview = buildLogs(value, through);
  return (
    <div className="logs-pipe-builder">
      <aside className="pipe-palette" aria-label="Pipeline stage palette">
        <div className="pipe-palette-heading">
          Pipes<span>{value.stages.length}/24</span>
        </div>
        <input
          className="pipe-palette-search"
          aria-label="Search pipeline stages"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        {groups.map((group) => (
          <div className="pipe-palette-group" key={group}>
            <span>{group}</span>
            {palette
              .filter((stage) => stage.group === group)
              .map((stage) => (
                <button
                  className="pipe-palette-item"
                  key={`${stage.type}-${stage.nativeName || ''}`}
                  disabled={value.stages.length >= 24}
                  draggable={value.stages.length < 24}
                  onDragStart={(event) => {
                    event.dataTransfer.setData(
                      dragFormat,
                      JSON.stringify({ type: stage.type, nativeName: stage.nativeName }),
                    );
                    event.dataTransfer.effectAllowed = 'copy';
                  }}
                  onClick={() => add(stage.type, null, stage.nativeName)}
                  aria-label={`Add ${stage.label} stage`}
                >
                  <span>
                    <strong>{stage.label}</strong>
                    <Plus size={12} />
                  </span>
                  <small>{stage.description}</small>
                </button>
              ))}
          </div>
        ))}
      </aside>
      <div className="pipe-workbench">
        <div className="pipe-workbench-heading">
          <span>Pipeline</span>
          <a className="pipe-doc-link" href={logsqlPipeReference} target="_blank" rel="noreferrer">
            LogsQL reference
          </a>
          <span>{value.stages.filter((stage) => stage.enabled).length} active stages</span>
        </div>
        <div
          className="pipe-track"
          role="list"
          aria-label="Log pipeline"
          onDragOver={(event) => dragOver(event, 'end')}
          onDrop={(event) => drop(event, null)}
          onDragLeave={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node)) setDropTarget(null);
          }}
        >
          <div className="pipe-source-wrap" role="listitem">
            <button
              className={`pipe-source-card ${!selected ? 'selected' : ''}`}
              aria-label="Select source filter"
              aria-pressed={!selected}
              onClick={() => selectStage(null)}
            >
              <span>Source</span>
              <code>{value.filter || '*'}</code>
              <small>VictoriaLogs</small>
            </button>
          </div>
          {value.stages.map((stage, index) => (
            <div
              className={`pipe-stage-wrap ${dropTarget === stage.id ? 'drop-before' : ''}`}
              role="listitem"
              key={stage.id}
              onDragOver={(event) => dragOver(event, stage.id)}
              onDrop={(event) => drop(event, stage.id)}
            >
              <span className="pipe-connector" aria-hidden="true">
                |<ArrowRight size={12} />
              </span>
              <div
                className={`pipe-stage-card ${selectedId === stage.id ? 'selected' : ''} ${stage.enabled ? '' : 'disabled'}`}
                draggable
                onDragStart={(event) => {
                  event.dataTransfer.setData(dragFormat, JSON.stringify({ id: stage.id }));
                  event.dataTransfer.effectAllowed = 'move';
                }}
                onDragEnd={() => setDropTarget(null)}
              >
                <button
                  className="pipe-stage-select"
                  aria-label={`Select stage ${index + 1} ${logStageLabel(stage)}`}
                  aria-pressed={selectedId === stage.id}
                  onClick={() => selectStage(stage.id)}
                >
                  <span>
                    <GripVertical size={12} />
                    <span className="pipe-stage-number">{index + 1}</span>
                    <strong>{logStageLabel(stage)}</strong>
                  </span>
                  <code>{logStageQuery(stage).query || 'Configure stage'}</code>
                </button>
                <div className="pipe-stage-actions">
                  <input
                    type="checkbox"
                    aria-label={`Enable stage ${index + 1}`}
                    checked={stage.enabled}
                    onChange={(event) => change({ ...stage, enabled: event.target.checked })}
                  />
                  <button
                    className="icon-button"
                    aria-label={`Move stage ${index + 1} earlier`}
                    disabled={index === 0}
                    onClick={() => move(index, -1)}
                  >
                    <ArrowUp size={12} />
                  </button>
                  <button
                    className="icon-button"
                    aria-label={`Move stage ${index + 1} later`}
                    disabled={index === value.stages.length - 1}
                    onClick={() => move(index, 1)}
                  >
                    <ArrowDown size={12} />
                  </button>
                  <button
                    className="icon-button"
                    aria-label={`Duplicate stage ${index + 1}`}
                    disabled={value.stages.length >= 24}
                    onClick={() => duplicate(stage)}
                  >
                    <Copy size={12} />
                  </button>
                  <button
                    className="icon-button"
                    aria-label={`Remove stage ${index + 1}`}
                    onClick={() => remove(stage)}
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              </div>
            </div>
          ))}
          <div
            className={`pipe-drop-end ${dropTarget === 'end' ? 'drop-before' : ''}`}
            onDragOver={(event) => dragOver(event, 'end')}
            onDrop={(event) => drop(event, null)}
          >
            <Plus size={16} />
            <span>{value.stages.length ? 'Drop stage' : 'Add a stage'}</span>
          </div>
        </div>
        <section className="pipe-inspector" aria-label="Pipeline stage configuration">
          <div className="pipe-inspector-heading">
            <strong>
              {selected ? `${selectedIndex + 1} · ${logStageLabel(selected)}` : 'Source filter'}
            </strong>
            {selected && !selected.enabled && <span>Disabled</span>}
          </div>
          {selected ? (
            <LogStageEditor
              key={selected.id}
              stage={selected}
              fields={fields}
              source={value.filter || '*'}
              start={start}
              end={end}
              onChange={change}
            />
          ) : (
            <LogSourceConstructor
              value={value}
              fields={fields}
              start={start}
              end={end}
              onChange={onChange}
            />
          )}
          {metadata.error && (
            <p className="builder-warning">{metadata.error} Field names can be entered manually.</p>
          )}
          {preview.error && (
            <p className="builder-validation" role="status">
              {preview.error}
            </p>
          )}
        </section>
        <PipelinePreview
          result={preview}
          label={selected ? `through stage ${selectedIndex + 1}` : 'source'}
          start={start}
          end={end}
        />
      </div>
    </div>
  );
}
