# Frontend

React and TypeScript UI, built with Vite. The Go service serves the production build from `dist/` and handles all data-source and LLM requests.

## Commands

```sh
npm ci
npm run dev          # Development server; see vite.config.ts for the API proxy
npm run build        # Type-check and build dist/
npm test             # URL state and service-tree layout tests
npm run format       # Format source, tests, CSS, and configuration
npm run format:check # Check formatting without editing files
```

## Source map

| File                                                | Responsibility                                                                     |
| --------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `src/main.tsx`                                      | Mount the React app and import styles.                                             |
| `src/App.tsx`                                       | Page navigation, explorer state, query execution, cancellation, and query history. |
| `src/Sidebar.tsx`                                   | Navigation links and page counts.                                                  |
| `src/ExplorePanel.tsx`                              | A single query editor, source/input selectors, and time/refresh controls.          |
| `src/QueryResult.tsx`                               | Query status, export, and selection of the appropriate data viewer.                |
| `src/explorer.ts`                                   | Explorer metadata, runtime types, and saved history loading.                       |
| `src/HistoryPage.tsx`, `src/SourcesPage.tsx`        | History and data-source pages.                                                     |
| `src/Investigate.tsx`                               | Chat input, conversation display, and investigation request lifecycle.             |
| `src/investigation.ts`                              | Chat types, session restoration, and bounded conversation context.                 |
| `src/ChatWidget.tsx`                                | Embedded metrics/logs/traces widgets, reload, and export.                          |
| `src/Metrics.tsx`, `src/Logs.tsx`, `src/Traces.tsx` | Data viewers shared by Explore and Investigate.                                    |
| `src/ServiceGraph.tsx`, `src/tree.ts`               | Service graph interactions and deterministic tree layout.                          |
| `src/state.ts`                                      | Shareable URL state, defaults, validation, and older-link migration.               |
| `src/types.ts`                                      | Shared telemetry types and display formatting helpers.                             |
| `src/styles.css`                                    | Theme, layout, component styles, and responsive rules.                             |

Explorer configuration and time selections are encoded in the URL. Query results remain in memory. Investigation chat is kept mounted during navigation; session storage retains message text and widget queries, with response bodies loaded again on demand after a reload.

The stylesheet keeps its cascade order, including later component overrides. Run the formatter after edits; generated `dist/`, dependencies, and the lockfile are excluded.

## Query constructors

Choose **Constructor** in an Explore panel, then select Metrics or Traces.

- **Metrics:** searchable metric names, label/value suggestions and matcher operators, ordered range functions, aggregations with `by`/`without` grouping, histogram quantiles, top/bottom counts, scalar arithmetic, and common instant-vector functions. Range functions are inserted before other operations. Reorder or remove operation cards as needed.
- **Traces:** Jaeger service and operation suggestions, exact-match tag rows, minimum/maximum durations, and the existing result limit and time controls.

The query preview updates as fields change. **Edit manually** transfers the compiled query to Manual mode. Supported manual expressions also open in Constructor mode. Expressions outside the supported subset are preserved; use Manual or explicitly reset the constructor to replace them. Incomplete builder fields are retained in shared URLs. Logs has its own pipeline constructor, described below.

`QueryConstructor.tsx` coordinates the visual editors. `MetricsConstructor.tsx` and `TracesConstructor.tsx` contain their fields; `queryBuilders.ts` owns compilation, validation, safe manual conversion, and URL input validation. `useSuggestions.ts` debounces requests and caches metadata for 30 seconds.

The Go service proxies `GET /api/metrics/metadata` (metric names, metric labels, label values) and `GET /api/operations?service=…` to the configured sources. Metric metadata uses the panel time range; suggestion responses are capped at 1,000 entries. Metadata errors leave the fields usable for manual entry.

The interaction patterns follow Grafana's [Prometheus builder](https://grafana.com/docs/grafana/latest/datasources/prometheus/query-editor/) and [Jaeger search form](https://grafana.com/docs/grafana/latest/datasources/jaeger/query-editor/). The trace constructor produces Jaeger search parameters for VictoriaTraces.

### Logs pipeline constructor

