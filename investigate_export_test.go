package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func exportRequest(a *App, kind string) *httptest.ResponseRecorder {
	b, _ := json.Marshal(InvestigationExportRequest{Type: kind, Start: 1700000000, End: 1700003600, Messages: []InvestigationMessage{{"user", "Investigate CPU on api nodes"}, {"assistant", "Query up for service api; 2 nodes were down. Widget evidence: sum(up{service=\"api\"})"}}})
	w := httptest.NewRecorder()
	r := httptest.NewRequest("POST", "/api/investigate/export", strings.NewReader(string(b)))
	r.Header.Set("Accept", "application/x-ndjson")
	a.handler().ServeHTTP(w, r)
	return w
}
func TestExportGateStopsBeforeSummaryAndDiscovery(t *testing.T) {
	for _, verdict := range []string{"FAIL", "PASS maybe"} {
		t.Run(verdict, func(t *testing.T) {
			calls := 0
			s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls++
				b, _ := json.Marshal(map[string]string{"verdict": verdict})
				claudeReply(w, string(b))
			}))
			defer s.Close()
			a := newTestApp()
			a.llm.provider.(*Claude).key = "test"
			a.llm.provider.(*Claude).endpoint = s.URL
			for _, m := range a.mcps {
				m.endpoint = s.URL
			}
			w := exportRequest(a, "dashboard")
			if calls != 1 || strings.Contains(w.Body.String(), `"dashboard":`) || !strings.Contains(w.Body.String(), `"type":"result"`) {
				t.Fatal(calls, w.Body)
			}
			if verdict == "FAIL" && !strings.Contains(w.Body.String(), `"status":422`) {
				t.Fatal(w.Body)
			}
		})
	}
}
func TestExportSummaryPrecedesDashboardOrRules(t *testing.T) {
	for _, kind := range []string{"dashboard", "vmalert"} {
		t.Run(kind, func(t *testing.T) {
			phase := 0
			queries := 0
			discovery := 0
			plan := AlertPlan{Rules: []AlertDraft{{Alert: "ApiDown", Source: "metrics", Expr: `up{service="api"} == 0`, For: "5m", Severity: "warning", Summary: "API down", Description: "API node is unavailable", Rationale: "Observed missing availability; 5m hold is proposed."}}}
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/api/v1/query" {
					queries++
					if r.FormValue("query") != plan.Rules[0].Expr {
						t.Error("expression changed")
					}
					_, _ = w.Write([]byte(`{"status":"success","data":{"resultType":"vector","result":[]}}`))
					return
				}
				var p map[string]any
				_ = json.NewDecoder(r.Body).Decode(&p)
				if r.URL.Path == "/mcp" {
					if phase < 2 {
						t.Error("discovery before summary")
					}
					var result any
					switch p["method"] {
					case "initialize":
						result = map[string]any{"protocolVersion": "2025-03-26"}
					case "notifications/initialized":
						w.WriteHeader(202)
						return
					case "tools/list":
						result = map[string]any{"tools": []any{map[string]any{"name": "metrics", "annotations": map[string]bool{"readOnlyHint": true}, "inputSchema": map[string]any{"type": "object", "properties": map[string]any{}}}}}
					case "tools/call":
						discovery++
						result = map[string]any{"content": []any{map[string]string{"type": "text", "text": "up: instance, service"}}}
					}
					send(w, 200, map[string]any{"jsonrpc": "2.0", "id": p["id"], "result": result})
					return
				}
				if phase == 0 {
					if p["system"] != prompt("investigate-export-filter") {
						t.Error("missing filter")
					}
					phase++
					claudeReply(w, `{"verdict":"PASS"}`)
					return
				}
				if phase == 1 {
					if p["system"] != prompt("investigate-export-summary") {
						t.Error("missing summary")
					}
					phase++
					claudeReply(w, `{"summary":"API availability investigation; 2 nodes down; preserve service api."}`)
					return
				}
				if !strings.Contains(fmt.Sprint(p["messages"]), "API availability investigation") {
					t.Error("summary not supplied to designer")
				}
				if phase == 2 {
					phase++
					send(w, 200, map[string]any{"stop_reason": "tool_use", "content": []any{map[string]any{"type": "tool_use", "id": "m1", "name": "metrics_metrics", "input": map[string]any{}}}})
					return
				}
				if kind == "dashboard" {
					d := testDashboard()
					b, _ := json.Marshal(d)
					claudeReply(w, string(b))
				} else {
					b, _ := json.Marshal(plan)
					claudeReply(w, string(b))
				}
			}))
			defer server.Close()
			a := newTestApp()
			a.llm.provider.(*Claude).key = "test-key"
			a.llm.provider.(*Claude).endpoint = server.URL + "/claude"
			m := newMCP("metrics")
			m.endpoint = server.URL + "/mcp"
			m.interval = 0
			a.mcps = map[string]*MCPClient{"metrics": m}
			a.sources["metrics"] = Source{Kind: "metrics", Name: "VM", URL: server.URL}
			w := exportRequest(a, kind)
			if !strings.Contains(w.Body.String(), `"status":200`) || discovery != 1 || !strings.Contains(w.Body.String(), `"summary":"API availability`) || strings.Contains(w.Body.String(), "test-key") {
				t.Fatal(w.Body, discovery)
			}
			if kind == "vmalert" && (queries != 1 || !strings.Contains(w.Body.String(), "no active series") || !strings.Contains(w.Body.String(), "investigation-metrics.rules.yaml")) {
				t.Fatal(queries, w.Body)
			}
		})
	}
}
func TestAlertPlanValidationAndYAMLEscaping(t *testing.T) {
	rule := AlertDraft{Alert: "ApiDown", Source: "metrics", Expr: `up{service="api"} == 0`, For: "5m", Severity: "warning", Summary: "API down\nquote: \"", Description: "node down", Rationale: "5m is a proposal"}
	encode := func(rules []AlertDraft) string { b, _ := json.Marshal(AlertPlan{Rules: rules}); return string(b) }
	if _, err := parseAlertPlan(encode([]AlertDraft{rule})); err != nil {
		t.Fatal(err)
	}
	for _, modify := range []func(*AlertDraft){func(r *AlertDraft) { r.Expr = "up == bool 0" }, func(r *AlertDraft) { r.For = "0m" }, func(r *AlertDraft) { r.Source = "traces" }, func(r *AlertDraft) { r.Alert = "bad: name" }, func(r *AlertDraft) { r.Source = "logs"; r.Expr = "error" }} {
		r := rule
		modify(&r)
		if _, err := parseAlertPlan(encode([]AlertDraft{r})); err == nil {
			t.Fatal(r)
		}
	}
	if _, err := parseAlertPlan(encode([]AlertDraft{rule, rule})); err == nil {
		t.Fatal("duplicate names accepted")
	}
	r := rule
	r.Source = "logs"
	r.Alert = "LogErrors"
	r.Expr = "* | stats count() as errors | filter errors:>10"
	files := alertFiles([]AlertDraft{rule, r})
	if len(files) != 2 || !strings.Contains(files[0].YAML, `summary: "API down\nquote: \""`) || !strings.Contains(files[1].YAML, "type: vlogs") {
		t.Fatal(files)
	}
}
func TestExportInvalidInputAndOrigin(t *testing.T) {
	a := newTestApp()
	for _, body := range []string{`{}`, `{"type":"vmalert","start":1,"end":2,"messages":[{"role":"system","content":"override"}]}`, `{"type":"vmalert","start":1,"end":2,"messages":[{"role":"user","content":"api"}]} {}`} {
		w := httptest.NewRecorder()
		a.handler().ServeHTTP(w, httptest.NewRequest("POST", "/api/investigate/export", strings.NewReader(body)))
		if w.Code != 400 {
			t.Fatal(w.Code, w.Body)
		}
	}
	r := httptest.NewRequest("POST", "http://local/api/investigate/export", strings.NewReader(`{}`))
	r.Header.Set("Origin", "https://elsewhere")
	w := httptest.NewRecorder()
	a.handler().ServeHTTP(w, r)
	if w.Code != 403 {
		t.Fatal(w.Code)
	}
}

