package main

import (
	"bufio"
	"bytes"
	"context"
	"embed"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"log"
	"math"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"
)

//go:embed web/dist/*
var assets embed.FS

type App struct {
	sources     map[string]Source
	client      *http.Client
	llm         *LLM
	mcps        map[string]*MCPClient
	history     *queryHistoryStore
	sourceAuth  map[string]sourceAuth
	sourceOrder []string
}
type Query struct {
	Kind     string  `json:"kind"`
	SourceID string  `json:"sourceId,omitempty"`
	Query    string  `json:"query"`
	Start    float64 `json:"start"`
	End      float64 `json:"end"`
	Step     float64 `json:"step"`
	Limit    int     `json:"limit"`
	Demo     bool    `json:"demo"`
	TraceID  string  `json:"traceId"`
}

func env(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
func newApp() *App {
	return newAppWithLLM(newLLM(newClaude(), nil))
}

// Accept the shared LLM service so deployments and tests can inject any provider.
func newAppWithLLM(llm *LLM) *App {
	return &App{history: newQueryHistoryStore(), llm: llm, sources: map[string]Source{}, mcps: map[string]*MCPClient{}, sourceAuth: map[string]sourceAuth{}, client: &http.Client{Timeout: 30 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}
}
func send(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
func fail(w http.ResponseWriter, status int, msg string) {
	send(w, status, map[string]string{"error": msg})
}
func (a *App) handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/health", func(w http.ResponseWriter, r *http.Request) { send(w, 200, map[string]string{"status": "ok"}) })
	mux.HandleFunc("GET /api/sources", func(w http.ResponseWriter, r *http.Request) {
		send(w, 200, a.sourceList())
	})
	mux.HandleFunc("GET /api/history", a.queryHistory)
	mux.HandleFunc("POST /api/history", a.queryHistory)
	mux.HandleFunc("DELETE /api/history", a.queryHistory)
	mux.HandleFunc("POST /api/query", a.query)
	mux.HandleFunc("POST /api/service-graph", a.serviceGraph)
	mux.HandleFunc("POST /api/investigate", a.investigate)
	mux.HandleFunc("POST /api/investigate/export", a.exportInvestigation)
	mux.HandleFunc("GET /api/dashboards", a.provisionedDashboards)
	mux.HandleFunc("POST /api/dashboards/variables/options", a.dashboardVariableOptions)
	mux.HandleFunc("POST /api/dashboards/generate", a.generateDashboard)
	mux.HandleFunc("POST /api/llm/generate", a.generate)
	mux.HandleFunc("GET /api/llm/usage", a.tokenUsage)
	mux.HandleFunc("GET /api/llm/config", func(w http.ResponseWriter, r *http.Request) {
		send(w, 200, a.llm.Info())
	})
	mux.HandleFunc("GET /api/services", a.metadataSource("traces", a.services))
	mux.HandleFunc("GET /api/operations", a.metadataSource("traces", a.operations))
	mux.HandleFunc("GET /api/metrics/metadata", a.metadataSource("metrics", a.metricMetadata))
	mux.HandleFunc("GET /api/logs/metadata", a.metadataSource("logs", a.logMetadata))
	mux.HandleFunc("/api/", func(w http.ResponseWriter, r *http.Request) { fail(w, 404, "API route not found") })
	ui, _ := fs.Sub(assets, "web/dist")
	mux.Handle("/", http.FileServer(http.FS(ui)))
	scoped := a.tokenBudgetMiddleware(mux)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		scoped.ServeHTTP(w, r)
	})
}
func (a *App) upstream(ctx context.Context, kind, path string, v url.Values) ([]byte, error) {
	s, err := a.resolveSource(ctx, kind, "")
	if err != nil {
		return nil, err
	}
	u, err := url.Parse(strings.TrimRight(s.URL, "/") + path)
	if err != nil {
		return nil, err
	}
	var req *http.Request
	if kind == "traces" {
		u.RawQuery = v.Encode()
		req, err = http.NewRequestWithContext(ctx, "GET", u.String(), nil)
	} else {
		req, err = http.NewRequestWithContext(ctx, "POST", u.String(), strings.NewReader(v.Encode()))
	}
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")
	if err := applySourceAuth(req, a.sourceAuth[s.ID]); err != nil {
		return nil, err
	}
	resp, err := a.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("%s request failed: %w", s.Name, err)
	}
	defer resp.Body.Close()
	const max = 16 << 20
	body, err := io.ReadAll(io.LimitReader(resp.Body, max+1))
	if err != nil {
		return nil, err
	}
	if len(body) > max {
		return nil, fmt.Errorf("response exceeds 16 MiB; narrow the time range or query")
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		msg := string(body)
		if len(msg) > 1200 {
			msg = msg[:1200]
		}
		return nil, fmt.Errorf("%s returned HTTP %d: %s", s.Name, resp.StatusCode, msg)
	}
	return body, nil
}
func (a *App) services(w http.ResponseWriter, r *http.Request) {
	b, err := a.upstream(r.Context(), "traces", "/select/jaeger/api/services", nil)
	if err != nil {
		fail(w, 502, err.Error())
		return
	}
	var v any
	if json.Unmarshal(b, &v) != nil {
		fail(w, 502, "invalid Jaeger services response")
		return
	}
	send(w, 200, v)
}
func (a *App) query(w http.ResponseWriter, r *http.Request) {
	var q Query
	d := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10))
	d.DisallowUnknownFields()
	if err := d.Decode(&q); err != nil {
		fail(w, 400, "invalid query request: "+err.Error())
		return
	}
	ctx, _, sourceErr := a.bindSource(r.Context(), q.Kind, q.SourceID)
	if sourceErr != nil {
		fail(w, 400, sourceErr.Error())
		return
	}
	r = r.WithContext(ctx)
	if q.End <= q.Start || q.Start <= 0 || q.End-q.Start > 31*86400 {
		fail(w, 400, "choose a valid time range of at most 31 days")
		return
	}
	if strings.TrimSpace(q.Query) == "" && q.TraceID == "" {
		fail(w, 400, "query is required")
		return
	}
	if q.Limit == 0 {
		q.Limit = 100
	}
	if q.Limit < 1 || q.Limit > 1000 {
		fail(w, 400, "limit must be between 1 and 1000")
		return
	}
	if q.Step == 0 {
		q.Step = math.Max(1, math.Ceil((q.End-q.Start)/240))
	}
	if q.Step < 1 || (q.End-q.Start)/q.Step > 11000 {
		fail(w, 400, "step must be at least 1 second and return at most 11000 points per series")
		return
	}
	started := time.Now()
	var data any
	if q.Demo {
		data = demo(q)
	} else {
		v := url.Values{"start": {strconv.FormatFloat(q.Start, 'f', 3, 64)}, "end": {strconv.FormatFloat(q.End, 'f', 3, 64)}}
		var path string
		switch q.Kind {
		case "metrics":
			path = "/api/v1/query_range"
			v.Set("query", q.Query)
			v.Set("step", strconv.FormatFloat(q.Step, 'f', 0, 64))
		case "logs":
			path = "/select/logsql/query"
			v.Set("query", q.Query)
			v.Set("limit", strconv.Itoa(q.Limit))
		case "traces":
			path = "/select/jaeger/api/traces"
			if q.TraceID != "" {
				if len(q.TraceID) != 16 && len(q.TraceID) != 32 {
					fail(w, 400, "trace ID must be 16 or 32 hexadecimal characters")
					return
				}
				for _, c := range q.TraceID {
					if !strings.ContainsRune("0123456789abcdefABCDEF", c) {
						fail(w, 400, "invalid trace ID")
						return
					}
				}
				path += "/" + q.TraceID
			} else {
				search, err := url.ParseQuery(strings.TrimSpace(q.Query))
				if err != nil {
					fail(w, 400, "invalid Jaeger query parameters")
					return
				}
				allowed := map[string]bool{"service": true, "operation": true, "tags": true, "minDuration": true, "maxDuration": true}
				for k, values := range search {
					if !allowed[k] {
						fail(w, 400, "unsupported Jaeger parameter: "+k)
						return
					}
					v[k] = values
				}
				if v.Get("service") == "" {
					fail(w, 400, "Jaeger search requires service, for example service=aloha-cloud")
					return
				}
				if tags := v.Get("tags"); tags != "" {
					var t map[string]string
					if json.Unmarshal([]byte(tags), &t) != nil {
						fail(w, 400, "tags must be a JSON object of string values")
						return
					}
				}
			}
			v.Set("start", strconv.FormatInt(int64(q.Start*1e6), 10))
			v.Set("end", strconv.FormatInt(int64(q.End*1e6), 10))
			v.Set("limit", strconv.Itoa(q.Limit))
		}
		b, err := a.upstream(r.Context(), q.Kind, path, v)
		if err != nil {
			fail(w, 502, err.Error())
			return
		}
		if q.Kind == "logs" {
			rows := []map[string]any{}
			scanner := bufio.NewScanner(bytes.NewReader(b))
			scanner.Buffer(make([]byte, 4096), 16<<20)
			for scanner.Scan() {
				if len(bytes.TrimSpace(scanner.Bytes())) == 0 {
					continue
				}
				var row map[string]any
				if err := json.Unmarshal(scanner.Bytes(), &row); err != nil {
					fail(w, 502, "invalid VictoriaLogs JSON line")
					return
				}
				rows = append(rows, row)
			}
			if scanner.Err() != nil {
				fail(w, 502, scanner.Err().Error())
				return
			}
			data = rows
		} else {
			var obj map[string]any
			if json.Unmarshal(b, &obj) != nil {
				fail(w, 502, "upstream returned invalid JSON")
				return
			}
			if obj["status"] == "error" {
				fail(w, 422, fmt.Sprint(obj["error"]))
				return
			}
			if errs, ok := obj["errors"].([]any); ok && len(errs) > 0 {
				fail(w, 502, fmt.Sprint(errs))
				return
			}
			data = obj
		}
	}
	send(w, 200, map[string]any{"data": data, "elapsedMs": time.Since(started).Milliseconds(), "demo": q.Demo, "step": q.Step, "start": q.Start, "end": q.End})
}
func demo(q Query) any {
	switch q.Kind {
	case "metrics":
		series := []any{}
		for i, name := range []string{"cloud-api", "eventlog", "ingestor"} {
			values := []any{}
			for j := 0; j <= 120; j++ {
				t := q.Start + (q.End-q.Start)*float64(j)/120
				value := 80 + float64(i)*38 + math.Sin(float64(j)*0.14+float64(i))*23 + math.Cos(float64(j)*0.71)*4
				values = append(values, []any{t, strconv.FormatFloat(value, 'f', 2, 64)})
			}
			series = append(series, map[string]any{"metric": map[string]string{"service": name, "environment": "demo"}, "values": values})
		}
		return map[string]any{"status": "success", "data": map[string]any{"resultType": "matrix", "result": series}}
	case "logs":
		rows := []any{}
		for i := 0; i < min(q.Limit, 48); i++ {
			level := []string{"info", "info", "debug", "warn", "error"}[i%5]
			rows = append(rows, map[string]any{"_time": time.UnixMilli(int64((q.End - float64(i)*((q.End-q.Start)/48)) * 1000)).UTC().Format(time.RFC3339Nano), "_msg": []string{"Request completed successfully", "Connected to upstream service", "Executing database query", "Retrying request after timeout", "Upstream request failed: connection reset"}[i%5], "level": level, "service": "cloud-api", "namespace": "production", "duration_ms": 12 + i*7})
		}
		return rows
	default:
		traces := []any{}
		for i := 0; i < min(q.Limit, 12); i++ {
			id := fmt.Sprintf("%032x", i+1)
			start := int64((q.End - float64(i)*25) * 1e6)
			spans := []any{}
			for j, op := range []string{"GET /api/subscriptions", "authenticate", "subscription.Lookup", "SELECT subscriptions", "http.response"} {
				parent := []any{}
				if j > 0 {
					parent = append(parent, map[string]any{"refType": "CHILD_OF", "spanID": "root"})
				}
				duration := int64(12000 + (4-j)*8000 + i*1500)
				if j == 0 {
					duration = 100000 + int64(i)*15000
				}
				spanID := fmt.Sprint(j)
				if j == 0 {
					spanID = "root"
				}
				spans = append(spans, map[string]any{"traceID": id, "spanID": spanID, "operationName": op, "processID": "p1", "startTime": start + int64(j)*12000, "duration": duration, "references": parent, "tags": []any{map[string]any{"key": "http.status_code", "value": "200"}}})
			}
			traces = append(traces, map[string]any{"traceID": id, "spans": spans, "processes": map[string]any{"p1": map[string]any{"serviceName": "cloud-api"}}})
		}
		return map[string]any{"data": traces}
	}
}
func main() {
	llm, err := configuredLLM()
	if err != nil {
		log.Fatal(err)
	}
	app := newAppWithLLM(llm)
	configs, err := loadDataSources()
	if err != nil {
		log.Fatal(err)
	}
	app.configureDataSources(configs)
	server := &http.Server{Addr: env("LISTEN_ADDR", "127.0.0.1:8080"), Handler: app.handler(), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 15 * time.Second, WriteTimeout: investigationTimeout + 30*time.Second, IdleTimeout: 60 * time.Second}
	done := make(chan os.Signal, 1)
	signal.Notify(done, os.Interrupt, syscall.SIGTERM)
	go func() {
		<-done
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = server.Shutdown(ctx)
	}()
	log.Printf("Warroom listening on http://%s", server.Addr)
	if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatal(err)
	}
}
