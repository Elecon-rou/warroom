package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func testTool(name string, properties map[string]any) MCPTool {
	t := MCPTool{Name: name, InputSchema: map[string]any{"properties": properties}}
	t.Annotations.ReadOnly = true
	return t
}
func TestMCPDiscoveryBounds(t *testing.T) {
	q := LLMRequest{Kind: "metrics", Start: 1793010000.123, End: 1793013600.456}
	tool := testTool("series", map[string]any{"start": nil, "end": nil, "limit": nil, "match": nil, "tenant": nil})
	args, err := boundedMCPArgs("metrics", tool, json.RawMessage(`{"start":"1e+09","end":"2e+09","tenant":"999","limit":999999,"match":"node_filesystem_size_bytes"}`), q)
	if err != nil {
		t.Fatal(err)
	}
	if args["limit"] != float64(20) || args["tenant"] != nil {
		t.Fatal(args)
	}
	for _, key := range []string{"start", "end"} {
		value := args[key].(string)
		if _, err := time.Parse(time.RFC3339Nano, value); err != nil || strings.Contains(value, "e+") {
			t.Fatal("invalid timestamp", value)
		}
	}
	if _, err := boundedMCPArgs("metrics", tool, json.RawMessage(`{"url":"https://other.example"}`), q); err == nil {
		t.Fatal("arbitrary argument accepted")
	}
	query := testTool("query", map[string]any{"query": nil, "time": nil, "timeout": nil})
	args, err = boundedMCPArgs("metrics", query, json.RawMessage(`{"query":"up"}`), q)
	if err != nil || args["query"] != "limit_offset(5, 0, (up))" || args["timeout"] != "5s" {
		t.Fatal(args, err)
	}
	trace := testTool("traces", map[string]any{"start": nil, "end": nil, "limit": nil, "service": nil})
	args, err = boundedMCPArgs("traces", trace, json.RawMessage(`{"service":"api","limit":1000}`), q)
	if err != nil || args["start"] != int64(q.Start*1000) || args["limit"] != float64(5) {
		t.Fatal(args, err)
	}
}
func TestMCPRateLimitAndCancellation(t *testing.T) {
	c := newMCP("metrics")
	c.interval = 25 * time.Millisecond
	start := time.Now()
	for i := 0; i < 3; i++ {
		if err := c.wait(context.Background()); err != nil {
			t.Fatal(err)
		}
	}
	if time.Since(start) < 45*time.Millisecond {
		t.Fatal("RPS limit not applied")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if c.wait(ctx) == nil {
		t.Fatal("cancelled wait was accepted")
	}
}
func TestMCPSSE(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		var payload map[string]any
		_ = json.NewDecoder(r.Body).Decode(&payload)
		fmt.Fprintf(w, "event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":%.0f,\"result\":{\"ok\":true}}\n\n", payload["id"])
	}))
	defer server.Close()
	c := newMCP("metrics")
	c.endpoint = server.URL
	c.interval = 0
	result, _, err := c.rpc(context.Background(), "tools/list", map[string]any{}, "session", "2025-03-26", false)
	if err != nil || !strings.Contains(string(result), "true") {
		t.Fatal(string(result), err)
	}
}
func TestMCPToolAllowlist(t *testing.T) {
	c := newMCP("metrics")
	tool := testTool("delete_series", map[string]any{})
	if _, err := c.call(context.Background(), "metrics", tool, json.RawMessage(`{}`), LLMRequest{}); err == nil {
		t.Fatal("mutating tool allowed")
	}
	tool = testTool("query", map[string]any{})
	tool.Annotations.Destructive = true
	if _, err := c.call(context.Background(), "metrics", tool, json.RawMessage(`{}`), LLMRequest{}); err == nil {
		t.Fatal("destructive tool allowed")
	}
}
