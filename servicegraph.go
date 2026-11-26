package main

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

type GraphRequest struct {
	Start           float64 `json:"start"`
	End             float64 `json:"end"`
	Source          string  `json:"source"`
	SourceID        string  `json:"sourceId,omitempty"`
	MetricsSourceID string  `json:"metricsSourceId,omitempty"`
	TracesSourceID  string  `json:"tracesSourceId,omitempty"`
}
type GraphNode struct {
	ID   string `json:"id"`
	Kind string `json:"kind"`
}
type GraphEdge struct {
	Source         string   `json:"source"`
	Target         string   `json:"target"`
	ConnectionType string   `json:"connectionType,omitempty"`
	Calls          *float64 `json:"calls,omitempty"`
	RPS            *float64 `json:"rps,omitempty"`
	ErrorRatio     *float64 `json:"errorRatio,omitempty"`
	MeanMs         *float64 `json:"meanMs,omitempty"`
	P95Ms          *float64 `json:"p95Ms,omitempty"`
	TraceCalls     *float64 `json:"traceCalls,omitempty"`
	SampleCalls    int      `json:"sampleCalls,omitempty"`
	SampleErrors   int      `json:"sampleErrors,omitempty"`
	SampleMeanMs   *float64 `json:"sampleMeanMs,omitempty"`
	Origins        []string `json:"origins"`
}
type ServiceGraph struct {
	Nodes         []GraphNode  `json:"nodes"`
	Edges         []*GraphEdge `json:"edges"`
	Warnings      []string     `json:"warnings"`
	SampledTraces int          `json:"sampledTraces"`
	Start         float64      `json:"start"`
	End           float64      `json:"end"`
}
type graphBuilder struct {
	nodes map[string]string
	edges map[string]*GraphEdge
}

