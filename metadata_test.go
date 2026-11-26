package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestBuilderMetadataAdapters(t *testing.T) {
	calls := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		_ = r.ParseForm()
		if r.URL.Path == "/prefix/api/v1/label/__name__/values" {
			if r.Form.Get("match[]") != `{__name__=~".*node\\.cpu.*"}` || r.Form.Get("start") != "1700000000.000" || r.Form.Get("limit") != "1000" {
				t.Error(r.Form)
			}
			fmt.Fprint(w, `{"status":"success","data":["node.cpu","node.cpu_count"]}`)
		} else if r.URL.Path == "/prefix/api/v1/labels" {
			if r.Form.Get("match[]") != "up" {
				t.Error(r.Form)
			}
			fmt.Fprint(w, `{"status":"success","data":["job","instance"]}`)
		} else if r.URL.Path == "/prefix/api/v1/label/job/values" {
			if r.Form.Get("match[]") != "up" {
				t.Error(r.Form)
			}
			fmt.Fprint(w, `{"status":"success","data":["worker","api"]}`)
		} else if r.URL.Path == "/prefix/select/jaeger/api/services/aloha-cloud/operations" {
			fmt.Fprint(w, `{"data":[{"name":"POST /pay","spanKind":"server"},"GET /health",{"name":"POST /pay"}],"errors":null}`)
		} else {
			t.Error("unexpected upstream path", r.URL.Path)
			http.Error(w, "missing", 404)
		}
	}))
	defer upstream.Close()
	a := newTestApp()
	a.sources["metrics"] = Source{Kind: "metrics", Name: "VM", URL: upstream.URL + "/prefix"}
	a.sources["traces"] = Source{Kind: "traces", Name: "VT", URL: upstream.URL + "/prefix"}
	tests := []struct {
		path     string
		expected []string
	}{
		{"/api/metrics/metadata?type=metrics&search=node.cpu&start=1700000000&end=1700003600", []string{"node.cpu", "node.cpu_count"}},
		{"/api/metrics/metadata?type=labels&metric=up", []string{"instance", "job"}},
		{"/api/metrics/metadata?type=values&metric=up&label=job", []string{"api", "worker"}},
		{"/api/operations?service=aloha-cloud", []string{"GET /health", "POST /pay"}},
	}
	for _, test := range tests {
		w := httptest.NewRecorder()
		a.handler().ServeHTTP(w, httptest.NewRequest("GET", test.path, nil))
		if w.Code != 200 {
			t.Fatal(test.path, w.Code, w.Body)
		}
		var response struct {
			Data []string `json:"data"`
		}
		_ = json.Unmarshal(w.Body.Bytes(), &response)
		if fmt.Sprint(response.Data) != fmt.Sprint(test.expected) {
			t.Fatal(response.Data, test.expected)
		}
	}
	for _, path := range []string{"/api/metrics/metadata?type=secret", "/api/metrics/metadata?type=labels&metric=up%7D%2Bevil", "/api/metrics/metadata?type=values&metric=up&label=..%2Fsecret", "/api/metrics/metadata?type=metrics&start=NaN", "/api/metrics/metadata?type=metrics&start=1&end=9999999999", "/api/operations"} {
		w := httptest.NewRecorder()
		a.handler().ServeHTTP(w, httptest.NewRequest("GET", path, nil))
		if w.Code != 400 {
			t.Fatal(path, w.Code)
		}
	}
	if calls != len(tests) {
		t.Fatal("invalid metadata requests reached upstream", calls)
	}
}

func TestLogsBuilderMetadata(t *testing.T) {
	calls := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		_ = r.ParseForm()
		if r.Form.Get("query") != "level:error" || r.Form.Get("start") != "1700000000.000" || r.Form.Get("end") != "1700003600.000" || r.Form.Get("limit") != "1000" || r.Form.Get("ignore_pipes") != "1" {
			t.Error(r.Form)
		}
		if r.URL.Path == "/select/logsql/field_names" || r.URL.Path == "/select/logsql/stream_field_names" {
			fmt.Fprint(w, `{"values":[{"value":"level","hits":5},{"value":"_msg","hits":5}]}`)
		} else if (r.URL.Path == "/select/logsql/field_values" || r.URL.Path == "/select/logsql/stream_field_values") && r.Form.Get("field") == "level" {
			fmt.Fprint(w, `{"values":[{"value":"error","hits":5}]}`)
		} else {
			t.Error(r.URL.Path, r.Form)
		}
	}))
	defer upstream.Close()
	a := newTestApp()
	a.sources["logs"] = Source{Kind: "logs", Name: "VL", URL: upstream.URL}
	for _, kind := range []string{"fields", "values", "stream_fields", "stream_values"} {
		w := httptest.NewRecorder()
		a.handler().ServeHTTP(w, httptest.NewRequest("GET", "/api/logs/metadata?type="+kind+"&query=level:error&field=level&start=1700000000&end=1700003600", nil))
		if w.Code != 200 {
			t.Fatal(w.Code, w.Body)
		}
	}
	for _, path := range []string{"/api/logs/metadata?type=values", "/api/logs/metadata?type=anything", "/api/logs/metadata?type=fields&start=NaN"} {
		w := httptest.NewRecorder()
		a.handler().ServeHTTP(w, httptest.NewRequest("GET", path, nil))
		if w.Code != 400 {
			t.Fatal(path, w.Code)
		}
	}
	if calls != 4 {
		t.Fatal("invalid log metadata request reached upstream", calls)
	}
}
