package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestMCPVariableInterpolation(t *testing.T) {
	ctx := withDashboardVariables(context.Background(), []DashboardVariable{
		{Name: "namespace", Type: "custom", Options: []string{"prod.api", "dev"}, Current: []string{"prod.api", "dev"}, Multi: true, IncludeAll: true},
		{Name: "service", Type: "textbox", Current: []string{`a"&/b`}},
		{Name: "pending", Type: "query", Source: "metrics", Query: "label_values(up, job)"},
	})
	q := LLMRequest{Start: 1700000000, End: 1700003600, variables: dashboardVariablesFromContext(ctx)}
	for _, tc := range []struct {
		input, kind string
		plain       bool
		want        string
		fail        bool
	}{
		{`up{namespace=~"$namespace"}`, "metrics", false, `up{namespace=~"(prod\\.api|dev)"}`, false},
		{`up{namespace="$namespace"}`, "metrics", false, "", true},
		{`$missing`, "metrics", false, "", true},
		{`$pending`, "metrics", false, "", true},
		{`$namespace`, "traces", true, "", true},
		{`$service`, "traces", true, `a"&/b`, false},
		{`_msg:"$service"`, "logs", false, `_msg:"a\"&/b"`, false},
		{`$__range $__interval $__rate_interval $__from`, "metrics", false, `3600s 15s 60s 1700000000000`, false},
		{`label_replace(up,"x","$1","x",".*") $$cash`, "metrics", false, `label_replace(up,"x","$1","x",".*") $cash`, false},
		{`${namespace:csv}`, "metrics", false, `prod.api,dev`, false},
		{`${namespace:json}`, "metrics", false, `["prod.api","dev"]`, false},
		{`${namespace:unsupported}`, "metrics", false, "", true},
	} {
		got, err := renderMCPVariableString(tc.input, tc.kind, tc.plain, q)
		if (err != nil) != tc.fail || (!tc.fail && got != tc.want) {
			t.Errorf("%s => %q, %v; want %q", tc.input, got, err, tc.want)
		}
	}
	q.variables.definitions[0].Current = []string{allVariableValues}
	got, err := renderMCPVariableString(`up{namespace=~"$namespace"}`, "metrics", false, q)
	if err != nil || got != `up{namespace=~".*"}` {
		t.Fatal(got, err)
	}
	gotValue, err := renderMCPVariableValue(map[string]any{"tags": []any{"$service"}}, "traces", true, q, 0)
	if err != nil || gotValue.(map[string]any)["tags"].([]any)[0] != `a"&/b` {
		t.Fatal(gotValue, err)
	}
	tool := testTool("query", map[string]any{"query": nil, "tenant": nil})
	args, err := boundedMCPArgs("metrics", tool, json.RawMessage(`{"query":"up{namespace=~\"$namespace\"}","tenant":"$missing"}`), q)
	if err != nil || args["query"] != `limit_offset(5, 0, (up{namespace=~".*"}))` || args["tenant"] != nil {
		t.Fatal(args, err)
	}
	traceTool := testTool("traces", map[string]any{"tags": nil})
	args, err = boundedMCPArgs("traces", traceTool, json.RawMessage(`{"tags":"{\"service\":\"$service\"}"}`), q)
	if err != nil {
		t.Fatal(err)
	}
	var tags map[string]string
	if json.Unmarshal([]byte(args["tags"].(string)), &tags) != nil || tags["service"] != `a"&/b` {
		t.Fatal(args)
	}
	q.variables.definitions[1].Current = []string{strings.Repeat("x", 4001)}
	if _, err := renderMCPVariableString("$service", "logs", true, q); err == nil {
		t.Fatal("unbounded expansion")
	}
}

func TestDashboardVariableToolIsolation(t *testing.T) {
	a := newTestApp()
	original := []DashboardVariable{{Name: "env", Type: "custom", Options: []string{"prod"}, Current: []string{"prod"}}}
	first := withDashboardVariables(context.Background(), original)
	second := withDashboardVariables(context.Background(), original)
	original[0].Current[0] = "changed"
	if dashboardVariablesFromContext(first).values()["env"][0] != "prod" {
		t.Fatal("shared input storage")
	}
	if _, err := a.dashboardVariableTool(first, json.RawMessage(`{"action":"define","variables":[{"name":"env","type":"custom","options":["dev"],"current":["dev"]}]}`)); err != nil {
		t.Fatal(err)
	}
	if dashboardVariablesFromContext(second).values()["env"][0] != "prod" {
		t.Fatal("cross-request mutation")
	}
	for _, input := range []string{
		`{"action":"define","variables":[{"name":"bad","type":"query","source":"metrics","sourceId":"missing","query":"metrics()"}]}`,
		`{"action":"define","variables":[{"name":"bad","type":"custom"},{"name":"bad","type":"custom"}]}`,
		`{"action":"inspect"} {}`,
	} {
		if _, err := a.dashboardVariableTool(first, json.RawMessage(input)); err == nil {
			t.Fatal("accepted invalid definitions", input)
		}
	}
	if dashboardVariablesFromContext(first).values()["env"][0] != "dev" {
		t.Fatal("failed validation mutated bindings")
	}
	d := testDashboard()
	d.Widgets[0].Query = `up{env="$env"}`
	data, _ := json.Marshal(d)
	parsed, err := parseGeneratedDashboardInScope("Result:\n"+string(data), 1700000000, 1700003600, dashboardVariablesFromContext(first))
	if err != nil || len(parsed.Variables) != 1 || validateGeneratedVariableReferences(parsed) != nil {
		t.Fatal(parsed, err)
	}
}

