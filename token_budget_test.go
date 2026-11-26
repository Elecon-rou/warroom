package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestTokenBudgetConcurrentReservationAndRefund(t *testing.T) {
	b := newTokenBudget()
	b.globalLimit = 100
	b.chatLimit = 70
	var wg sync.WaitGroup
	var mu sync.Mutex
	reservations := []*tokenReservation{}
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			ticket, err := b.reserve("chat-a", 20)
			if err == nil {
				mu.Lock()
				reservations = append(reservations, ticket)
				mu.Unlock()
			}
		}()
	}
	wg.Wait()
	if len(reservations) != 3 || b.global.held != 60 || b.chats["chat-a"].held != 60 {
		t.Fatal(len(reservations), b.global)
	}
	reservations[0].finish(5)
	reservations[0].finish(1000)
	next, err := b.reserve("chat-a", 20)
	if err != nil {
		t.Fatal(err)
	}
	for _, ticket := range reservations[1:] {
		ticket.finish(10)
	}
	next.finish(10)
	if b.global.used != 35 || b.global.held != 0 || b.chats["chat-a"].used != 35 {
		t.Fatal(b.global, b.chats)
	}
	if _, err := b.reserve("chat-b", 66); err == nil {
		t.Fatal("global cap bypassed by another chat")
	}
}
func TestTokenBudgetRollingWindowsAndInflight(t *testing.T) {
	now := time.Unix(1700000000, 0)
	b := newTokenBudget()
	b.now = func() time.Time { return now }
	b.globalLimit = 100
	b.chatLimit = 60
	b.chatWindow = 10 * time.Minute
	first, _ := b.reserve("a", 50)
	first.finish(50)
	if _, err := b.reserve("a", 11); err == nil {
		t.Fatal("chat cap not enforced")
	}
	now = now.Add(11 * time.Minute)
	next, err := b.reserve("a", 50)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := b.reserve("b", 1); err == nil {
		t.Fatal("old global usage discarded early")
	}
	now = now.Add(time.Hour)
	if _, err := b.reserve("b", 51); err == nil {
		t.Fatal("inflight reservation expired before settlement")
	}
	next.finish(20)
	ticket, err := b.reserve("", 80)
	if err != nil {
		t.Fatal(err)
	}
	ticket.finish(0)
	if b.global.held != 0 {
		t.Fatal("reservation leaked")
	}
}
func TestTokenBudgetSettingsFallback(t *testing.T) {
	t.Setenv("LLM_GLOBAL_TOKEN_LIMIT", "-1")
	t.Setenv("LLM_CHAT_TOKEN_LIMIT", "bad")
	t.Setenv("LLM_GLOBAL_TOKEN_WINDOW", "2s")
	t.Setenv("LLM_CHAT_TOKEN_WINDOW", "-2h")
	b := newTokenBudget()
	if b.globalLimit != 2_000_000 || b.chatLimit != 300_000 || b.globalWindow != time.Hour || b.chatWindow != time.Hour {
		t.Fatal(b)
	}
	t.Setenv("LLM_GLOBAL_TOKEN_LIMIT", "4000")
	t.Setenv("LLM_CHAT_TOKEN_WINDOW", "15m")
	b = newTokenBudget()
	if b.globalLimit != 4000 || b.chatWindow != 15*time.Minute {
		t.Fatal(b)
	}
}
func budgetPayload() CompletionRequest {
	return CompletionRequest{Task: TaskQuery, MaxTokens: 200, Messages: []LLMMessage{textMessage("user", "hi")}}
}
func budgetClient(server *httptest.Server) *LLM {
	c := newClaude()
	c.endpoint = server.URL + "/messages"
	c.key = "test"
	return newLLM(c, newTokenBudget())
}
func budgetStream(c *LLM, ctx context.Context) (CompletionResponse, error) {
	request := budgetPayload()
	request.Stream = true
	return c.Complete(ctx, request)
}

