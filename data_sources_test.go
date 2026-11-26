package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestDataSourceConfiguration(t *testing.T) {
	t.Setenv("DATA_SOURCES_FILE", "")
	t.Setenv("DATA_SOURCES_JSON", "")
	configs, err := loadDataSources()
	if err != nil || len(configs) != 0 || len(newApp().sourceList()) != 0 {
		t.Fatal("configuration must start empty", err)
	}
	for _, invalid := range []string{
		`null`, `{}`, `[] {}`, `[{"id":"a","kind":"other","name":"A","url":"https://example.com"}]`,
		`[{"id":"a","kind":"metrics","name":"A","url":"https://secret@example.com"}]`,
		`[{"id":"a","kind":"metrics","name":"A","url":"https://example.com","token":"secret"}]`,
		`[{"id":"a","kind":"metrics","name":"A","url":"https://example.com","headers":{"Authorization":"secret"}}]`,
		`[{"id":"a","kind":"metrics","name":"A","url":"https://example.com"},{"id":"a","kind":"logs","name":"B","url":"https://example.com"}]`,
	} {
		t.Setenv("DATA_SOURCES_JSON", invalid)
		if _, err := loadDataSources(); err == nil {
			t.Fatalf("accepted invalid config: %s", invalid)
		}
	}
	t.Setenv("DATA_SOURCES_JSON", `[{"id":"east","kind":"metrics","name":"East","url":"https://metrics.example.com","bearerTokenEnv":"METRICS_TOKEN","mcp":{"url":"https://mcp.example.com/mcp","bearerTokenEnv":"MCP_TOKEN"}}]`)
	configs, err = loadDataSources()
	if err != nil {
		t.Fatal(err)
	}
	if configs[0].BearerTokenEnv != "METRICS_TOKEN" || configs[0].MCP.BearerTokenEnv != "MCP_TOKEN" {
		t.Fatal("auth references not decoded")
	}
	a := newApp()
	a.configureDataSources(configs)
	w := httptest.NewRecorder()
	a.handler().ServeHTTP(w, httptest.NewRequest("GET", "/api/sources", nil))
	if w.Code != 200 || strings.Contains(w.Body.String(), "TOKEN") || strings.Contains(w.Body.String(), "mcp") {
		t.Fatalf("unsafe source response: %s", w.Body)
	}
	t.Setenv("DATA_SOURCES_FILE", "/nonexistent")
	if _, err := loadDataSources(); err == nil {
		t.Fatal("accepted conflicting config")
	}
}

func TestMultipleSourcesRouteQueriesAndMetadata(t *testing.T) {
	a := newApp()
	configs := []sourceConfig{}
	calls := map[string]int{}
	for _, id := range []string{"east", "west"} {
		id := id
		tokenVar := strings.ToUpper(id) + "_TOKEN"
		t.Setenv(tokenVar, id+"-credential")
		upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			calls[id]++
			if r.Header.Get("Authorization") != "Bearer "+id+"-credential" {
				t.Error("wrong credential for", id)
			}
			if strings.Contains(r.URL.Path, "label") {
				fmt.Fprintf(w, `{"status":"success","data":["%s"]}`, id)
				return
			}
			fmt.Fprint(w, `{"status":"success","data":{"resultType":"matrix","result":[]}}`)
		}))
		defer upstream.Close()
		configs = append(configs, sourceConfig{Source: Source{ID: id, Kind: "metrics", Name: id, URL: upstream.URL}, sourceAuth: sourceAuth{BearerTokenEnv: tokenVar}})
	}
	a.configureDataSources(configs)
	for _, id := range []string{"east", "west"} {
		body, _ := json.Marshal(Query{Kind: "metrics", SourceID: id, Query: "up", Start: 1700000000, End: 1700003600})
		if w := request(t, a, string(body)); w.Code != 200 {
			t.Fatalf("%s: %s", id, w.Body)
		}
	}
	if calls["east"] != 1 || calls["west"] != 1 {
		t.Fatal(calls)
	}
	if w := request(t, a, `{"kind":"metrics","query":"up","start":1700000000,"end":1700003600}`); w.Code != 400 {
		t.Fatal("ambiguous selection accepted", w.Code)
	}
	if _, err := a.resolveSource(context.Background(), "logs", "east"); err == nil {
		t.Fatal("accepted wrong kind")
	}
	for _, id := range []string{"east", "west"} {
		w := httptest.NewRecorder()
		a.handler().ServeHTTP(w, httptest.NewRequest("GET", "/api/metrics/metadata?type=metrics&sourceId="+id, nil))
		if w.Code != 200 || !strings.Contains(w.Body.String(), id) {
			t.Fatalf("metadata %s: %d %s", id, w.Code, w.Body)
		}
	}
}

func TestNoDashboardDirectoryFallback(t *testing.T) {
	t.Setenv("DASHBOARDS_DIR", "")
	w := httptest.NewRecorder()
	newApp().handler().ServeHTTP(w, httptest.NewRequest("GET", "/api/dashboards", nil))
	if w.Code != 200 || strings.Contains(w.Body.String(), "README") {
		t.Fatalf("%d %s", w.Code, w.Body)
	}
}

func TestAlertExportsKeepSourceInstancesSeparate(t *testing.T) {
	files := alertFiles([]AlertDraft{
		{Source: "metrics", SourceID: "east", Alert: "EastFailure", Expr: "up == 0"},
		{Source: "metrics", SourceID: "west", Alert: "WestFailure", Expr: "up == 0"},
	})
	if len(files) != 2 || files[0].SourceID == files[1].SourceID {
		t.Fatal("source instances merged", files)
	}
	for _, file := range files {
		other := "WestFailure"
		if file.SourceID == "west" {
			other = "EastFailure"
		}
		if strings.Contains(file.YAML, other) {
			t.Fatal("cross-source alert export", file.Name)
		}
	}
}
