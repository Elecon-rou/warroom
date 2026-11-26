package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

func TestDashboardVariablesValidationAndRoundtrip(t *testing.T) {
	valid := []DashboardVariable{
		{Name: "namespace", Type: "custom", Options: []string{"prod", "dev"}, Current: []string{"dev"}, Multi: true, IncludeAll: true},
		{Name: "pod", Type: "query", Source: "metrics", SourceID: "east", Query: `label_values(up{namespace=~"$namespace"}, pod)`},
	}
	d := testDashboard()
	d.Variables = valid
	data, _ := json.Marshal(d)
	parsed, err := parseDashboard(string(data))
	if err != nil || len(parsed.Variables) != 2 || parsed.Variables[0].Current[0] != "dev" {
		t.Fatal(parsed, err)
	}
	for _, invalid := range [][]DashboardVariable{
		{valid[0], valid[0]}, {valid[1], valid[0]},
		{{Name: "__from", Type: "textbox"}},
		{{Name: "environment", Type: "custom"}},
		{{Name: "environment", Type: "custom", Options: []string{"dev"}, Current: []string{"prod"}}},
		{{Name: "environment", Type: "custom", Options: []string{"dev"}, Current: []string{allVariableValues}}},
		{{Name: "pod", Type: "query", Source: "metrics", Query: `label_values(up{pod="$pod"}, pod)`}},
	} {
		d.Variables = invalid
		if d.validate() == nil {
			t.Fatalf("invalid variables accepted: %+v", invalid)
		}
	}
}
func TestDashboardVariableNativeOptionsUseSelectedSourceAndBounds(t *testing.T) {
	for _, tc := range []struct {
		kind, query, path, response string
		want                        url.Values
	}{
		{"metrics", `label_values({namespace=~"dev.*",job="api"}, pod)`, "/api/v1/label/pod/values", `{"status":"success","data":["api-b","api-a","api-a"]}`, url.Values{"match[]": {`{namespace=~"dev.*",job="api"}`}, "limit": {"201"}}},
		{"metrics", "metrics()", "/api/v1/label/__name__/values", `{"status":"success","data":["up"]}`, url.Values{}},
		{"logs", `field_values(namespace, _msg:"error")`, "/select/logsql/field_values", `{"values":[{"value":"dev"}]}`, url.Values{"field": {"namespace"}, "query": {`_msg:"error"`}}},
		{"traces", "services()", "/select/jaeger/api/services", `{"data":["api"]}`, url.Values{}},
		{"traces", `operations("api")`, "/select/jaeger/api/services/api/operations", `{"data":[{"name":"GET /"}]}`, url.Values{}},
	} {
		t.Run(tc.kind+tc.query, func(t *testing.T) {
			called := false
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				called = true
				_ = r.ParseForm()
				if r.URL.Path != tc.path {
					t.Error(r.URL.Path, tc.path)
				}
				for key, values := range tc.want {
					if r.Form.Get(key) != values[0] {
						t.Error(key, r.Form.Get(key), values[0])
					}
				}
				if tc.kind != "traces" && (!r.Form.Has("start") || !r.Form.Has("end")) {
					t.Error("missing time bounds")
				}
				w.Write([]byte(tc.response))
			}))
			defer server.Close()
			a := newApp()
			a.configureDataSources([]sourceConfig{{Source: Source{ID: "selected", Kind: tc.kind, Name: "Selected", URL: server.URL}}, {Source: Source{ID: "other", Kind: tc.kind, Name: "Other", URL: "http://127.0.0.1:1"}}})
			data, _ := json.Marshal(map[string]any{"kind": tc.kind, "sourceId": "selected", "query": tc.query, "start": 1700000000, "end": 1700003600})
			w := httptest.NewRecorder()
			a.handler().ServeHTTP(w, httptest.NewRequest("POST", "/api/dashboards/variables/options", strings.NewReader(string(data))))
			if w.Code != 200 || !called {
				t.Fatalf("%d %s", w.Code, w.Body)
			}
			var result struct {
				Data []string `json:"data"`
			}
			if json.Unmarshal(w.Body.Bytes(), &result) != nil || len(result.Data) == 0 {
				t.Fatal(w.Body)
			}
		})
	}
}
func TestDashboardVariableOptionsRejectInvalidRequestsBeforeUpstream(t *testing.T) {
	a := newTestApp()
	for _, body := range []string{
		`{"kind":"metrics","query":"delete()","start":1,"end":2}`,
		`{"kind":"logs","query":"http://other","start":1,"end":2}`,
		`{"kind":"traces","query":"shell()","start":1,"end":2}`,
		`{"kind":"metrics","sourceId":"missing","query":"metrics()","start":1,"end":2}`,
		`{"kind":"metrics","query":"metrics()","start":2,"end":1}`,
		`{"kind":"metrics","query":"metrics()","start":1,"end":2,"url":"http://other"}`,
	} {
		w := httptest.NewRecorder()
		a.handler().ServeHTTP(w, httptest.NewRequest("POST", "/api/dashboards/variables/options", strings.NewReader(body)))
		if w.Code != 400 {
			t.Fatal(w.Code, w.Body)
		}
	}
}

func TestGeneratedVariableReferencesRequireDefinitions(t *testing.T) {
	d := testDashboard()
	d.Widgets[0].Query = `up{namespace="$namespace"}`
	if validateGeneratedVariableReferences(d) == nil {
		t.Fatal("undefined generated variable accepted")
	}
	d.Variables = []DashboardVariable{{Name: "namespace", Type: "custom", Options: []string{"dev"}}}
	if err := validateGeneratedVariableReferences(d); err != nil {
		t.Fatal(err)
	}
	d.Widgets[0].Query = `label_replace(up,"version","$1","image",".*:(.*)")`
	d.Variables = nil
	if err := validateGeneratedVariableReferences(d); err != nil {
		t.Fatal(err)
	}
	d.Widgets[0].Query = `_msg:"$$HOME"`
	if err := validateGeneratedVariableReferences(d); err != nil {
		t.Fatal(err)
	}
}