func newGraphBuilder() *graphBuilder {
	return &graphBuilder{nodes: map[string]string{}, edges: map[string]*GraphEdge{}}
}
func (g *graphBuilder) edge(source, target, origin string) *GraphEdge {
	if source == "" || target == "" || source == target {
		return nil
	}
	key := source + "\x00" + target
	e := g.edges[key]
	if e == nil {
		e = &GraphEdge{Source: source, Target: target, Origins: []string{}}
		g.edges[key] = e
	}
	g.nodes[source] = "service"
	if g.nodes[target] == "" {
		g.nodes[target] = "service"
	}
	for _, v := range e.Origins {
		if v == origin {
			return e
		}
	}
	e.Origins = append(e.Origins, origin)
	return e
}
func fp(v float64) *float64 {
	if math.IsNaN(v) || math.IsInf(v, 0) {
		return nil
	}
	return &v
}
func (a *App) serviceGraph(w http.ResponseWriter, r *http.Request) {
	var q GraphRequest
	d := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096))
	d.DisallowUnknownFields()
	if d.Decode(&q) != nil || q.Start <= 0 || q.End <= q.Start || q.End-q.Start > 31*86400 {
		fail(w, 400, "Invalid graph time range (maximum 31 days).")
		return
	}
	if q.Source == "" {
		q.Source = "combined"
	}
	if q.Source != "combined" && q.Source != "metrics" && q.Source != "traces" {
		fail(w, 400, "Invalid graph source.")
		return
	}
	selectedCtx := r.Context()
	for _, kind := range []string{"metrics", "traces"} {
		if q.Source != "combined" && q.Source != kind {
			continue
		}
		id := q.MetricsSourceID
		if kind == "traces" {
			id = q.TracesSourceID
		}
		if q.Source != "combined" && q.SourceID != "" {
			id = q.SourceID
		}
		// A missing kind can be reported as a graph warning; an explicit/ambiguous
		// selection must not silently cross datasource boundaries.
		next, _, err := a.bindSource(selectedCtx, kind, id)
		if err != nil {
			if id != "" || strings.Contains(err.Error(), "multiple") {
				fail(w, 400, err.Error())
				return
			}
		} else {
			selectedCtx = next
		}
	}
	ctx, cancel := context.WithTimeout(selectedCtx, 35*time.Second)
	defer cancel()
	g := newGraphBuilder()
	warnings := []string{}
	sampled := 0
	if q.Source != "traces" {
		for _, err := range a.graphMetrics(ctx, q, g) {
			warnings = append(warnings, err)
		}
	}
	if q.Source != "metrics" {
		count, errs := a.graphTraces(ctx, q, g)
		sampled = count
		warnings = append(warnings, errs...)
	}
	result := ServiceGraph{Nodes: []GraphNode{}, Edges: []*GraphEdge{}, Warnings: warnings, SampledTraces: sampled, Start: q.Start, End: q.End}
	keys := []string{}
	for key := range g.edges {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	if len(keys) > 250 {
		keys = keys[:250]
		result.Warnings = append(result.Warnings, "Graph limited to 250 edges; narrow the time range.")
	}
	retained := map[string]bool{}
	for _, key := range keys {
		edge := g.edges[key]
		result.Edges = append(result.Edges, edge)
		retained[edge.Source] = true
		retained[edge.Target] = true
	}
	for id, kind := range g.nodes {
		if len(keys) == 0 || retained[id] {
			result.Nodes = append(result.Nodes, GraphNode{id, kind})
		}
	}
	sort.Slice(result.Nodes, func(i, j int) bool { return result.Nodes[i].ID < result.Nodes[j].ID })
	send(w, 200, result)
}
func (a *App) graphMetrics(ctx context.Context, q GraphRequest, g *graphBuilder) []string {
	window := strconv.Itoa(int(math.Ceil(q.End-q.Start))) + "s"
	group := " by (client, server) "
	requests := "sum" + group + "(increase(traces_service_graph_request_total[" + window + "]))"
	failures := "sum" + group + "(increase(traces_service_graph_request_failed_total[" + window + "]))"
	mean := func(side string) string {
		return "1000 * sum" + group + "(increase(traces_service_graph_request_" + side + "_seconds_sum[" + window + "])) / sum" + group + "(increase(traces_service_graph_request_" + side + "_seconds_count[" + window + "]))"
	}
	queries := []string{requests, failures, mean("server") + " or " + mean("client"), "1000 * histogram_quantile(0.95, sum by (le, client, server) (increase(traces_service_graph_request_server_seconds_bucket[" + window + "])))"}
	type row struct {
		Metric map[string]string `json:"metric"`
		Value  []json.RawMessage `json:"value"`
	}
	values := make([][]row, 4)
	errs := make([]error, 4)
	var wg sync.WaitGroup
	for index, query := range queries {
		wg.Add(1)
		go func(index int, query string) {
			defer wg.Done()
			data, err := a.upstream(ctx, "metrics", "/api/v1/query", url.Values{"query": {query}, "time": {strconv.FormatFloat(q.End, 'f', 3, 64)}, "timeout": {"10s"}})
			if err != nil {
				errs[index] = err
				return
			}
			var result struct {
				Status string `json:"status"`
				Error  string `json:"error"`
				Data   struct {
					Result []row `json:"result"`
				} `json:"data"`
			}
			if json.Unmarshal(data, &result) != nil || result.Status != "success" {
				errs[index] = fmt.Errorf("metrics graph query failed: %s", result.Error)
				return
			}
			values[index] = result.Data.Result
		}(index, query)
	}
	wg.Wait()
	failuresByEdge := map[string]float64{}
	for i, rows := range values {
		for _, row := range rows {
			source, target := row.Metric["client"], row.Metric["server"]
			if len(row.Value) != 2 {
				continue
			}
			var text string
			_ = json.Unmarshal(row.Value[1], &text)
			value, err := strconv.ParseFloat(text, 64)
			if err != nil || math.IsNaN(value) || math.IsInf(value, 0) {
				continue
			}
			var e *GraphEdge
			if i == 0 {
				if value <= 0 {
					continue
				}
				e = g.edge(source, target, "metrics")
			} else {
				e = g.edges[source+"\x00"+target]
			}
			if e == nil {
				continue
			}
			switch i {
			case 0:
				e.Calls = fp(value)
				e.RPS = fp(value / (q.End - q.Start))
			case 1:
				failuresByEdge[source+"\x00"+target] = value
			case 2:
				e.MeanMs = fp(value)
			case 3:
				e.P95Ms = fp(value)
			}
		}
	}
	for key, e := range g.edges {
		if e.Calls != nil && *e.Calls > 0 && errs[1] == nil {
			e.ErrorRatio = fp(math.Min(1, failuresByEdge[key] / *e.Calls))
		}
	}
	warnings := []string{}
	for index, err := range errs {
		if err != nil {
			warnings = append(warnings, fmt.Sprintf("Metrics graph signal %d unavailable: %s", index+1, err))
		}
	}
	if len(values[0]) == 0 && errs[0] == nil {
		warnings = append(warnings, "No service-graph request metrics in this range.")
	}
	return warnings
}

