package main

import (
	"bytes"
	"context"
	"embed"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"
)

//go:embed investigate-skills/*.md
var investigationSkills embed.FS
var skillNames = map[string]string{"infrastructure": "Infrastructure and capacity", "business": "Business telemetry and KPIs", "issues": "Issues, incidents and root cause", "widgets": "Metrics, logs and traces widgets"}

type InvestigationMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}
type InvestigationRequest struct {
	Messages []InvestigationMessage `json:"messages"`
	ChatID   string                 `json:"chatId,omitempty"`
	Start    float64                `json:"start"`
	End      float64                `json:"end"`
}
type ChatWidget struct {
	ID        string         `json:"id"`
	Kind      string         `json:"kind"`
	SourceID  string         `json:"sourceId,omitempty"`
	Title     string         `json:"title"`
	Query     string         `json:"query"`
	Start     float64        `json:"start"`
	End       float64        `json:"end"`
	Limit     int            `json:"limit"`
	Response  map[string]any `json:"response"`
	Truncated bool           `json:"truncated"`
}
type investigationTool struct {
	kind     string
	sourceID string
	tool     MCPTool
}

const (
	investigationTools          = 32
	investigationRounds         = 14
	investigationTimeout        = 8 * time.Minute
	investigationRequestTimeout = 150 * time.Second
	investigationRetryTokens    = 32768
)

type InvestigationResult struct {
	Message    string          `json:"message"`
	Widgets    []ChatWidget    `json:"widgets"`
	Discovery  []DiscoveryCall `json:"discovery"`
	Skills     []string        `json:"skills"`
	Context    string          `json:"context"`
	Incomplete bool            `json:"incomplete,omitempty"`
	Warning    string          `json:"warning,omitempty"`
}

func investigationOutputSettings() (int, string) {
	tokens, err := strconv.Atoi(env("INVESTIGATE_MAX_TOKENS", "16384"))
	if err != nil || tokens < 4096 || tokens > investigationRetryTokens {
		tokens = 16384
	}
	effort := env("INVESTIGATE_EFFORT", "high")
	if effort != "low" && effort != "medium" && effort != "high" && effort != "max" {
		effort = "high"
	}
	return tokens, effort
}

