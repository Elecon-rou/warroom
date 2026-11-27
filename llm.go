package main

import (
	"context"
	"embed"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"
)

//go:embed prompts/*.md
var promptFiles embed.FS

func prompt(name string) string {
	b, _ := promptFiles.ReadFile("prompts/" + name + ".md")
	return string(b)
}

type LLMRequest struct {
	variables *dashboardVariableScope
	Kind      string  `json:"kind"`
	SourceID  string  `json:"sourceId,omitempty"`
	Prompt    string  `json:"prompt"`
	Start     float64 `json:"start"`
	End       float64 `json:"end"`
}

func (a *App) generate(w http.ResponseWriter, r *http.Request) {
	if origin := r.Header.Get("Origin"); origin != "" {
		parsed, err := url.Parse(origin)
		if err != nil || parsed.Host != r.Host || (parsed.Scheme != "http" && parsed.Scheme != "https") {
			fail(w, 403, "Cross-origin LLM requests are not allowed.")
			return
		}
	}
	if r.Header.Get("Sec-Fetch-Site") == "cross-site" {
		fail(w, 403, "Cross-origin LLM requests are not allowed.")
		return
	}

	var q LLMRequest
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 32<<10))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&q); err != nil {
		fail(w, 400, "Invalid LLM request.")
		return
	}
	sourceCtx, _, sourceErr := a.bindSource(r.Context(), q.Kind, q.SourceID)
	if sourceErr != nil {
		fail(w, 400, sourceErr.Error())
		return
	}
	r = r.WithContext(sourceCtx)
	q.Prompt = strings.TrimSpace(q.Prompt)
	if q.Prompt == "" || len(q.Prompt) > 8000 {
		fail(w, 400, "Prompt must contain 1–8000 bytes.")
		return
	}
	if q.Start <= 0 || q.End <= q.Start || q.End-q.Start > 31*86400 {
		fail(w, 400, "Invalid time range.")
		return
	}
	c := a.llm
	if !c.Info().Configured {
		fail(w, 503, "LLM provider is not configured on the server.")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 180*time.Second)
	defer cancel()
	release, acquireErr := c.acquire(ctx)
	if acquireErr != nil {
		fail(w, 408, "LLM request cancelled.")
		return
	}
	defer release()
	verdict, err := c.message(ctx, prompt("filter"), map[string]string{"datasource": q.Kind, "input": q.Prompt})
	if err != nil {
		fail(w, llmErrorStatus(w, err), err.Error())
		return
	}
	if verdict == "FAIL" {
		send(w, 422, map[string]string{"verdict": "FAIL", "error": "Request rejected by the semantic filter."})
		return
	}
	if verdict != "PASS" {
		fail(w, 502, "Semantic filter returned an invalid verdict; generation was not run.")
		return
	}
	result, discovery, err := a.constructWithMCP(ctx, q)
	if err != nil {
		send(w, llmErrorStatus(w, err), map[string]any{"verdict": "PASS", "error": err.Error(), "discovery": discovery})
		return
	}
	var generated struct {
		Query string `json:"query"`
		Error string `json:"error"`
	}
	if json.Unmarshal([]byte(result), &generated) != nil {
		send(w, 502, map[string]string{"verdict": "PASS", "error": "LLM returned an invalid query object."})
		return
	}
	generated.Query = strings.TrimSpace(generated.Query)
	if generated.Error != "" || generated.Query == "" || len(generated.Query) > 16000 {
		message := generated.Error
		if message == "" {
			message = "LLM did not produce a usable query."
		}
		send(w, 422, map[string]string{"verdict": "PASS", "error": message})
		return
	}
	if q.Kind == "traces" {
		if err := validateJaeger(generated.Query); err != nil {
			send(w, 422, map[string]string{"verdict": "PASS", "error": err.Error()})
			return
		}
	}
	send(w, 200, map[string]any{"verdict": "PASS", "query": generated.Query, "model": c.Info().Model, "discovery": discovery})
}
func validateJaeger(query string) error {
	params, err := url.ParseQuery(query)
	if err != nil || params.Get("service") == "" {
		return fmt.Errorf("Generated Jaeger search must specify a service.")
	}
	allowed := map[string]bool{"service": true, "operation": true, "tags": true, "minDuration": true, "maxDuration": true}
	for key, values := range params {
		if !allowed[key] || len(values) != 1 {
			return fmt.Errorf("Generated Jaeger search contains an unsupported parameter.")
		}
	}
	if tags := params.Get("tags"); tags != "" {
		var values map[string]string
		if json.Unmarshal([]byte(tags), &values) != nil {
			return fmt.Errorf("Generated Jaeger tags must be a JSON object of strings.")
		}
	}
	return nil
}

