package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestGraphMetricsRED(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		query := r.Form.Get("query")
		value := "100"
		switch {
		case strings.Contains(query, "failed_total"):
			value = "5"
		case strings.Contains(query, "histogram_quantile"):
			value = "90"
		case strings.Contains(query, "_seconds_sum"):
			value = "20"
		}
		send(w, 200, map[string]any{"status": "success", "data": map[string]any{"result": []any{map[string]any{"metric": map[string]string{"client": "api", "server": "db"}, "value": []any{1700000010, value}}}}})
	}))
	defer server.Close()
	a := newTestApp()
	a.sources["metrics"] = Source{Kind: "metrics", Name: "VM", URL: server.URL}
	g := newGraphBuilder()
	warnings := a.graphMetrics(context.Background(), GraphRequest{Start: 1700000000, End: 1700000010}, g)
	if len(warnings) != 0 || len(g.edges) != 1 {
		t.Fatal(warnings, g.edges)
	}
	e := g.edges["api\x00db"]
	if e.RPS == nil || *e.RPS != 10 || e.ErrorRatio == nil || *e.ErrorRatio != .05 || e.MeanMs == nil || *e.MeanMs != 20 || e.P95Ms == nil || *e.P95Ms != 90 {
		t.Fatalf("bad RED values: %+v", e)
	}
}
func TestTraceGraphRelationshipsAndExternalDatabase(t *testing.T) {
	var trace graphTrace
	_ = json.Unmarshal([]byte(`{"traceID":"t1","processes":{"p1":{"serviceName":"api"},"p2":{"serviceName":"worker"}},"spans":[{"spanID":"client","processID":"p1","duration":30000,"tags":[{"key":"span.kind","value":"client"},{"key":"peer.service","value":"worker"}]},{"spanID":"server","processID":"p2","duration":20000,"references":[{"refType":"CHILD_OF","spanID":"client"}],"tags":[{"key":"http.status_code","value":"503"}]},{"spanID":"database","processID":"p2","duration":10000,"tags":[{"key":"span.kind","value":"client"},{"key":"db.system.name","value":"postgresql"},{"key":"db.namespace","value":"app"}]}]}`), &trace)
	g := newGraphBuilder()
	e := g.edge("api", "worker", "metrics")
	e.RPS = fp(10)
	g.sampleTrace(trace)
	if len(g.edges) != 2 || e.SampleCalls != 1 || e.SampleErrors != 1 || e.SampleMeanMs == nil || *e.SampleMeanMs != 20 || *e.RPS != 10 {
		t.Fatalf("incorrect merged graph: %+v", g.edges)
	}
	if g.nodes["postgresql/app"] != "database" || g.edges["worker\x00postgresql/app"].SampleCalls != 1 {
		t.Fatal(g.nodes, g.edges)
	}
}
func TestGraphTraceFallbackMergesPartialTraces(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/select/jaeger/api/dependencies":
			_, _ = io.WriteString(w, `{"data":[]}`)
		case "/select/jaeger/api/services":
			_, _ = io.WriteString(w, `{"data":["api","worker"]}`)
		case "/select/jaeger/api/traces":
			if r.URL.Query().Get("service") == "api" {
				_, _ = io.WriteString(w, `{"data":[{"processes":{"p1":{"serviceName":"api"}},"spans":[{"traceID":"t1","spanID":"a","processID":"p1","duration":10000}]}]}`)
			} else {
				_, _ = io.WriteString(w, `{"data":[{"processes":{"p1":{"serviceName":"worker"}},"spans":[{"traceID":"t1","spanID":"b","processID":"p1","duration":5000,"references":[{"refType":"CHILD_OF","spanID":"a"}]}]}]}`)
			}
		default:
			t.Error("unexpected path", r.URL.Path)
		}
	}))
	defer server.Close()
	a := newTestApp()
	a.sources["traces"] = Source{Kind: "traces", Name: "VT", URL: server.URL}
	g := newGraphBuilder()
	count, _ := a.graphTraces(context.Background(), GraphRequest{Start: 1700000000, End: 1700003600}, g)
	if count != 1 || len(g.edges) != 1 || g.edges["api\x00worker"] == nil || g.edges["api\x00worker"].SampleCalls != 1 {
		t.Fatal(count, g.edges)
	}
}
func TestGraphPartialFailureKeepsOtherSource(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "dependencies") {
			_, _ = io.WriteString(w, `{"data":[{"parent":"api","child":"db","callCount":10}]}`)
		} else {
			http.Error(w, "metrics unavailable", 503)
		}
	}))
	defer server.Close()
	a := newTestApp()
	a.sources["metrics"] = Source{Kind: "metrics", Name: "VM", URL: server.URL}
	a.sources["traces"] = Source{Kind: "traces", Name: "VT", URL: server.URL}
	w := httptest.NewRecorder()
	a.handler().ServeHTTP(w, httptest.NewRequest("POST", "/api/service-graph", strings.NewReader(`{"start":1700000000,"end":1700003600,"source":"combined"}`)))
	var graph ServiceGraph
	_ = json.Unmarshal(w.Body.Bytes(), &graph)
	if w.Code != 200 || len(graph.Edges) != 1 || len(graph.Warnings) == 0 || graph.Edges[0].TraceCalls == nil || *graph.Edges[0].TraceCalls != 10 {
		t.Fatal(w.Code, w.Body)
	}
}