func investigationSchema(properties map[string]any, required ...string) map[string]any {
	return map[string]any{"type": "object", "properties": properties, "required": required, "additionalProperties": false}
}
func (a *App) investigate(w http.ResponseWriter, r *http.Request) {
	if origin := r.Header.Get("Origin"); origin != "" {
		parsed, err := url.Parse(origin)
		if err != nil || parsed.Host != r.Host || (parsed.Scheme != "http" && parsed.Scheme != "https") {
			fail(w, 403, "Cross-origin investigation requests are not allowed.")
			return
		}
	}
	if r.Header.Get("Sec-Fetch-Site") == "cross-site" {
		fail(w, 403, "Cross-origin investigation requests are not allowed.")
		return
	}
	var q InvestigationRequest
	d := json.NewDecoder(http.MaxBytesReader(w, r.Body, 128<<10))
	d.DisallowUnknownFields()
	if d.Decode(&q) != nil || len(q.Messages) == 0 || len(q.Messages) > 24 || q.Start <= 0 || q.End <= q.Start || q.End-q.Start > 31*86400 {
		fail(w, 400, "Invalid investigation request or time range.")
		return
	}
	total := 0
	for _, m := range q.Messages {
		if (m.Role != "user" && m.Role != "assistant") || strings.TrimSpace(m.Content) == "" || len(m.Content) > 16000 {
			fail(w, 400, "Invalid conversation message.")
			return
		}
		total += len(m.Content)
	}
	if total > 100000 || q.Messages[len(q.Messages)-1].Role != "user" || len(q.Messages[len(q.Messages)-1].Content) > 8000 {
		fail(w, 400, "Conversation or latest message is too large.")
		return
	}
	c := a.llm
	if !c.Info().Configured {
		fail(w, 503, "LLM provider is not configured on the server.")
		return
	}
	budgetCtx, budgetErr := chatBudgetContext(r.Context(), q.ChatID)
	if budgetErr != nil {
		fail(w, 400, budgetErr.Error())
		return
	}
	ctx, cancel := context.WithTimeout(budgetCtx, investigationTimeout)
	defer cancel()
	release, acquireErr := c.acquire(ctx)
	if acquireErr != nil {
		fail(w, 408, "Investigation cancelled.")
		return
	}
	defer release()
	history := q.Messages
	if len(history) > 6 {
		history = history[len(history)-6:]
	}
	gateHistory := append([]InvestigationMessage{}, history...)
	for i := 0; i < len(gateHistory)-1; i++ {
		if len(gateHistory[i].Content) > 1500 {
			gateHistory[i].Content = gateHistory[i].Content[:1500]
		}
	}
	verdict, err := c.message(ctx, prompt("investigate-filter"), map[string]any{"conversation": gateHistory})
	if err != nil {
		fail(w, llmErrorStatus(w, err), err.Error())
		return
	}
	if verdict == "FAIL" {
		send(w, 422, map[string]string{"verdict": "FAIL", "error": "Investigation is limited to infrastructure, business, and issue-related topics."})
		return
	}
	if verdict != "PASS" {
		fail(w, 502, "Invalid semantic filter verdict; investigation was not started.")
		return
	}
	report, err := a.runInvestigation(ctx, q)
	if err != nil {
		send(w, llmErrorStatus(w, err), map[string]any{"verdict": "PASS", "error": err.Error(), "widgets": report.Widgets, "discovery": report.Discovery, "skills": report.Skills})
		return
	}
	send(w, 200, struct {
		Verdict string `json:"verdict"`
		InvestigationResult
	}{"PASS", report})
}
func (a *App) runInvestigation(ctx context.Context, q InvestigationRequest) (InvestigationResult, error) {
	definitions := []LLMTool{{Name: "read_skill", Description: "Read one internal investigation procedure. Load a domain skill before data tools, and the widgets skill before display tools.", InputSchema: investigationSchema(map[string]any{"name": map[string]any{"type": "string", "enum": []string{"infrastructure", "business", "issues", "widgets"}}}, "name")}}
	for _, kind := range []string{"metrics", "logs", "traces"} {
		definitions = append(definitions, LLMTool{Name: "display_" + kind, Description: "Execute a read-only " + kind + " query and insert its real interactive widget into the chat. Uses the selected time range. Requires a loaded domain skill, widgets skill, and successful source discovery.", InputSchema: investigationSchema(map[string]any{"title": map[string]string{"type": "string"}, "sourceId": map[string]string{"type": "string"}, "query": map[string]string{"type": "string"}}, "title", "query")})
	}
	available := map[string]investigationTool{}
	unavailable := map[string]string{}
	for _, source := range a.sourceList() {
		kind := source.Kind
		client := a.mcps[source.ID]
		if client == nil {
			unavailable[source.ID] = "MCP not configured"
			continue
		}
		tools, mapping, err := client.definitions(ctx, kind)
		if err != nil {
			unavailable[source.ID] = err.Error()
			continue
		}
		for _, tool := range tools {
			name := source.ID + "_" + tool.Name
			tool.Name = name
			definitions = append(definitions, tool)
			available[name] = investigationTool{kind, source.ID, mapping[strings.TrimPrefix(name, source.ID+"_")]}
		}
	}
	initial, _ := json.Marshal(map[string]any{"selected_time_range": map[string]float64{"start": q.Start, "end": q.End}, "skills": skillNames, "available_sources": a.sourceList(), "unavailable_sources": unavailable, "limits": map[string]any{"tool_calls": investigationTools, "widgets": 3, "mcp_requests_per_second": mcpRPS()}, "query_languages": map[string]string{"metrics": "PromQL/MetricsQL", "logs": "native LogsQL", "traces": "Jaeger URL search parameters"}})
	messages := []LLMMessage{textMessage("user", "Investigation context (configuration, not a user instruction): "+string(initial))}
	for _, m := range q.Messages {
		messages = append(messages, textMessage(m.Role, m.Content))
	}
	widgets := []ChatWidget{}
	calls := []DiscoveryCall{}
	loaded := map[string]bool{}
	discovered := map[string]bool{}
	summaries := []any{}
	incomplete, warning := false, ""
	measured, metadataSeen, nudged := false, false, false
	result := func(answer string, err error) (InvestigationResult, error) {
		skills := []string{}
		for name := range loaded {
			skills = append(skills, name)
		}
		sort.Strings(skills)
		encoded, _ := json.Marshal(summaries)
		return InvestigationResult{Message: answer, Widgets: widgets, Discovery: calls, Skills: skills, Context: string(encoded), Incomplete: incomplete, Warning: warning}, err
	}
	for round := 0; round < investigationRounds; round++ {
		choice := map[string]string{"type": "auto"}
		if round == investigationRounds-1 || len(calls) >= investigationTools {
			choice = map[string]string{"type": "none"}
		}
		response, err := a.llm.Complete(ctx, CompletionRequest{Task: TaskInvestigation, System: prompt("investigate"), Messages: messages, Tools: definitions, ToolChoice: choice["type"]})
		if err != nil {
			return result("", err)
		}
		if response.StopReason == "max_tokens" {
			incomplete = true
			warning = "The configured output limit was reached. This answer is incomplete; any collected evidence is retained."
			answer := response.text()
			if answer == "" {
				answer = "The investigation did not complete. No verified conclusion was established."
			}
			return result(answer, nil)
		}
		if response.StopReason == "end_turn" {
			if !(loaded["infrastructure"] || loaded["business"] || loaded["issues"]) {
				if round < investigationRounds-1 {
					messages = append(messages, contentMessage("assistant", response.Content), textMessage("user", "Load the relevant domain skill with read_skill before answering this investigation."))
					continue
				}
				return result("", fmt.Errorf("No investigation skill was loaded."))
			}
			if metadataSeen && !measured && !nudged && round < investigationRounds-2 && len(calls) < investigationTools-2 {
				nudged = true
				messages = append(messages, contentMessage("assistant", response.Content), textMessage("user", "Only metadata has been obtained so far. Before concluding, execute a focused telemetry query or data widget to verify the finding. If measurement is unavailable, state that limitation explicitly rather than inferring health, impact or cause from metadata."))
				continue
			}
			answer := response.text()
			if answer == "" {
				if len(widgets) > 0 {
					answer = fmt.Sprintf("Added %d data widgets. No written analysis was returned.", len(widgets))
				} else {
					return result("", fmt.Errorf("LLM returned no investigation answer."))
				}
			}
			return result(answer, nil)
		}
		if response.StopReason != "tool_use" {
			return result("", fmt.Errorf("Investigation response incomplete (%s)", response.StopReason))
		}
		outputs := []LLMContent{}
		for _, block := range response.Content {
			if block.Type != "tool_use" {
				continue
			}
			started := time.Now()
			value := ""
			var toolErr error
			domain := loaded["infrastructure"] || loaded["business"] || loaded["issues"]
			switch {
			case len(calls) >= investigationTools:
				toolErr = fmt.Errorf("Tool budget exhausted. Answer using existing evidence.")
			case block.Name == "read_skill":
				var args struct {
					Name string `json:"name"`
				}
				if json.Unmarshal(block.Input, &args) != nil || skillNames[args.Name] == "" {
					toolErr = fmt.Errorf("Unknown investigation skill.")
				} else {
					content, err := investigationSkills.ReadFile("investigate-skills/" + args.Name + ".md")
					toolErr = err
					if err == nil {
						loaded[args.Name] = true
						value = string(content)
					}
				}
			case !domain:
				toolErr = fmt.Errorf("Read the infrastructure, business, or issues skill before exploring data.")
			case strings.HasPrefix(block.Name, "display_"):
				kind := strings.TrimPrefix(block.Name, "display_")
				if !loaded["widgets"] {
					toolErr = fmt.Errorf("Read the widgets skill first.")
				} else if source, err := a.widgetSource(ctx, kind, block.Input); err != nil || !discovered[source.ID] {
					toolErr = fmt.Errorf("Select a valid sourceId and discover that specific source before displaying a widget.")
				} else if len(widgets) >= 3 {
					toolErr = fmt.Errorf("At most three widgets can be inserted per turn.")
				} else {
					widget, err := a.investigationWidget(ctx, kind, block.Input, q, len(widgets))
					toolErr = err
					if err == nil {
						widgets = append(widgets, widget)
						measured = true
						summary := widgetSummary(widget)
						summaries = append(summaries, summary)
						encoded, _ := json.Marshal(summary)
						value = string(encoded)
					}
				}
			default:
				if tool, ok := available[block.Name]; ok {
					value, toolErr = a.mcps[tool.sourceID].call(ctx, tool.kind, tool.tool, block.Input, LLMRequest{Kind: tool.kind, Start: q.Start, End: q.End})
					if toolErr == nil {
						discovered[tool.sourceID] = true
						if tool.tool.Name == "query" || tool.tool.Name == "traces" {
							measured = true
						} else {
							metadataSeen = true
						}
					}
				} else {
					toolErr = fmt.Errorf("Unknown or unavailable read-only investigation tool.")
				}
			}
			record := DiscoveryCall{Tool: block.Name, ElapsedMs: time.Since(started).Milliseconds()}
			if toolErr != nil {
				record.Error = toolErr.Error()
				value = record.Error
			}
			calls = append(calls, record)
			outputs = append(outputs, toolResult(block.ID, value, toolErr != nil))
		}
		if len(outputs) == 0 {
			return result("", fmt.Errorf("No investigation tools were returned."))
		}
		remaining := max(0, investigationTools-len(calls))
		note := fmt.Sprintf("Workflow budget: %d tool calls and %d model rounds remain. Prioritize measurements over repeated metadata; reserve the final turn for evidence-based conclusions.", remaining, investigationRounds-round-1)
		if remaining <= 3 || round >= investigationRounds-3 {
			note += " Approaching the limit: finish the most discriminating check now and synthesize; state unresolved gaps."
		}
		outputs = append(outputs, LLMContent{Type: "text", Text: note})
		messages = append(messages, contentMessage("assistant", response.Content), contentMessage("user", outputs))
	}
	incomplete = true
	warning = "The investigation reached its workflow limit. Evidence is retained, but a complete conclusion was not established."
	return result("Investigation incomplete. Review the evidence and narrow the next question to an unresolved check.", nil)
}

