package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http/httptest"
	"strings"
	"testing"
)

type fakeLLMProvider struct {
	complete func(context.Context, CompletionRequest) (CompletionResponse, error)
	count    func(context.Context, CompletionRequest) (int64, error)
}

func (p *fakeLLMProvider) Info() LLMInfo {
	return LLMInfo{Provider: "fake", Model: "fake-model", Configured: true}
}
func (p *fakeLLMProvider) Complete(ctx context.Context, q CompletionRequest) (CompletionResponse, error) {
	return p.complete(ctx, q)
}
func (p *fakeLLMProvider) CountTokens(ctx context.Context, q CompletionRequest) (int64, error) {
	if p.count != nil {
		return p.count(ctx, q)
	}
	return 100, nil
}
func llmText(text string) CompletionResponse {
	return CompletionResponse{StopReason: "end_turn", Content: []LLMContent{{Type: "text", Text: text}}, Usage: &TokenUsage{Input: 100, Output: 10}}
}

func TestProviderIndependentSemanticGates(t *testing.T) {
	for _, test := range []struct {
		path, body string
		status     int
	}{
		{"/api/llm/generate", `{"kind":"metrics","prompt":"CPU","start":1700000000,"end":1700003600}`, 422},
		{"/api/investigate", `{"messages":[{"role":"user","content":"CPU"}],"start":1700000000,"end":1700003600}`, 422},
		{"/api/investigate/export", `{"type":"dashboard","messages":[{"role":"user","content":"CPU"}],"start":1700000000,"end":1700003600}`, 422},
		{"/api/dashboards/generate", `{"prompt":"CPU","start":1700000000,"end":1700003600}`, 422},
	} {
		t.Run(test.path, func(t *testing.T) {
			calls := 0
			p := &fakeLLMProvider{complete: func(_ context.Context, q CompletionRequest) (CompletionResponse, error) {
				calls++
				if q.Task != TaskFilter || q.System == "" || len(q.Messages) == 0 {
					t.Fatal("untyped or missing filter request", q)
				}
				if q.Schema != nil {
					return llmText(`{"verdict":"FAIL"}`), nil
				}
				return llmText("FAIL"), nil
			}}
			a := newTestApp()
			a.llm = newLLM(p, nil)
			w := httptest.NewRecorder()
			a.handler().ServeHTTP(w, httptest.NewRequest("POST", test.path, strings.NewReader(test.body)))
			if w.Code != test.status || calls != 1 {
				t.Fatalf("%d %s (%d provider calls)", w.Code, w.Body, calls)
			}
			if len(a.llm.slots) != 0 {
				t.Fatal("generation slot leaked")
			}
		})
	}
}

func TestProviderIndependentToolHistory(t *testing.T) {
	// A full investigation can call an internal skill and replay its result without
	// an Anthropic client, wire response, or API key.
	calls := 0
	state := &struct{ opaque string }{"provider-private-continuation"}
	p := &fakeLLMProvider{complete: func(_ context.Context, q CompletionRequest) (CompletionResponse, error) {
		calls++
		if q.Task != TaskInvestigation || len(q.Tools) == 0 {
			t.Fatal("missing tools", q)
		}
		if calls == 1 {
			return CompletionResponse{StopReason: "tool_use", Content: []LLMContent{
				{Type: "opaque", State: state},
				{Type: "tool_use", ID: "skill-1", Name: "read_skill", Input: json.RawMessage(`{"name":"infrastructure"}`)},
			}}, nil
		}
		assistant, user := q.Messages[len(q.Messages)-2], q.Messages[len(q.Messages)-1]
		if assistant.Content[0].State != state || user.Content[0].ToolID != "skill-1" || user.Content[0].IsError {
			t.Fatal("tool continuation lost", q.Messages)
		}
		return llmText("No telemetry source was available; CPU health is unverified."), nil
	}}
	a := newApp()
	a.llm = newLLM(p, nil)
	result, err := a.runInvestigation(context.Background(), InvestigationRequest{Start: 1700000000, End: 1700003600, Messages: []InvestigationMessage{{Role: "user", Content: "Investigate CPU"}}})
	if err != nil || calls != 2 || result.Message == "" {
		t.Fatal(result, err, calls)
	}
}

func TestProviderIndependentRetriesAndBudget(t *testing.T) {
	counts, calls, sinks := 0, 0, 0
	p := &fakeLLMProvider{
		count: func(_ context.Context, q CompletionRequest) (int64, error) { counts++; return 100, nil },
		complete: func(_ context.Context, q CompletionRequest) (CompletionResponse, error) {
			calls++
			if !q.Stream || q.Effort == "" {
				t.Fatal("missing normalized stream/reasoning settings")
			}
			want := 16384
			if calls == 2 {
				want = 32768
			}
			if q.MaxTokens != want {
				t.Fatal(q.MaxTokens, want)
			}
			sink := q.NewTextSink()
			sink("draft")
			response := llmText("done")
			if calls == 1 {
				response.StopReason = "max_tokens"
			}
			return response, nil
		},
	}
	l := newLLM(p, newTokenBudget())
	response, err := l.Complete(context.Background(), CompletionRequest{Task: TaskDashboard, NewTextSink: func() func(string) { sinks++; return func(string) {} }})
	if err != nil || response.text() != "done" || counts != 2 || calls != 2 || sinks != 2 {
		t.Fatal(response, err, counts, calls, sinks)
	}
	if l.budget.global.used != 220 || l.budget.global.held != 0 {
		t.Fatal(l.budget.global)
	}
	p.count = func(context.Context, CompletionRequest) (int64, error) { return 0, errors.New("count unavailable") }
	if _, err = l.Complete(context.Background(), CompletionRequest{Task: TaskQuery, MaxTokens: 100}); err == nil || calls != 2 {
		t.Fatal("preflight failed open", err, calls)
	}
}

func TestProviderMetadataAndConfiguration(t *testing.T) {
	a := newApp()
	a.llm = newLLM(&fakeLLMProvider{}, nil)
	w := httptest.NewRecorder()
	a.handler().ServeHTTP(w, httptest.NewRequest("GET", "/api/llm/config", nil))
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"provider":"fake"`) || !strings.Contains(w.Body.String(), `"model":"fake-model"`) {
		t.Fatal(w.Body)
	}
	t.Setenv("LLM_PROVIDER", "unknown")
	if _, err := configuredLLM(); err == nil {
		t.Fatal("unknown provider silently fell back")
	}
}

func TestClaudeAdapterTranslatesNeutralContent(t *testing.T) {
	c := newClaude()
	c.key = "test-key"
	response := c.normalized(ClaudeResponse{Content: []ClaudeBlock{{Type: "text", Text: "hidden test-key"}}})
	if strings.Contains(response.text(), "test-key") {
		t.Fatal("credential was not redacted")
	}
	request := CompletionRequest{Task: TaskFilter, MaxTokens: 128, Schema: investigationSchema(map[string]any{"verdict": map[string]string{"type": "string"}}, "verdict"), Messages: []LLMMessage{
		contentMessage("user", []LLMContent{{Type: "image", Image: &LLMImage{MediaType: "image/png", Data: "encoded-image"}}, toolResult("tool-1", "sample", false)}),
	}}
	payload, err := c.payload(request)
	encoded, _ := json.Marshal(payload)
	if err != nil || payload["model"] != c.filterModel || !strings.Contains(string(encoded), `"tool_use_id":"tool-1"`) || !strings.Contains(string(encoded), `"media_type":"image/png"`) || !strings.Contains(string(encoded), "output_config") {
		t.Fatal(payload, err)
	}
}