func TestCompletionBudgetsUseProviderUsageIncludingCaches(t *testing.T) {
	countCalls, modelCalls := 0, 0
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/count_tokens") {
			countCalls++
			var p map[string]any
			json.NewDecoder(r.Body).Decode(&p)
			if p["max_tokens"] != nil || p["messages"] == nil {
				t.Error("invalid count payload")
			}
			send(w, 200, map[string]int{"input_tokens": 100})
			return
		}
		modelCalls++
		send(w, 200, map[string]any{"stop_reason": "end_turn", "content": []any{map[string]string{"type": "text", "text": "PASS"}}, "usage": map[string]int{"input_tokens": 100, "output_tokens": 50, "cache_read_input_tokens": 100, "cache_creation_input_tokens": 20}})
	}))
	defer s.Close()
	c := budgetClient(s)
	ctx := context.WithValue(context.Background(), tokenScopeKey{}, "a")
	if _, err := c.Complete(ctx, budgetPayload()); err != nil {
		t.Fatal(err)
	}
	clone := *c
	if _, err := clone.Complete(ctx, budgetPayload()); err != nil {
		t.Fatal(err)
	}
	if countCalls != 2 || modelCalls != 2 || c.budget.global.used != 540 || c.budget.global.held != 0 || c.budget.chats["a"].used != 540 {
		t.Fatal(countCalls, modelCalls, c.budget.global)
	}
}
func TestStreamUsageIsCumulativeAndSharedWithNonstream(t *testing.T) {
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/count_tokens") {
			send(w, 200, map[string]int{"input_tokens": 100})
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, `data: {"type":"message_start","message":{"usage":{"input_tokens":100,"output_tokens":1,"cache_read_input_tokens":10,"cache_creation_input_tokens":20}}}`+"\n\n")
		fmt.Fprint(w, `data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":"PASS"}}`+"\n\n")
		fmt.Fprint(w, `data: {"type":"content_block_stop","index":0}`+"\n\n")
		fmt.Fprint(w, `data: {"type":"message_delta","delta":{},"usage":{"output_tokens":20}}`+"\n\n")
		fmt.Fprint(w, `data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":40}}`+"\n\n")
		fmt.Fprint(w, `data: {"type":"message_stop"}`+"\n\n")
	}))
	defer s.Close()
	c := budgetClient(s)
	if _, err := budgetStream(c, context.Background()); err != nil {
		t.Fatal(err)
	}
	if c.budget.global.used != 170 || c.budget.global.held != 0 {
		t.Fatal(c.budget.global)
	}
}
func TestUnknownOrCancelledUsageKeepsReservationAndKnownRejectionRefunds(t *testing.T) {
	for _, status := range []int{200, 400, 500} {
		t.Run(fmt.Sprint(status), func(t *testing.T) {
			s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if strings.HasSuffix(r.URL.Path, "/count_tokens") {
					send(w, 200, map[string]int{"input_tokens": 100})
					return
				}
				if status == 200 {
					claudeReply(w, "PASS")
				} else {
					send(w, status, map[string]any{"error": map[string]string{"message": "error"}})
				}
			}))
			defer s.Close()
			c := budgetClient(s)
			c.Complete(context.Background(), budgetPayload())
			expected := int64(1324)
			if status == 400 {
				expected = 0
			}
			if c.budget.global.used != expected || c.budget.global.held != 0 {
				t.Fatal(c.budget.global, expected)
			}
		})
	}
	entered := make(chan struct{})
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/count_tokens") {
			send(w, 200, map[string]int{"input_tokens": 100})
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, `data: {"type":"message_start","message":{"usage":{"input_tokens":100,"output_tokens":1}}}`+"\n\n")
		w.(http.Flusher).Flush()
		close(entered)
		<-r.Context().Done()
	}))
	defer s.Close()
	c := budgetClient(s)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { _, err := budgetStream(c, ctx); done <- err }()
	<-entered
	cancel()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("partial stream accepted")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("cancel hung")
	}
	if c.budget.global.used != 1324 || c.budget.global.held != 0 {
		t.Fatal(c.budget.global)
	}
}
func TestTokenPreflightFailureNeverGenerates(t *testing.T) {
	models := 0
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/count_tokens") {
			w.WriteHeader(503)
			return
		}
		models++
	}))
	defer s.Close()
	c := budgetClient(s)
	if _, err := c.Complete(context.Background(), budgetPayload()); err == nil {
		t.Fatal("preflight failed open")
	}
	if models != 0 || c.budget.global.used != 0 || c.budget.global.held != 0 {
		t.Fatal(models, c.budget.global)
	}
}
func TestChatAndExportLimitsReturn429AndShareGlobalBudget(t *testing.T) {
	var models atomic.Int32
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/count_tokens") {
			send(w, 200, map[string]int{"input_tokens": 100})
			return
		}
		models.Add(1)
		var p map[string]any
		json.NewDecoder(r.Body).Decode(&p)
		text := "FAIL"
		if p["system"] == prompt("investigate-export-filter") {
			text = `{"verdict":"FAIL"}`
		}
		send(w, 200, map[string]any{"stop_reason": "end_turn", "content": []any{map[string]string{"type": "text", "text": text}}, "usage": map[string]int{"input_tokens": 888, "output_tokens": 12}})
	}))
	defer s.Close()
	a := newTestApp()
	a.llm = budgetClient(s)
	a.llm.budget.globalLimit = 2900
	a.llm.budget.chatLimit = 2000
	request := func(path, chat string, cookie *http.Cookie, stream bool) *httptest.ResponseRecorder {
		body := map[string]any{"messages": []any{map[string]string{"role": "user", "content": "write a poem"}}, "chatId": chat, "start": 1700000000, "end": 1700003600}
		if path == "/api/investigate/export" {
			body["type"] = "vmalert"
		}
		b, _ := json.Marshal(body)
		r := httptest.NewRequest("POST", path, strings.NewReader(string(b)))
		if cookie != nil {
			r.AddCookie(cookie)
		}
		if stream {
			r.Header.Set("Accept", "application/x-ndjson")
		}
		w := httptest.NewRecorder()
		a.handler().ServeHTTP(w, r)
		return w
	}
	first := request("/api/investigate", "chat-a", nil, false)
	if first.Code != 422 {
		t.Fatal(first.Code, first.Body)
	}
	cookie := first.Result().Cookies()[0]
	limited := request("/api/investigate", "chat-a", cookie, false)
	if limited.Code != 429 || limited.Header().Get("Retry-After") == "" || !strings.Contains(limited.Body.String(), "Chat token limit") {
		t.Fatal(limited.Code, limited.Body, limited.Header())
	}
	export := request("/api/investigate/export", "chat-a", cookie, true)
	if !strings.Contains(export.Body.String(), `"status":429`) || !strings.Contains(export.Body.String(), "Chat token limit") {
		t.Fatal(export.Body)
	}
	fresh := request("/api/investigate", "chat-b", cookie, false)
	if fresh.Code != 422 {
		t.Fatal(fresh.Code, fresh.Body)
	}
	global := request("/api/investigate", "chat-c", cookie, false)
	if global.Code != 429 || !strings.Contains(global.Body.String(), "Global token limit") || models.Load() != 2 {
		t.Fatal(global.Code, global.Body, models.Load())
	}
}
