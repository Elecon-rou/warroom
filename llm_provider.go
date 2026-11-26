package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
)

// LLMProvider is the only provider-specific dependency of the application.
// Implementations translate messages, tools, images and schemas, preserve opaque
// continuation state, report usage, and redact credentials from errors/results.
// CountTokens must count the same request Complete will send and fail closed.
// Complete performs one attempt; retries, concurrency and quotas belong to LLM.
type LLMProvider interface {
	Info() LLMInfo
	CountTokens(context.Context, CompletionRequest) (int64, error)
	Complete(context.Context, CompletionRequest) (CompletionResponse, error)
}

type LLMInfo struct {
	Provider   string `json:"provider"`
	Model      string `json:"model"`
	Configured bool   `json:"configured"`
}
type CompletionTask string

const (
	TaskFilter        CompletionTask = "filter"
	TaskQuery         CompletionTask = "query"
	TaskSummary       CompletionTask = "summary"
	TaskInvestigation CompletionTask = "investigation"
	TaskDashboard     CompletionTask = "dashboard"
)

type CompletionRequest struct {
	Task        CompletionTask
	System      string
	Messages    []LLMMessage
	Tools       []LLMTool
	ToolChoice  string // auto, any, none; empty uses the provider default
	Schema      map[string]any
	MaxTokens   int
	Effort      string
	Temperature *float64
	Stream      bool
	OnActivity  func()
	// A fresh text sink per attempt prevents truncated drafts from being concatenated.
	NewTextSink func() func(string)
}
type LLMTool struct {
	Name        string
	Description string
	InputSchema map[string]any
}
type LLMMessage struct {
	Role    string
	Text    string
	Content []LLMContent
}
type LLMImage struct{ MediaType, Data string }
type LLMContent struct {
	Type    string // text, tool_use, tool_result, image, or opaque provider state
	Text    string
	ID      string
	Name    string
	Input   json.RawMessage
	ToolID  string
	IsError bool
	Image   *LLMImage
	// State is private to the originating adapter. Workflows only replay it.
	State any
}

func textMessage(role, text string) LLMMessage { return LLMMessage{Role: role, Text: text} }
func contentMessage(role string, content []LLMContent) LLMMessage {
	return LLMMessage{Role: role, Content: content}
}
func toolResult(id, text string, failed bool) LLMContent {
	return LLMContent{Type: "tool_result", ToolID: id, Text: text, IsError: failed}
}

type CompletionResponse struct {
	StopReason string // end_turn, tool_use, max_tokens; adapters normalize provider reasons
	Content    []LLMContent
	Usage      *TokenUsage
}

func (r CompletionResponse) text() string {
	text := ""
	for _, b := range r.Content {
		if b.Type == "text" {
			text += b.Text
		}
	}
	return strings.TrimSpace(text)
}

// ProviderHTTPError marks a confirmed rejection, allowing quota reservations to
// be refunded. Transport failures and incomplete responses remain charged.
type ProviderHTTPError struct {
	StatusCode int
	Message    string
}

func (e *ProviderHTTPError) Error() string { return e.Message }

type LLM struct {
	provider LLMProvider
	slots    chan struct{}
	budget   *tokenBudget
}

func newLLM(provider LLMProvider, budget *tokenBudget) *LLM {
	return &LLM{provider: provider, slots: make(chan struct{}, 4), budget: budget}
}
func (l *LLM) Info() LLMInfo {
	if l == nil || l.provider == nil {
		return LLMInfo{}
	}
	return l.provider.Info()
}
func (l *LLM) acquire(ctx context.Context) (func(), error) {
	select {
	case l.slots <- struct{}{}:
		return func() { <-l.slots }, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}
func (l *LLM) Complete(ctx context.Context, request CompletionRequest) (CompletionResponse, error) {
	if !l.Info().Configured {
		return CompletionResponse{}, fmt.Errorf("LLM provider is not configured on the server.")
	}
	attempts := 1
	switch request.Task {
	case TaskInvestigation:
		tokens, effort := investigationOutputSettings()
		if request.MaxTokens == 0 {
			request.MaxTokens = tokens
		}
		if request.Effort == "" {
			request.Effort = effort
		}
		attempts = 2
	case TaskDashboard:
		request.Stream = true
		if request.MaxTokens == 0 {
			request.MaxTokens = 16384
		}
		request.Effort = env("DASHBOARD_EFFORT", "medium")
		if !oneOf(request.Effort, "low", "medium", "high", "max") {
			request.Effort = "medium"
		}
		attempts = 2
	}
	if request.MaxTokens < 1 || request.MaxTokens > 1_000_000 {
		return CompletionResponse{}, fmt.Errorf("Invalid model output token allowance.")
	}
	for attempt := 0; attempt < attempts; attempt++ {
		reservation, err := l.reserve(ctx, request)
		if err != nil {
			return CompletionResponse{}, err
		}
		response, err := l.provider.Complete(ctx, request)
		var rejection *ProviderHTTPError
		if errors.As(err, &rejection) && rejection.StatusCode >= 400 && rejection.StatusCode < 500 {
			reservation.finish(0)
		}
		reservation.settle(response.Usage)
		ceiling := 32768
		if request.Task == TaskInvestigation {
			ceiling = investigationRetryTokens
		}
		if err != nil || response.StopReason != "max_tokens" || attempt == attempts-1 || request.MaxTokens >= ceiling {
			return response, err
		}
		request.MaxTokens = min(request.MaxTokens*2, ceiling)
	}
	return CompletionResponse{}, fmt.Errorf("LLM completion retry exhausted")
}
func (l *LLM) reserve(ctx context.Context, request CompletionRequest) (*tokenReservation, error) {
	if l.budget == nil {
		return nil, nil
	}
	chat, _ := ctx.Value(tokenScopeKey{}).(string)
	probe, err := l.budget.reserve(chat, 1)
	if err != nil {
		return nil, err
	}
	probe.finish(0)
	input, err := l.provider.CountTokens(ctx, request)
	if err != nil {
		return nil, err
	}
	if input < 1 || input > 20_000_000 {
		return nil, fmt.Errorf("Invalid token preflight response; no generation started.")
	}
	return l.budget.reserve(chat, input+max(1024, input/20)+int64(request.MaxTokens))
}
func (l *LLM) message(ctx context.Context, system string, input any) (string, error) {
	data, err := json.Marshal(input)
	if err != nil {
		return "", err
	}
	response, err := l.Complete(ctx, CompletionRequest{Task: TaskFilter, MaxTokens: 16, System: system, Messages: []LLMMessage{textMessage("user", string(data))}})
	if err != nil {
		return "", err
	}
	if response.StopReason != "end_turn" {
		return "", fmt.Errorf("LLM response incomplete (%s)", response.StopReason)
	}
	return response.text(), nil
}

func configuredLLM() (*LLM, error) {
	switch provider := env("LLM_PROVIDER", "anthropic"); provider {
	case "anthropic":
		return newLLM(newClaude(), newTokenBudget()), nil
	default:
		return nil, fmt.Errorf("unsupported LLM_PROVIDER %q", provider)
	}
}