type widgetCapture struct {
	header   http.Header
	body     bytes.Buffer
	status   int
	overflow bool
}

func (c *widgetCapture) Header() http.Header    { return c.header }
func (c *widgetCapture) WriteHeader(status int) { c.status = status }
func (c *widgetCapture) Write(p []byte) (int, error) {
	if c.body.Len()+len(p) > 8<<20 {
		c.overflow = true
		return len(p), nil
	}
	return c.body.Write(p)
}
func (a *App) investigationWidget(ctx context.Context, kind string, input json.RawMessage, q InvestigationRequest, index int) (ChatWidget, error) {
	var args struct {
		Title    string `json:"title"`
		SourceID string `json:"sourceId"`
		Query    string `json:"query"`
	}
	if json.Unmarshal(input, &args) != nil || strings.TrimSpace(args.Title) == "" || len(args.Title) > 120 || len(args.Query) > 16000 {
		return ChatWidget{}, fmt.Errorf("Invalid widget title or query.")
	}
	if kind != "metrics" && kind != "logs" && kind != "traces" {
		return ChatWidget{}, fmt.Errorf("Unknown widget type.")
	}
	if kind == "traces" {
		if err := validateJaeger(args.Query); err != nil {
			return ChatWidget{}, err
		}
	}
	var source Source
	var sourceErr error
	ctx, source, sourceErr = a.bindSource(ctx, kind, args.SourceID)
	if sourceErr != nil {
		return ChatWidget{}, sourceErr
	}
	client := a.mcps[source.ID]
	if client == nil {
		return ChatWidget{}, fmt.Errorf("MCP is not configured for this source")
	}
	if err := client.wait(ctx); err != nil {
		return ChatWidget{}, err
	}
	limit := 100
	if kind == "traces" {
		limit = 20
	}
	body, _ := json.Marshal(Query{Kind: kind, SourceID: source.ID, Query: args.Query, Start: q.Start, End: q.End, Limit: limit})
	request, _ := http.NewRequestWithContext(ctx, "POST", "http://warroom.internal/api/query", bytes.NewReader(body))
	capture := &widgetCapture{header: make(http.Header), status: 200}
	a.query(capture, request)
	if capture.overflow {
		return ChatWidget{}, fmt.Errorf("Widget result is too large; narrow the query.")
	}
	var response map[string]any
	if json.Unmarshal(capture.body.Bytes(), &response) != nil {
		return ChatWidget{}, fmt.Errorf("Invalid widget query response.")
	}
	if capture.status != 200 {
		return ChatWidget{}, fmt.Errorf("Widget query failed: %v", response["error"])
	}
	widget := ChatWidget{ID: fmt.Sprintf("widget-%d-%d", time.Now().UnixNano(), index), Kind: kind, SourceID: source.ID, Title: args.Title, Query: args.Query, Start: q.Start, End: q.End, Limit: limit, Response: response}
	if kind == "metrics" {
		if envelope, ok := response["data"].(map[string]any); ok {
			if data, ok := envelope["data"].(map[string]any); ok {
				if rows, ok := data["result"].([]any); ok && len(rows) > 40 {
					data["result"] = rows[:40]
					widget.Truncated = true
				}
			}
		}
	}
	if kind == "logs" {
		if rows, ok := response["data"].([]any); ok && len(rows) > 100 {
			response["data"] = rows[:100]
			widget.Truncated = true
		}
	}
	if kind == "traces" {
		if envelope, ok := response["data"].(map[string]any); ok {
			if rows, ok := envelope["data"].([]any); ok && len(rows) > 20 {
				envelope["data"] = rows[:20]
				widget.Truncated = true
			}
		}
	}
	return widget, nil
}

