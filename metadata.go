package main

import (
	"encoding/json"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

var metricIdentifier = regexp.MustCompile(`^[a-zA-Z_:][a-zA-Z0-9_:]*$`)
var labelIdentifier = regexp.MustCompile(`^[a-zA-Z_][a-zA-Z0-9_]*$`)

func (a *App) metricMetadata(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	kind, metric, label, search := q.Get("type"), q.Get("metric"), q.Get("label"), q.Get("search")
	if len(search) > 200 || len(metric) > 1000 || len(label) > 200 {
		fail(w, 400, "Metadata search is too long.")
		return
	}
	if kind != "metrics" && kind != "labels" && kind != "values" {
		fail(w, 400, "Invalid metadata type.")
		return
	}
	if kind != "metrics" && !metricIdentifier.MatchString(metric) {
		fail(w, 400, "A valid metric is required.")
		return
	}
	if kind == "values" && !labelIdentifier.MatchString(label) {
		fail(w, 400, "A valid label is required.")
		return
	}
	end := float64(time.Now().Unix())
	start := end - 3600
	var err error
	if q.Has("start") {
		start, err = strconv.ParseFloat(q.Get("start"), 64)
		if err != nil {
			fail(w, 400, "Invalid metadata time range.")
			return
		}
	}
	if q.Has("end") {
		end, err = strconv.ParseFloat(q.Get("end"), 64)
		if err != nil {
			fail(w, 400, "Invalid metadata time range.")
			return
		}
	}
	if !(start > 0 && end > start && end-start <= 31*86400) {
		fail(w, 400, "Invalid metadata time range.")
		return
	}
	params := url.Values{"start": {strconv.FormatFloat(start, 'f', 3, 64)}, "end": {strconv.FormatFloat(end, 'f', 3, 64)}, "limit": {"1000"}}
	path := "/api/v1/label/__name__/values"
	if kind == "metrics" {
		if search != "" {
			params.Set("match[]", `{__name__=~`+strconv.Quote(".*"+regexp.QuoteMeta(search)+".*")+`}`)
		}
	} else {
		params.Set("match[]", metric)
		path = "/api/v1/labels"
		if kind == "values" {
			path = "/api/v1/label/" + label + "/values"
		}
	}
	b, err := a.upstream(r.Context(), "metrics", path, params)
	if err != nil {
		fail(w, 502, err.Error())
		return
	}
	var response struct {
		Status string   `json:"status"`
		Data   []string `json:"data"`
		Error  string   `json:"error"`
	}
	if json.Unmarshal(b, &response) != nil || response.Status != "success" {
		fail(w, 502, "Invalid metrics metadata response.")
		return
	}
	values := response.Data
	if kind != "metrics" && search != "" {
		values = nil
		for _, value := range response.Data {
			if strings.Contains(strings.ToLower(value), strings.ToLower(search)) {
				values = append(values, value)
			}
		}
	}
	sort.Strings(values)
	truncated := len(values) >= 1000
	if len(values) > 1000 {
		values = values[:1000]
	}
	if values == nil {
		values = []string{}
	}
	send(w, 200, map[string]any{"data": values, "truncated": truncated})
}

func (a *App) operations(w http.ResponseWriter, r *http.Request) {
	service := r.URL.Query().Get("service")
	if service == "" || len(service) > 1000 {
		fail(w, 400, "A service is required.")
		return
	}
	b, err := a.upstream(r.Context(), "traces", "/select/jaeger/api/services/"+url.PathEscape(service)+"/operations", nil)
	if err != nil {
		fail(w, 502, err.Error())
		return
	}
	var response struct {
		Data   []json.RawMessage `json:"data"`
		Errors json.RawMessage   `json:"errors"`
	}
	if json.Unmarshal(b, &response) != nil || (len(response.Errors) > 0 && string(response.Errors) != "null" && string(response.Errors) != "[]") {
		fail(w, 502, "Invalid Jaeger operations response.")
		return
	}
	names := []string{}
	seen := map[string]bool{}
	for _, raw := range response.Data {
		var name string
		if json.Unmarshal(raw, &name) != nil {
			var operation struct {
				Name string `json:"name"`
			}
			if json.Unmarshal(raw, &operation) != nil {
				fail(w, 502, "Invalid Jaeger operation.")
				return
			}
			name = operation.Name
		}
		if name != "" && !seen[name] {
			seen[name] = true
			names = append(names, name)
		}
	}
	sort.Strings(names)
	truncated := len(names) > 1000
	if truncated {
		names = names[:1000]
	}
	send(w, 200, map[string]any{"data": names, "truncated": truncated})
}

func (a *App) logMetadata(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	kind, query, field := q.Get("type"), q.Get("query"), q.Get("field")
	if (kind != "fields" && kind != "values" && kind != "stream_fields" && kind != "stream_values") || len(query) > 16000 || len(field) > 1000 || ((kind == "values" || kind == "stream_values") && field == "") {
		fail(w, 400, "Invalid log metadata request.")
		return
	}
	if strings.TrimSpace(query) == "" {
		query = "*"
	}
	end := float64(time.Now().Unix())
	start := end - 3600
	var err error
	if q.Has("start") {
		start, err = strconv.ParseFloat(q.Get("start"), 64)
		if err != nil {
			fail(w, 400, "Invalid metadata time range.")
			return
		}
	}
	if q.Has("end") {
		end, err = strconv.ParseFloat(q.Get("end"), 64)
		if err != nil {
			fail(w, 400, "Invalid metadata time range.")
			return
		}
	}
	if !(start > 0 && end > start && end-start <= 31*86400) {
		fail(w, 400, "Invalid metadata time range.")
		return
	}
	params := url.Values{"query": {query}, "start": {strconv.FormatFloat(start, 'f', 3, 64)}, "end": {strconv.FormatFloat(end, 'f', 3, 64)}, "limit": {"1000"}, "ignore_pipes": {"1"}}
	path := "/select/logsql/field_names"
	if kind == "stream_fields" {
		path = "/select/logsql/stream_field_names"
	}
	if kind == "stream_values" {
		path = "/select/logsql/stream_field_values"
		params.Set("field", field)
	}
	if kind == "values" {
		path = "/select/logsql/field_values"
		params.Set("field", field)
	}
	b, err := a.upstream(r.Context(), "logs", path, params)
	if err != nil {
		fail(w, 502, err.Error())
		return
	}
	var response struct {
		Values []struct {
			Value string `json:"value"`
		} `json:"values"`
	}
	if json.Unmarshal(b, &response) != nil || response.Values == nil {
		fail(w, 502, "Invalid log metadata response.")
		return
	}
	values := make([]string, 0, len(response.Values))
	for _, value := range response.Values {
		values = append(values, value.Value)
	}
	sort.Strings(values)
	truncated := len(values) >= 1000
	if len(values) > 1000 {
		values = values[:1000]
	}
	send(w, 200, map[string]any{"data": values, "truncated": truncated})
}
