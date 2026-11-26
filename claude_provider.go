package main

import (
	"context"
	"fmt"
	"strconv"
	"strings"
)

var _ LLMProvider = (*Claude)(nil)

func (c *Claude) Info() LLMInfo {
	return LLMInfo{Provider: "anthropic", Model: c.model, Configured: c.key != ""}
}

// All Anthropic wire keys, model compatibility and content replay stay here.
func (c *Claude) payload(q CompletionRequest) (map[string]any, error) {
	model := c.model
	if q.Task == TaskFilter {
		model = c.filterModel
	}
	messages := []map[string]any{}
	for _, m := range q.Messages {
		var content any = m.Text
		if m.Content != nil {
			blocks := []any{}
			for _, b := range m.Content {
				if state, ok := b.State.(claudeContentState); ok {
					blocks = append(blocks, state.block)
					continue
				}
				switch b.Type {
				case "text":
					blocks = append(blocks, map[string]any{"type": "text", "text": b.Text})
				case "image":
					if b.Image == nil {
						return nil, fmt.Errorf("missing LLM image data")
					}
					blocks = append(blocks, map[string]any{"type": "image", "source": map[string]string{"type": "base64", "media_type": b.Image.MediaType, "data": b.Image.Data}})
				case "tool_use":
					blocks = append(blocks, map[string]any{"type": "tool_use", "id": b.ID, "name": b.Name, "input": b.Input})
				case "tool_result":
					blocks = append(blocks, map[string]any{"type": "tool_result", "tool_use_id": b.ToolID, "content": b.Text, "is_error": b.IsError})
				default:
					return nil, fmt.Errorf("unsupported LLM content %q", b.Type)
				}
			}
			content = blocks
		}
		messages = append(messages, map[string]any{"role": m.Role, "content": content})
	}
	payload := map[string]any{"model": model, "max_tokens": q.MaxTokens, "system": q.System, "messages": messages}
	if q.Tools != nil {
		tools := []map[string]any{}
		for _, t := range q.Tools {
			tools = append(tools, map[string]any{"name": t.Name, "description": t.Description, "input_schema": t.InputSchema})
		}
		payload["tools"] = tools
	}
	if q.ToolChoice != "" {
		payload["tool_choice"] = map[string]string{"type": q.ToolChoice}
	}
	if q.Temperature != nil {
		payload["temperature"] = *q.Temperature
	}
	config := map[string]any{}
	if q.Schema != nil {
		config["format"] = map[string]any{"type": "json_schema", "schema": q.Schema}
	}
	switch q.Task {
	case TaskInvestigation:
		payload["thinking"] = map[string]string{"type": "adaptive"}
		config["effort"] = q.Effort
		if strings.Contains(c.model, "-4-5") {
			payload["thinking"] = map[string]any{"type": "enabled", "budget_tokens": min(8192, q.MaxTokens-1024)}
			delete(config, "effort")
			if strings.HasPrefix(c.model, "claude-opus-4-5") {
				config["effort"] = "high"
			}
		}
	case TaskDashboard:
		payload["thinking"] = map[string]string{"type": "adaptive"}
		config["effort"] = q.Effort
		if strings.Contains(c.model, "-4-5") || strings.Contains(c.model, "-4-6") {
			budget := dashboardThinkingBudget()
			payload["thinking"] = map[string]any{"type": "enabled", "budget_tokens": min(budget, q.MaxTokens-1024)}
			delete(config, "effort")
		}
		if q.ToolChoice == "none" {
			payload["thinking"] = map[string]string{"type": "disabled"}
			if !strings.Contains(c.model, "-4-5") {
				config["effort"] = q.Effort
			}
		}
	}
	if len(config) > 0 {
		payload["output_config"] = config
	}
	return payload, nil
}

type claudeContentState struct{ block ClaudeBlock }

func (c *Claude) normalized(result ClaudeResponse) CompletionResponse {
	out := CompletionResponse{StopReason: result.StopReason, Usage: result.Usage}
	for _, b := range result.Content {
		text := b.Text
		if c.key != "" {
			text = strings.ReplaceAll(text, c.key, "[redacted]")
		}
		kind := b.Type
		if kind != "text" && kind != "tool_use" {
			kind = "opaque"
		}
		out.Content = append(out.Content, LLMContent{Type: kind, Text: text, ID: b.ID, Name: b.Name, Input: b.Input, State: claudeContentState{b}})
	}
	return out
}
func (c *Claude) Complete(ctx context.Context, q CompletionRequest) (CompletionResponse, error) {
	payload, err := c.payload(q)
	if err != nil {
		return CompletionResponse{}, err
	}
	// Clone transport settings so long-running requests cannot change other calls.
	isolated := *c
	if q.Stream {
		notify := q.OnActivity
		if notify == nil {
			notify = func() {}
		}
		onText := func(string) {}
		if q.NewTextSink != nil {
			onText = q.NewTextSink()
		}
		result, err := isolated.streamComplete(ctx, payload, notify, onText)
		return c.normalized(result), err
	}
	if q.Task == TaskInvestigation {
		client := *c.client
		client.Timeout = investigationRequestTimeout
		isolated.client = &client
	}
	result, err := isolated.complete(ctx, payload)
	return c.normalized(result), err
}
func (c *Claude) CountTokens(ctx context.Context, q CompletionRequest) (int64, error) {
	payload, err := c.payload(q)
	if err != nil {
		return 0, err
	}
	return c.countInputTokens(ctx, payload)
}

func dashboardThinkingBudget() int {
	budget, err := strconv.Atoi(env("DASHBOARD_THINKING_BUDGET", "2048"))
	if err != nil || budget < 1024 || budget > 8192 {
		return 2048
	}
	return budget
}