type metricEvidence struct {
	count, nonzero        int
	min, max, sum, peakAt float64
}

func newMetricEvidence() metricEvidence { return metricEvidence{min: math.Inf(1), max: math.Inf(-1)} }
func (s *metricEvidence) add(value, at float64) {
	s.count++
	s.sum += value
	if value != 0 {
		s.nonzero++
	}
	if value < s.min {
		s.min = value
	}
	if value > s.max {
		s.max = value
		s.peakAt = at
	}
}
func (s metricEvidence) summary() map[string]any {
	result := map[string]any{"valid_samples": s.count, "nonzero_samples": s.nonzero}
	if s.count > 0 {
		result["min"] = s.min
		result["max"] = s.max
		result["mean"] = s.sum / float64(s.count)
		result["peak_timestamp"] = s.peakAt
		result["nonzero_sample_fraction"] = float64(s.nonzero) / float64(s.count)
	}
	return result
}

func widgetSummary(widget ChatWidget) map[string]any {
	summary := map[string]any{"widget_id": widget.ID, "title": widget.Title, "kind": widget.Kind, "sourceId": widget.SourceID, "query": widget.Query, "start": widget.Start, "end": widget.End, "truncated": widget.Truncated}
	data := widget.Response["data"]
	if widget.Kind == "metrics" {
		if envelope, ok := data.(map[string]any); ok {
			if result, ok := envelope["data"].(map[string]any); ok {
				if series, ok := result["result"].([]any); ok {
					summary["series_count"] = len(series)
					samples := []any{}
					overall := newMetricEvidence()
					for _, entry := range series {
						row, _ := entry.(map[string]any)
						values, _ := row["values"].([]any)
						whole, early, late := newMetricEvidence(), newMetricEvidence(), newMetricEvidence()
						for _, entry := range values {
							pair, ok := entry.([]any)
							if !ok || len(pair) != 2 {
								continue
							}
							at, ok := pair[0].(float64)
							text, textOK := pair[1].(string)
							if !ok || !textOK || math.IsNaN(at) || math.IsInf(at, 0) {
								continue
							}
							v, err := strconv.ParseFloat(text, 64)
							if err != nil || math.IsNaN(v) || math.IsInf(v, 0) {
								continue
							}
							whole.add(v, at)
							overall.add(v, at)
							if at < (widget.Start+widget.End)/2 {
								early.add(v, at)
							} else {
								late.add(v, at)
							}
						}
						if len(samples) >= 12 {
							continue
						}
						sample := whole.summary()
						sample["labels"] = row["metric"]
						sample["samples"] = len(values)
						if len(values) > 0 {
							sample["first"] = values[0]
							sample["last"] = values[len(values)-1]
						}
						sample["first_half"] = early.summary()
						sample["second_half"] = late.summary()
						samples = append(samples, sample)
					}
					summary["summarized_series"] = len(samples)
					summary["series_summary_limited"] = len(series) > len(samples)
					summary["all_series_samples"] = overall.summary()
					summary["comparison_midpoint"] = (widget.Start + widget.End) / 2
					summary["statistics_note"] = "Means are arithmetic sample means. Nonzero fractions describe observed samples, not continuous time or configured capacity. Per-series detail may cover only a subset; all_series_samples covers every returned series."

					summary["series_samples"] = samples
				}
			}
		}
	}
	if widget.Kind == "logs" {
		if rows, ok := data.([]any); ok {
			summary["returned_rows"] = len(rows)
			if len(rows) > 5 {
				rows = rows[:5]
			}
			encoded, _ := json.Marshal(rows)
			if len(encoded) > 5000 {
				summary["sample_preview"] = string(encoded[:5000]) + " [truncated]"
			} else {
				summary["sample_rows"] = rows
			}
		}
	}
	if widget.Kind == "traces" {
		if envelope, ok := data.(map[string]any); ok {
			if traces, ok := envelope["data"].([]any); ok {
				summary["returned_traces"] = len(traces)
				brief := []any{}
				for _, entry := range traces {
					if len(brief) >= 5 {
						break
					}
					trace, _ := entry.(map[string]any)
					spans, _ := trace["spans"].([]any)
					id := trace["traceID"]
					operations := []string{}
					errors := 0
					start, end := math.Inf(1), 0.0
					for _, entry := range spans {
						span, _ := entry.(map[string]any)
						if id == nil {
							id = span["traceID"]
						}
						begin, _ := span["startTime"].(float64)
						duration, _ := span["duration"].(float64)
						if begin < start {
							start = begin
						}
						if begin+duration > end {
							end = begin + duration
						}
						refs, _ := span["references"].([]any)
						if len(refs) == 0 {
							if operation, ok := span["operationName"].(string); ok {
								operations = append(operations, operation)
							}
						}
						tags, _ := span["tags"].([]any)
						for _, entry := range tags {
							tag, _ := entry.(map[string]any)
							key, _ := tag["key"].(string)
							value := fmt.Sprint(tag["value"])
							if key == "error" && value == "true" || key == "otel.status_code" && strings.EqualFold(value, "ERROR") {
								errors++
								break
							}
							if key == "http.status_code" || key == "http.response.status_code" {
								code, _ := strconv.Atoi(value)
								if code >= 500 {
									errors++
									break
								}
							}
						}
					}
					item := map[string]any{"traceID": id, "span_count": len(spans), "root_operations": operations, "error_spans": errors}
					if !math.IsInf(start, 0) && end >= start {
						item["duration_ms"] = (end - start) / 1000
					}
					brief = append(brief, item)
				}
				summary["trace_samples"] = brief
			}
		}
	}
	return summary
}

func (a *App) widgetSource(ctx context.Context, kind string, input json.RawMessage) (Source, error) {
	var args struct {
		SourceID string `json:"sourceId"`
	}
	if json.Unmarshal(input, &args) != nil {
		return Source{}, fmt.Errorf("invalid widget arguments")
	}
	return a.resolveSource(ctx, kind, args.SourceID)
}