func TestDashboardGenerationUsesMCPVariableBindings(t *testing.T) {
	calls, upstream := 0, 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var payload map[string]any
		_ = json.NewDecoder(r.Body).Decode(&payload)
		var result any
		switch payload["method"] {
		case "initialize":
			result = map[string]any{"protocolVersion": "2025-03-26"}
		case "notifications/initialized":
			w.WriteHeader(202)
			return
		case "tools/list":
			result = map[string]any{"tools": []any{map[string]any{"name": "query", "annotations": map[string]any{"readOnlyHint": true}, "inputSchema": map[string]any{"type": "object", "properties": map[string]any{"query": map[string]any{"type": "string"}}}}}}
		case "tools/call":
			upstream++
			args := payload["params"].(map[string]any)["arguments"].(map[string]any)
			if args["query"] != `limit_offset(5, 0, (up{env="dev"}))` {
				t.Error(args)
			}
			result = map[string]any{"content": []any{map[string]any{"type": "text", "text": "up=1"}}}
		}
		send(w, 200, map[string]any{"jsonrpc": "2.0", "id": payload["id"], "result": result})
	}))
	defer server.Close()
	a := newTestApp()
	client := newMCP("metrics")
	client.endpoint = server.URL
	client.interval = 0
	a.mcps = map[string]*MCPClient{"metrics": client}
	a.llm = newLLM(&fakeLLMProvider{complete: func(ctx context.Context, q CompletionRequest) (CompletionResponse, error) {
		calls++
		if calls == 1 {
			return llmText(`{"verdict":"PASS"}`), nil
		}
		if calls == 2 {
			encoded, _ := json.Marshal(q.Messages)
			if !strings.Contains(string(encoded), "selected_values") || !strings.Contains(string(encoded), "prod") || !strings.Contains(q.System, "Working bindings") {
				t.Error("missing variable context or skill")
			}
			found := false
			for _, tool := range q.Tools {
				if tool.Name == "dashboard_variables" {
					found = true
				}
			}
			if !found {
				t.Fatal("missing variable tool")
			}
			return CompletionResponse{StopReason: "tool_use", Content: []LLMContent{
				{Type: "tool_use", ID: "define", Name: "dashboard_variables", Input: json.RawMessage(`{"action":"define","variables":[{"name":"env","type":"custom","options":["dev"],"current":["dev"]}]}`)},
				{Type: "tool_use", ID: "check", Name: "metrics_query", Input: json.RawMessage(`{"query":"up{env=\"$env\"}"}`)},
			}}, nil
		}
		d := testDashboard()
		d.Widgets[0].Query = `up{env="$env"}`
		data, _ := json.Marshal(d)
		if q.NewTextSink != nil {
			sink := q.NewTextSink()
			sink(string(data))
		}
		return llmText(string(data)), nil
	}}, nil)
	current := testDashboard()
	current.Variables = []DashboardVariable{{Name: "env", Type: "custom", Options: []string{"prod"}, Current: []string{"prod"}}}
	bodyBytes, _ := json.Marshal(map[string]any{"prompt": "CPU dashboard by environment", "start": 1700000000, "end": 1700003600, "dashboard": current})
	body := string(bodyBytes)
	request := httptest.NewRequest("POST", "/api/dashboards/generate", strings.NewReader(body))
	request.Header.Set("Accept", "application/x-ndjson")
	response := httptest.NewRecorder()
	a.handler().ServeHTTP(response, request)
	text := response.Body.String()
	if response.Code != 200 || upstream != 1 || !strings.Contains(text, `"status":200`) || !strings.Contains(text, `"variables":[{"name":"env"`) || !strings.Contains(text, `$env`) {
		t.Fatal(response.Code, text, upstream)
	}
}
