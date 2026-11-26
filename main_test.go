package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

func request(t *testing.T, a *App, body string) *httptest.ResponseRecorder {
	t.Helper()
	w := httptest.NewRecorder()
	a.handler().ServeHTTP(w, httptest.NewRequest("POST", "/api/query", strings.NewReader(body)))
	return w
}
func TestQueryAdapters(t *testing.T) {
	tests := []struct{ kind, path, response string }{
		{"metrics", "/prefix/api/v1/query_range", `{"status":"success","data":{"resultType":"matrix","result":[]}}`},
		{"logs", "/prefix/select/logsql/query", "{\"_msg\":\"first\"}\n{\"_msg\":\"second\"}\n"},
		{"traces", "/prefix/select/jaeger/api/traces", `{"data":[],"errors":null}`},
	}
	for _, tc := range tests {
		t.Run(tc.kind, func(t *testing.T) {
			var values url.Values
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != tc.path {
					t.Errorf("path=%s", r.URL.Path)
				}
				_ = r.ParseForm()
				values = r.Form
				if r.Header.Get("Authorization") != "Bearer secret" {
					t.Error("missing server-side credential")
				}
				_, _ = io.WriteString(w, tc.response)
			}))
			defer upstream.Close()
			prefix := map[string]string{"metrics": "VM", "logs": "VL", "traces": "VT"}[tc.kind]
			t.Setenv(prefix+"_BEARER_TOKEN", "secret")
			a := newTestApp()
			a.sourceAuth[tc.kind] = sourceAuth{BearerTokenEnv: strings.ToUpper(map[string]string{"metrics": "VM", "logs": "VL", "traces": "VT"}[tc.kind]) + "_BEARER_TOKEN"}
			a.sources[tc.kind] = Source{Kind: tc.kind, Name: tc.kind, URL: upstream.URL + "/prefix"}
			query := "rate(foo[5m])"
			if tc.kind == "traces" {
				query = `service=cloud&tags={"env":"prod"}`
			}
			b, _ := json.Marshal(Query{Kind: tc.kind, Query: query, Start: 1700000000, End: 1700003600, Limit: 20})
			w := request(t, a, string(b))
			if w.Code != 200 {
				t.Fatalf("%d: %s", w.Code, w.Body)
			}
			if tc.kind == "traces" {
				if values.Get("start") != "1700000000000000" || values.Get("end") != "1700003600000000" {
					t.Error("Jaeger time must be microseconds")
				}
				if values.Get("service") != "cloud" {
					t.Error("service not forwarded")
				}
			} else {
				if values.Get("query") != query || values.Get("start") != "1700000000.000" {
					t.Error("query or seconds not forwarded")
				}
			}
			if tc.kind == "metrics" && values.Get("step") != "15" {
				t.Error("auto resolution should target 240 samples")
			}
			if tc.kind == "logs" {
				var result struct{ Data []map[string]any }
				_ = json.Unmarshal(w.Body.Bytes(), &result)
				if len(result.Data) != 2 {
					t.Fatal("NDJSON not normalized")
				}
			}
		})
	}
}
func TestInvalidQueries(t *testing.T) {
	base := Query{Kind: "metrics", Query: "up", Start: 1700000000, End: 1700003600}
	tests := []struct {
		name string
		edit func(*Query)
	}{
		{"unknown kind", func(q *Query) { q.Kind = "other" }}, {"reversed time", func(q *Query) { q.End = q.Start - 1 }}, {"too long", func(q *Query) { q.End = q.Start + 32*86400 }}, {"blank query", func(q *Query) { q.Query = " " }}, {"too many results", func(q *Query) { q.Limit = 1001 }}, {"negative limit", func(q *Query) { q.Limit = -1 }}, {"too many points", func(q *Query) { q.End = q.Start + 20000; q.Step = 1 }}, {"trace ID path injection", func(q *Query) { q.Kind = "traces"; q.TraceID = "../../etc/passwd" }}, {"missing service", func(q *Query) { q.Kind = "traces"; q.Query = "operation=foo" }}, {"unknown Jaeger parameter", func(q *Query) { q.Kind = "traces"; q.Query = "service=cloud&url=http://other" }}, {"invalid tags", func(q *Query) { q.Kind = "traces"; q.Query = "service=cloud&tags=bad" }},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			q := base
			tc.edit(&q)
			b, _ := json.Marshal(q)
			w := request(t, newTestApp(), string(b))
			if w.Code != 400 {
				t.Fatalf("got %d: %s", w.Code, w.Body)
			}
		})
	}
}
func TestUpstreamErrorAndCancellation(t *testing.T) {
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Error(w, "bad query", 422) }))
	defer up.Close()
	a := newTestApp()
	a.sources["metrics"] = Source{Kind: "metrics", Name: "VM", URL: up.URL}
	w := request(t, a, `{"kind":"metrics","query":"up","start":1700000000,"end":1700003600}`)
	if w.Code != 502 || !strings.Contains(w.Body.String(), "bad query") {
		t.Fatal(w.Code, w.Body)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	start := time.Now()
	_, err := a.upstream(ctx, "metrics", "/api/v1/query_range", nil)
	if err == nil || time.Since(start) > time.Second {
		t.Fatal("cancellation was not propagated")
	}
}
func TestTraceLookup(t *testing.T) {
	id := "0123456789abcdef0123456789abcdef"
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/select/jaeger/api/traces/"+id {
			t.Error(r.URL.Path)
		}
		_, _ = io.WriteString(w, `{"data":[]}`)
	}))
	defer up.Close()
	a := newTestApp()
	a.sources["traces"] = Source{Kind: "traces", Name: "VT", URL: up.URL}
	b, _ := json.Marshal(Query{Kind: "traces", TraceID: id, Start: 1700000000, End: 1700003600})
	if w := request(t, a, string(b)); w.Code != 200 {
		t.Fatal(w.Code, w.Body)
	}
}
func TestDemoDoesNotContactUpstream(t *testing.T) {
	a := newTestApp()
	a.client = &http.Client{Timeout: time.Nanosecond}
	for _, kind := range []string{"metrics", "logs", "traces"} {
		b, _ := json.Marshal(Query{Kind: kind, Query: "demo", Start: 1700000000, End: 1700003600, Demo: true})
		w := request(t, a, string(b))
		if w.Code != 200 || !strings.Contains(w.Body.String(), `"demo":true`) {
			t.Fatal(kind, w.Code, w.Body)
		}
	}
}

func newTestApp() *App {
	a := newApp()
	a.sources = map[string]Source{}
	a.mcps = map[string]*MCPClient{}
	for _, kind := range []string{"metrics", "logs", "traces"} {
		a.sources[kind] = Source{ID: kind, Kind: kind, Name: kind, URL: "http://source.invalid"}
		a.mcps[kind] = newMCP(kind)
	}
	return a
}