type DiscoveryCall struct {
	Tool      string `json:"tool"`
	ElapsedMs int64  `json:"elapsedMs"`
	Error     string `json:"error,omitempty"`
}

func (a *App) constructWithMCP(ctx context.Context, q LLMRequest) (string, []DiscoveryCall, error) {
	client := a.mcpFor(ctx, q.Kind)
	if client == nil {
		return "", nil, fmt.Errorf("MCP is not configured for this source")
	}
	definitions, available, err := client.definitions(ctx, q.Kind)
	if err != nil {
		return "", nil, fmt.Errorf("MCP discovery unavailable: %w", err)
	}
	language := map[string]string{"metrics": "PromQL / MetricsQL range expression", "logs": "native LogsQL (not Loki LogQL)", "traces": "Jaeger URL-encoded search parameters (not TraceQL or LogsQL)"}[q.Kind]
	initial, _ := json.Marshal(map[string]any{"accepted_input": q.Prompt, "datasource": q.Kind, "query_language": language, "time_range": map[string]float64{"start": q.Start, "end": q.End}, "discovery_limits": map[string]any{"requests_per_second": mcpRPS(), "max_tool_calls": 8, "sample_rows": 5}})
	messages := []LLMMessage{textMessage("user", string(initial))}
	calls := []DiscoveryCall{}
	successful := 0
	for round := 0; round < 6; round++ {
		choice := map[string]string{"type": "auto"}
		if round == 0 {
			choice["type"] = "any"
		}
		if round == 5 || len(calls) >= 8 {
			choice["type"] = "none"
		}
		response, err := a.llm.Complete(ctx, CompletionRequest{
			Task: TaskQuery, MaxTokens: 1800, System: prompt(q.Kind) + "\n" + prompt("discovery"),
			Messages: messages, Tools: definitions, ToolChoice: choice["type"],
			Schema: investigationSchema(map[string]any{"query": map[string]string{"type": "string"}, "error": map[string]string{"type": "string"}}, "query", "error"),
		})
		if err != nil {
			return "", calls, err
		}
		if response.StopReason == "end_turn" {
			if successful == 0 {
				detail := ""
				if len(calls) > 0 {
					detail = ": " + calls[len(calls)-1].Error
				}
				return "", calls, fmt.Errorf("no successful MCP discovery; final query was not accepted%s", detail)
			}
			return response.text(), calls, nil
		}
		if response.StopReason != "tool_use" {
			return "", calls, fmt.Errorf("LLM construction incomplete (%s)", response.StopReason)
		}
		results := []LLMContent{}
		for _, block := range response.Content {
			if block.Type != "tool_use" {
				continue
			}
			started := time.Now()
			var value string
			var callErr error
			if len(calls) >= 8 {
				callErr = fmt.Errorf("discovery call budget exhausted; return the final query using existing results")
			} else if tool, ok := available[block.Name]; ok {
				value, callErr = client.call(ctx, q.Kind, tool, block.Input, q)
			} else {
				callErr = fmt.Errorf("tool is not available for this source")
			}
			record := DiscoveryCall{Tool: block.Name, ElapsedMs: time.Since(started).Milliseconds()}
			if callErr != nil {
				record.Error = callErr.Error()
				value = record.Error
			} else {
				successful++
			}
			calls = append(calls, record)
			results = append(results, toolResult(block.ID, value, callErr != nil))
		}
		if len(results) == 0 {
			return "", calls, fmt.Errorf("LLM returned no executable discovery calls")
		}
		messages = append(messages, contentMessage("assistant", response.Content), contentMessage("user", results))
	}
	return "", calls, fmt.Errorf("MCP discovery round limit reached")
}