type graphSpan struct {
	TraceID  string  `json:"traceID"`
	ID       string  `json:"spanID"`
	Process  string  `json:"processID"`
	Duration float64 `json:"duration"`
	Tags     []struct {
		Key   string `json:"key"`
		Value any    `json:"value"`
	} `json:"tags"`
	Refs []struct {
		Type string `json:"refType"`
		ID   string `json:"spanID"`
	} `json:"references"`
}
type graphTrace struct {
	ID        string      `json:"traceID"`
	Spans     []graphSpan `json:"spans"`
	Processes map[string]struct {
		Service string `json:"serviceName"`
	} `json:"processes"`
}

func (g *graphBuilder) sampleTrace(trace graphTrace) {
	spans := map[string]graphSpan{}
	for _, s := range trace.Spans {
		spans[s.ID] = s
		service := trace.Processes[s.Process].Service
		if service != "" {
			g.nodes[service] = "service"
		}
	}
	paired := map[string]bool{}
	add := func(source, target string, span graphSpan) {
		e := g.edge(source, target, "trace-sample")
		if e == nil {
			return
		}
		e.SampleCalls++
		total := span.Duration / 1000
		if e.SampleMeanMs != nil {
			total += *e.SampleMeanMs * float64(e.SampleCalls-1)
		}
		e.SampleMeanMs = fp(total / float64(e.SampleCalls))
		for _, tag := range span.Tags {
			v := fmt.Sprint(tag.Value)
			if tag.Key == "error" && (v == "true" || v == "1") || tag.Key == "otel.status_code" && strings.EqualFold(v, "ERROR") {
				e.SampleErrors++
				break
			}
			if tag.Key == "http.status_code" || tag.Key == "http.response.status_code" {
				code, _ := strconv.Atoi(v)
				if code >= 500 {
					e.SampleErrors++
					break
				}
			}
		}
	}
	for _, span := range trace.Spans {
		target := trace.Processes[span.Process].Service
		for _, ref := range span.Refs {
			if ref.Type != "CHILD_OF" {
				continue
			}
			parent, ok := spans[ref.ID]
			if !ok {
				continue
			}
			source := trace.Processes[parent.Process].Service
			if source != "" && target != "" && source != target {
				add(source, target, span)
				paired[parent.ID] = true
			}
		}
	}
	for _, span := range trace.Spans {
		if paired[span.ID] {
			continue
		}
		tags := map[string]string{}
		for _, tag := range span.Tags {
			tags[tag.Key] = fmt.Sprint(tag.Value)
		}
		if tags["span.kind"] != "client" && tags["span.kind"] != "producer" {
			continue
		}
		source := trace.Processes[span.Process].Service
		target := tags["peer.service"]
		db := tags["db.system.name"]
		if db == "" {
			db = tags["db.system"]
		}
		if target == "" && db != "" {
			target = db
			if name := tags["db.namespace"]; name != "" {
				target += "/" + name
			}
		}
		if target == "" {
			target = tags["server.address"]
		}
		if target == "" {
			target = tags["net.peer.name"]
		}
		if target == "" {
			target = tags["http.host"]
		}
		if target == "" {
			continue
		}
		add(source, target, span)
		if db != "" {
			g.nodes[target] = "database"
		} else if g.nodes[target] == "service" {
			g.nodes[target] = "external"
		}
	}
}
func (a *App) graphTraces(ctx context.Context, q GraphRequest, g *graphBuilder) (int, []string) {
	warnings := []string{}
	deps, err := a.upstream(ctx, "traces", "/select/jaeger/api/dependencies", url.Values{"endTs": {strconv.FormatInt(int64(q.End*1000), 10)}, "lookback": {strconv.FormatInt(int64((q.End-q.Start)*1000), 10)}})
	dependencyCount := 0
	if err == nil {
		var data struct {
			Data []struct {
				Parent string  `json:"parent"`
				Child  string  `json:"child"`
				Calls  float64 `json:"callCount"`
			} `json:"data"`
		}
		if json.Unmarshal(deps, &data) == nil {
			for _, d := range data.Data {
				if edge := g.edge(d.Parent, d.Child, "trace-dependencies"); edge != nil {
					edge.TraceCalls = fp(d.Calls)
					dependencyCount++
				}
			}
		}
	} else {
		warnings = append(warnings, "Trace dependency API unavailable; using bounded trace sampling.")
	}
	if dependencyCount > 0 {
		return 0, warnings
	}
	servicesData, err := a.upstream(ctx, "traces", "/select/jaeger/api/services", nil)
	if err != nil {
		return 0, append(warnings, "Trace service discovery unavailable: "+err.Error())
	}
	var services struct {
		Data []string `json:"data"`
	}
	if json.Unmarshal(servicesData, &services) != nil {
		return 0, append(warnings, "Invalid trace service response.")
	}
	if len(services.Data) > 12 {
		services.Data = services.Data[:12]
		warnings = append(warnings, "Trace sampling limited to 12 services.")
	}
	responses := make([][]graphTrace, len(services.Data))
	errors := make([]error, len(services.Data))
	var wg sync.WaitGroup
	slots := make(chan struct{}, 3)
	for index, service := range services.Data {
		wg.Add(1)
		go func(index int, service string) {
			defer wg.Done()
			select {
			case slots <- struct{}{}:
				defer func() { <-slots }()
			case <-ctx.Done():
				errors[index] = ctx.Err()
				return
			}
			body, err := a.upstream(ctx, "traces", "/select/jaeger/api/traces", url.Values{"service": {service}, "start": {strconv.FormatInt(int64(q.Start*1e6), 10)}, "end": {strconv.FormatInt(int64(q.End*1e6), 10)}, "limit": {"12"}})
			if err != nil {
				errors[index] = err
				return
			}
			var result struct {
				Data []graphTrace `json:"data"`
			}
			if json.Unmarshal(body, &result) != nil {
				errors[index] = fmt.Errorf("invalid trace response")
				return
			}
			responses[index] = result.Data
		}(index, service)
	}
	wg.Wait()
	// Search responses can contain the same trace, possibly with different subsets of spans.
	traces := map[string]graphTrace{}
	seen := map[string]map[string]bool{}
	for _, batch := range responses {
		for _, trace := range batch {
			if trace.ID == "" && len(trace.Spans) > 0 {
				trace.ID = trace.Spans[0].TraceID
			}
			if trace.ID == "" {
				continue
			}
			combined, exists := traces[trace.ID]
			if !exists {
				combined = graphTrace{ID: trace.ID, Processes: map[string]struct {
					Service string `json:"serviceName"`
				}{}}
				seen[trace.ID] = map[string]bool{}
			}
			for _, span := range trace.Spans {
				if !seen[trace.ID][span.ID] {
					service := trace.Processes[span.Process].Service
					span.Process = service
					combined.Processes[service] = struct {
						Service string `json:"serviceName"`
					}{service}
					combined.Spans = append(combined.Spans, span)
					seen[trace.ID][span.ID] = true
				}
			}
			traces[trace.ID] = combined
		}
	}
	for _, trace := range traces {
		g.sampleTrace(trace)
	}
	failed := 0
	for _, err := range errors {
		if err != nil {
			failed++
		}
	}
	if failed > 0 {
		warnings = append(warnings, fmt.Sprintf("Trace sampling failed for %d services.", failed))
	}
	if len(traces) > 0 {
		warnings = append(warnings, fmt.Sprintf("Trace topology uses a bounded sample of %d traces; sample calls are not total traffic.", len(traces)))
	}
	return len(traces), warnings
}
