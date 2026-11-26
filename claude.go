package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"
)

type Claude struct {
	key, model, filterModel, endpoint string
	client                            *http.Client
}

func newClaude() *Claude {
	key := os.Getenv("ANTHROPIC_API_KEY")
	if key == "" && os.Getenv("ANTHROPIC_API_KEY_FILE") != "" {
		b, err := os.ReadFile(os.Getenv("ANTHROPIC_API_KEY_FILE"))
		if err == nil {
			key = strings.TrimSpace(string(b))
		}
	}
	return &Claude{key: key, model: env("ANTHROPIC_MODEL", "claude-sonnet-4-6"), filterModel: env("ANTHROPIC_FILTER_MODEL", "claude-haiku-4-5-20251001"), endpoint: "https://api.anthropic.com/v1/messages", client: &http.Client{Timeout: 45 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}
}

type ClaudeBlock struct {
	raw   json.RawMessage
	Type  string          `json:"type"`
	Text  string          `json:"text,omitempty"`
	ID    string          `json:"id,omitempty"`
	Name  string          `json:"name,omitempty"`
	Input json.RawMessage `json:"input,omitempty"`
}

// Preserve complete signed thinking/redacted blocks (and future block fields)
// when replaying an assistant tool-use turn. Only text blocks reach the UI.
func (b *ClaudeBlock) UnmarshalJSON(data []byte) error {
	type plain ClaudeBlock
	var value plain
	if err := json.Unmarshal(data, &value); err != nil {
		return err
	}
	*b = ClaudeBlock(value)
	b.raw = append(json.RawMessage(nil), data...)
	return nil
}
func (b ClaudeBlock) MarshalJSON() ([]byte, error) {
	if b.raw != nil {
		return b.raw, nil
	}
	type plain ClaudeBlock
	return json.Marshal(plain(b))
}

type ClaudeResponse struct {
	StopReason string        `json:"stop_reason"`
	Usage      *TokenUsage   `json:"usage,omitempty"`
	Content    []ClaudeBlock `json:"content"`
}

func (r ClaudeResponse) text() string {
	var text strings.Builder
	for _, block := range r.Content {
		if block.Type == "text" {
			text.WriteString(block.Text)
		}
	}
	return strings.TrimSpace(text.String())
}
func (c *Claude) complete(ctx context.Context, payload map[string]any) (ClaudeResponse, error) {
	body, _ := json.Marshal(payload)
	req, err := http.NewRequestWithContext(ctx, "POST", c.endpoint, bytes.NewReader(body))
	if err != nil {
		return ClaudeResponse{}, err
	}
	req.Header.Set("x-api-key", c.key)
	req.Header.Set("anthropic-version", "2023-06-01")
	req.Header.Set("Content-Type", "application/json")
	response, err := c.client.Do(req)
	if err != nil {
		return ClaudeResponse{}, fmt.Errorf("Claude request failed: %w", err)
	}
	defer response.Body.Close()
	data, err := io.ReadAll(io.LimitReader(response.Body, (1<<20)+1))
	if err != nil {
		return ClaudeResponse{}, err
	}
	if len(data) > 1<<20 {
		return ClaudeResponse{}, fmt.Errorf("Claude response exceeds size limit")
	}
	if response.StatusCode != 200 {
		var detail struct {
			Error struct {
				Message string `json:"message"`
			}
		}
		_ = json.Unmarshal(data, &detail)
		message := strings.ReplaceAll(detail.Error.Message, c.key, "[redacted]")
		if len(message) > 400 {
			message = message[:400]
		}
		return ClaudeResponse{}, &ProviderHTTPError{StatusCode: response.StatusCode, Message: fmt.Sprintf("Claude returned HTTP %d: %s", response.StatusCode, message)}
	}
	var result ClaudeResponse
	if json.Unmarshal(data, &result) != nil {
		return ClaudeResponse{}, fmt.Errorf("invalid Claude response")
	}
	return result, nil
}

type claudeIdleTimeout struct{}

func (claudeIdleTimeout) Error() string   { return "Claude response was inactive for 90 seconds" }
func (claudeIdleTimeout) Timeout() bool   { return true }
func (claudeIdleTimeout) Temporary() bool { return true }

// Consume Claude's upstream SSE stream. Active responses are bounded by the
// workflow deadline rather than a wall-clock HTTP timeout. Never expose thinking
// text; reconstruct complete signed blocks for tool history and reject partials.
func (c *Claude) streamComplete(ctx context.Context, payload map[string]any, activity func(), onText func(string)) (ClaudeResponse, error) {
	requestCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	idle := time.AfterFunc(90*time.Second, cancel)
	defer idle.Stop()
	payload["stream"] = true
	encoded, err := json.Marshal(payload)
	if err != nil {
		return ClaudeResponse{}, err
	}
	req, err := http.NewRequestWithContext(requestCtx, "POST", c.endpoint, bytes.NewReader(encoded))
	if err != nil {
		return ClaudeResponse{}, err
	}
	req.Header.Set("x-api-key", c.key)
	req.Header.Set("anthropic-version", "2023-06-01")
	req.Header.Set("Content-Type", "application/json")
	client := *c.client
	client.Timeout = 0
	response, err := client.Do(req)
	stalled := func(err error) error {
		if requestCtx.Err() != nil && ctx.Err() == nil {
			return claudeIdleTimeout{}
		}
		return err
	}
	if err != nil {
		return ClaudeResponse{}, stalled(fmt.Errorf("Claude request failed: %w", err))
	}
	defer response.Body.Close()
	clean := func(s string) string {
		s = strings.ReplaceAll(s, c.key, "[redacted]")
		if len(s) > 400 {
			s = s[:400]
		}
		return s
	}
	if response.StatusCode != 200 {
		data, _ := io.ReadAll(io.LimitReader(response.Body, 16384))
		var detail struct {
			Error struct {
				Message string `json:"message"`
			} `json:"error"`
		}
		_ = json.Unmarshal(data, &detail)
		return ClaudeResponse{}, &ProviderHTTPError{StatusCode: response.StatusCode, Message: fmt.Sprintf("Claude returned HTTP %d: %s", response.StatusCode, clean(detail.Error.Message))}
	}
	if !strings.Contains(response.Header.Get("Content-Type"), "text/event-stream") {
		var result ClaudeResponse
		err := json.NewDecoder(io.LimitReader(response.Body, (1<<20)+1)).Decode(&result)
		if err == nil {
			onText(result.text())
		}
		return result, stalled(err)
	}
	blocks := []map[string]any{}
	inputs := map[int]string{}
	closed := map[int]bool{}
	result := ClaudeResponse{}
	finished := false
	size := 0
	lastActivity := time.Now()
	process := func(data string) error {
		var event struct {
			Type    string         `json:"type"`
			Index   int            `json:"index"`
			Block   map[string]any `json:"content_block"`
			Delta   map[string]any `json:"delta"`
			Usage   *TokenUsage    `json:"usage"`
			Message struct {
				Usage *TokenUsage `json:"usage"`
			} `json:"message"`
			Error struct {
				Message string `json:"message"`
			} `json:"error"`
		}
		if json.Unmarshal([]byte(data), &event) != nil {
			return fmt.Errorf("Invalid Claude stream event.")
		}
		if result.Usage == nil {
			result.Usage = &TokenUsage{}
		}
		result.Usage.merge(event.Message.Usage)
		result.Usage.merge(event.Usage)
		switch event.Type {
		case "error":
			return fmt.Errorf("Claude stream error: %s", clean(event.Error.Message))
		case "content_block_start":
			if event.Index != len(blocks) || event.Block == nil || event.Index > 128 {
				return fmt.Errorf("Invalid Claude content block index.")
			}
			blockBytes, _ := json.Marshal(event.Block)
			size += len(blockBytes)
			if size > 1<<20 {
				return fmt.Errorf("Claude response exceeds size limit.")
			}
			blocks = append(blocks, event.Block)
			if event.Block["type"] == "text" {
				if text, ok := event.Block["text"].(string); ok {
					onText(text)
				}
			}
		case "content_block_delta":
			if event.Index < 0 || event.Index >= len(blocks) || closed[event.Index] {
				return fmt.Errorf("Invalid Claude delta index.")
			}
			kind, _ := event.Delta["type"].(string)
			if kind == "text_delta" {
				if text, ok := event.Delta["text"].(string); ok {
					onText(text)
				}
			}
			if kind == "input_json_delta" {
				part, _ := event.Delta["partial_json"].(string)
				inputs[event.Index] += part
				size += len(part)
			} else {
				for _, field := range []string{"text", "thinking", "signature"} {
					if part, ok := event.Delta[field].(string); ok {
						previous, _ := blocks[event.Index][field].(string)
						blocks[event.Index][field] = previous + part
						size += len(part)
					}
				}
			}
			if size > 1<<20 {
				return fmt.Errorf("Claude response exceeds size limit.")
			}
			if time.Since(lastActivity) > 10*time.Second {
				activity()
				lastActivity = time.Now()
			}
		case "content_block_stop":
			if event.Index < 0 || event.Index >= len(blocks) {
				return fmt.Errorf("Invalid Claude block stop.")
			}
			if text, ok := inputs[event.Index]; ok {
				var value any
				if json.Unmarshal([]byte(text), &value) != nil {
					return fmt.Errorf("Invalid Claude tool input.")
				}
				blocks[event.Index]["input"] = value
			}
			closed[event.Index] = true
		case "message_delta":
			if reason, ok := event.Delta["stop_reason"].(string); ok {
				result.StopReason = reason
			}
		case "message_stop":
			finished = true
		}
		return nil
	}
	scanner := bufio.NewScanner(response.Body)
	scanner.Buffer(make([]byte, 4096), (1<<20)+1)
	var data strings.Builder
	for scanner.Scan() {
		idle.Reset(90 * time.Second)
		line := scanner.Text()
		if line == "" {
			if data.Len() > 0 {
				if err := process(data.String()); err != nil {
					return ClaudeResponse{}, err
				}
				data.Reset()
			}
			if finished {
				break
			}
			continue
		}
		if strings.HasPrefix(line, "data:") {
			if data.Len() > 0 {
				data.WriteByte('\n')
			}
			data.WriteString(strings.TrimPrefix(strings.TrimPrefix(line, "data:"), " "))
		}
	}
	if err := scanner.Err(); err != nil {
		return ClaudeResponse{}, stalled(err)
	}
	if data.Len() > 0 && !finished {
		if err := process(data.String()); err != nil {
			return ClaudeResponse{}, err
		}
	}
	if !finished || result.StopReason == "" || len(closed) != len(blocks) {
		return ClaudeResponse{}, stalled(fmt.Errorf("Claude response stream ended before completion; partial output was discarded."))
	}
	for _, block := range blocks {
		encoded, _ := json.Marshal(block)
		var value ClaudeBlock
		if json.Unmarshal(encoded, &value) != nil {
			return ClaudeResponse{}, fmt.Errorf("Invalid Claude response block.")
		}
		result.Content = append(result.Content, value)
	}
	return result, nil
}

func (c *Claude) countInputTokens(ctx context.Context, payload map[string]any) (int64, error) {
	counted := map[string]any{}
	for _, key := range []string{"model", "messages", "system", "tools", "tool_choice", "thinking", "output_config"} {
		if value, ok := payload[key]; ok {
			counted[key] = value
		}
	}
	encoded, err := json.Marshal(counted)
	if err != nil {
		return 0, err
	}
	countCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(countCtx, "POST", strings.TrimRight(c.endpoint, "/")+"/count_tokens", bytes.NewReader(encoded))
	if err != nil {
		return 0, err
	}
	req.Header.Set("x-api-key", c.key)
	req.Header.Set("anthropic-version", "2023-06-01")
	req.Header.Set("Content-Type", "application/json")
	response, err := c.client.Do(req)
	if err != nil {
		return 0, fmt.Errorf("Token preflight failed; no generation started: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode != 200 {
		return 0, fmt.Errorf("Token preflight returned HTTP %d; no generation started.", response.StatusCode)
	}
	var count struct {
		Input int64 `json:"input_tokens"`
	}
	if json.NewDecoder(io.LimitReader(response.Body, 64<<10)).Decode(&count) != nil || count.Input < 1 || count.Input > 20_000_000 {
		return 0, fmt.Errorf("Invalid token preflight response; no generation started.")
	}
	return count.Input, nil
}