The Logs constructor follows the palette-and-pipeline layout of [Pipe Lab](https://brainbox-dev.com/ragebuilder/pipe-lab/), adapted to [native VictoriaLogs LogsQL](https://docs.victoriametrics.com/victorialogs/logsql/).

Click or drag a stage from the palette into the pipeline. Select its card to configure it; drag cards or use the arrow buttons to reorder. Stages can be disabled, duplicated or removed. The source filter stays first. Supported stages are field/phrase/regex filtering, JSON and logfmt unpacking, keeping or dropping result fields, renaming, replacement, sorting, limits, offsets, aggregates, unique values and a custom native pipe.

**Run to here** runs the source and enabled stages through the selected card, within the panel time range. It appends a 20-row limit for the preview and displays a result table. It does not automatically execute while editing. Changing the query, selected stage or time clears stale preview data. **Run query** executes the complete pipeline with the panel's output limit.

The full query preview remains below the builder. Manual queries are split at real pipe separators while respecting quoted strings and nested subqueries. Richer pipes are preserved as editable custom stages. Builder fields, ordering and enabled state survive input mode switches and shared URLs.

`logsBuilder.ts` contains the stage model, compiler, parser and reordering helpers; `LogsConstructor.tsx` owns the palette and pipeline interactions; `LogStageEditor.tsx` contains stage-specific controls; `PipelinePreview.tsx` owns preview execution. `GET /api/logs/metadata` supplies field names and field values from the selected source filter and time range, using the shared debounced metadata cache. Result payloads remain in memory.

### Native LogsQL editing and draft persistence

The palette uses canonical LogsQL pipe names and includes the documented native pipe catalog. Pipes with dedicated form controls also offer **Edit native arguments** for syntax outside the form's subset, including wildcard field lists, conditional pipes, additional stats functions and subqueries. Native argument text is passed through as LogsQL rather than translated into another query language. The `filter` pipe defaults to a native filter expression; the optional field form remains available for simple matches. Syntax links open the corresponding VictoriaLogs reference.

Incomplete constructor edits no longer erase query text. The constructor retains the last complete query (or its source filter for a fresh Logs pipeline), alongside the unfinished pipeline draft. Manual and LLM modes keep that query, while returning to Constructor restores the draft and selected stage. Both are encoded in the shared URL. Explicitly changing the query text replaces its old builder representation; unchanged text does not discard the draft.

### Source and filter constructors

The source card opens a builder for stream labels (`=`, `!=`, `=~`, `!~`) and log-field conditions. Stream labels and their values come from VictoriaLogs metadata for the selected time range. Log conditions support nested AND/OR groups, NOT, exact and phrase matches, regexes, prefixes, text containment, existence/empty checks, numeric comparisons and multi-value filters. The same condition editor is available inside each `filter` pipe.

Use **Source input** or **Filter input** to switch between the builder and native LogsQL. Complex imported expressions remain native clauses rather than being discarded. Source forms, nested condition drafts and selection are stored with the pipeline in shared URLs and survive input mode switches. An unfinished condition retains the prior complete query and prevents executing an incomplete pipeline.

`logFilters.ts` compiles and validates these models; `LogSourceConstructor.tsx` and `LogFilterConstructor.tsx` render the editors. `/api/logs/metadata` additionally supports `stream_fields` and `stream_values`. `nativeLogsQL.ts` owns the canonical pipe catalog and per-pipe descriptions.

## Dashboards

`Dashboards.tsx` owns construction modes, browser-local saved dashboards, range/refresh, and a three-worker cancelable query queue. `dashboard.ts` defines version 1 of the portable JSON schema, validates imports and shared URL state, and adapts each source's response into numeric/category rows. `DashboardEditor.tsx` edits one widget draft and reuses existing source constructors. `DashboardWidgetView.tsx` renders the nine widget types; `DashboardForceGraph.tsx` owns the spring/charge layout, dragging and zoom independently from the Service graph page's tree layout.

The active dashboard is included in the URL alongside existing Explorer state. Save stores configuration in `warroom.dashboards` in this browser, capped at 50 dashboards. JSON import/export is portable; no query results or API keys are saved. Queries run only on Run or a configured refresh interval. Each widget has its own error; changing configuration or leaving the page cancels pending queries. Refresh uses one consistent relative time window per run. Each query returns at most 100 logs/traces and uses the existing backend limits.

Widgets have `id`, `title`, `type`, `source`, `query`, `width` (1–3), `reducer` (`last`, `mean`, `min`, `max`, `sum`, `count`), `valueField`, `labelField`, `unit`, `min`, `max`, `warning`, `critical`. Logs accepts only logs; force-graph accepts metrics/traces and uses the dependency API with an empty query. Time-series accepts metrics; other types accept all sources. Logs numerical queries should use native stats pipes and a named value field. Traces expose `duration_ms`, `spans`, `traceID`, `service`. Metrics reduce time samples per series; number/gauge then reduce across series too. Count represents returned samples, not a population event count. Use native source-side aggregation for totals. No-data stays empty; invalid numeric fields never become zero. Tables show at most 200 rows/20 fields, force graphs at most 80 services; gauge values outside bounds remain visible. Pie requires non-negative values.

LLM construction POSTs to `/api/dashboards/generate`; a successful result is a JSON draft requiring Apply JSON. The UI exposes the filter verdict and discovery audit. Server-side internal skills are in `dashboard-skills/`; the semantic filter runs before any MCP access and fails closed.

Time-series widgets use `type: "time-series"`, optional `chartStyle: "lines" | "bars"` and `axisMode: "auto" | "fixed"`. Fixed axes use min/max and unit `%` renders percentages. They preserve timestamped range samples, have a shared cursor tooltip and togglable series legend, and break lines on missing samples or large time gaps. Scalar reducers do not apply. The existing bars widget is a categorical summary.

Dashboard LLM prompts accept up to four PNG/JPEG screenshot or JSON reference files. Use Attach files, drop files on the prompt area, or paste a screenshot into the prompt. Screenshots show thumbnails, JSON has an expandable preview, and each file can be removed before generation. File selection is local; references are sent to the configured LLM provider only when Generate is pressed. Empty text prompts are supported when references are supplied. References are transient: never included in shared URLs or saved dashboard configurations.

Screenshots are limited to 4 MiB each, 8000px per side, and 20 megapixels; JSON references must contain an object or array and total at most 256 KiB. Total decoded attachments are limited to 8 MiB; request bodies to 12 MiB. Both client and server validate uploads. The semantic filter receives all actual image pixels and JSON contents before any MCP access; malformed, rejected, or incomplete verdicts fail closed. The construction model receives the same references after PASS. Existing Grafana JSON can be translated into Warroom widgets using the composition skill, rather than blindly imported or executed. Generated drafts still require Apply JSON.