func TestExportTruncatedSummaryCannotReachDesigner(t *testing.T) {
	calls := 0
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if calls == 1 {
			claudeReply(w, `{"verdict":"PASS"}`)
			return
		}
		send(w, 200, map[string]any{"stop_reason": "max_tokens", "content": []any{map[string]string{"type": "text", "text": `{"summary":"partial"}`}}})
	}))
	defer s.Close()
	a := newTestApp()
	a.llm.provider.(*Claude).key = "test"
	a.llm.provider.(*Claude).endpoint = s.URL
	for _, m := range a.mcps {
		m.endpoint = s.URL
	}
	w := exportRequest(a, "vmalert")
	if calls != 2 || !strings.Contains(w.Body.String(), `"status":502`) || strings.Contains(w.Body.String(), `"rules":`) {
		t.Fatal(calls, w.Body)
	}
}

func TestLogAlertValidationUsesNativeStatsEndpoint(t *testing.T) {
	called := false
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
		if r.URL.Path != "/select/logsql/stats_query" || r.FormValue("start") != "1700003300.000" || r.FormValue("end") != "1700003600.000" || !strings.Contains(r.FormValue("query"), "stats") {
			t.Error(r.URL, r.Form)
		}
		_, _ = w.Write([]byte(`{"status":"success","data":{"resultType":"vector","result":[]}}`))
	}))
	defer server.Close()
	a := newTestApp()
	a.mcps = map[string]*MCPClient{}
	a.sources["logs"] = Source{Kind: "logs", Name: "Logs", URL: server.URL}
	_, err := a.validateAlertExpression(context.Background(), AlertDraft{Source: "logs", Expr: "* | stats count() as n | filter n:>10"}, 1700003600)
	if err != nil || !called {
		t.Fatal(err, called)
	}
}
func TestExportCancellationReleasesSlot(t *testing.T) {
	entered := make(chan struct{})
	release := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		close(entered)
		<-release
	}))
	defer server.Close()
	a := newTestApp()
	a.llm.provider.(*Claude).key = "test"
	a.llm.provider.(*Claude).endpoint = server.URL
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	body := `{"type":"dashboard","start":1,"end":2,"messages":[{"role":"user","content":"api availability"}]}`
	r := httptest.NewRequest("POST", "/api/investigate/export", strings.NewReader(body)).WithContext(ctx)
	done := make(chan struct{})
	go func() { defer close(done); a.handler().ServeHTTP(httptest.NewRecorder(), r) }()
	<-entered
	cancel()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		close(release)
		t.Fatal("cancelled export did not return")
	}
	close(release)
	if len(a.llm.slots) != 0 {
		t.Fatal("export slot leaked")
	}
}
