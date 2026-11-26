package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"math"
	"net/http"
	"regexp"
	"strconv"
	"sync"
	"time"
)

// All LLM providers share this process-wide ledger. It contains token
// counts and opaque chat keys only; never prompts, telemetry or credentials.
type tokenBudget struct {
	mu                       sync.Mutex
	globalLimit, chatLimit   int64
	globalWindow, chatWindow time.Duration
	global                   tokenBucket
	chats                    map[string]*tokenBucket
	now                      func() time.Time
}
type tokenCharge struct {
	at     time.Time
	tokens int64
}
type tokenBucket struct {
	charges    []tokenCharge
	used, held int64
}
type tokenScopeKey struct{}
type tokenOwnerKey struct{}
type TokenUsage struct {
	Input         int64 `json:"input_tokens"`
	Output        int64 `json:"output_tokens"`
	CacheRead     int64 `json:"cache_read_input_tokens"`
	CacheCreation int64 `json:"cache_creation_input_tokens"`
}

func (u TokenUsage) total() int64 {
	if u.Input < 0 || u.Output <= 0 || u.CacheRead < 0 || u.CacheCreation < 0 || u.Input+u.CacheRead+u.CacheCreation <= 0 {
		return 0
	}
	return max(0, u.Input) + max(0, u.Output) + max(0, u.CacheRead) + max(0, u.CacheCreation)
}
func (u *TokenUsage) merge(v *TokenUsage) {
	if v == nil {
		return
	}
	u.Input = max(u.Input, v.Input)
	u.Output = max(u.Output, v.Output)
	u.CacheRead = max(u.CacheRead, v.CacheRead)
	u.CacheCreation = max(u.CacheCreation, v.CacheCreation)
}
func tokenSetting(name string, fallback int64) int64 {
	n, err := strconv.ParseInt(env(name, ""), 10, 64)
	if err != nil || n < 1 || n > 1_000_000_000 {
		return fallback
	}
	return n
}
func tokenWindowSetting(name string) time.Duration {
	d, err := time.ParseDuration(env(name, "1h"))
	if err != nil || d < time.Minute || d > 7*24*time.Hour {
		return time.Hour
	}
	return d
}
func newTokenBudget() *tokenBudget {
	return &tokenBudget{globalLimit: tokenSetting("LLM_GLOBAL_TOKEN_LIMIT", 2_000_000), chatLimit: tokenSetting("LLM_CHAT_TOKEN_LIMIT", 300_000), globalWindow: tokenWindowSetting("LLM_GLOBAL_TOKEN_WINDOW"), chatWindow: tokenWindowSetting("LLM_CHAT_TOKEN_WINDOW"), chats: map[string]*tokenBucket{}, now: time.Now}
}
func (b *tokenBucket) prune(now time.Time, window time.Duration) {
	n := 0
	for n < len(b.charges) && !b.charges[n].at.Add(window).After(now) {
		b.used -= b.charges[n].tokens
		n++
	}
	if n > 0 {
		b.charges = append([]tokenCharge(nil), b.charges[n:]...)
	}
}

type tokenLimitError struct {
	Scope                  string
	Limit, Used, Requested int64
	Window                 time.Duration
	RetryAfter             int
}

func (e *tokenLimitError) Error() string {
	if e.Requested > e.Limit {
		return fmt.Sprintf("%s token limit is %d per %s, but this request needs %d including reserved output. Reduce context/output or configure a higher limit.", e.Scope, e.Limit, e.Window, e.Requested)
	}
	return fmt.Sprintf("%s token limit reached (%d tokens per %s; %d available, %d required including reserved output). Retry in %d seconds.", e.Scope, e.Limit, e.Window, max(0, e.Limit-e.Used), e.Requested, e.RetryAfter)
}
func bucketLimit(scope string, b *tokenBucket, need, limit int64, window time.Duration, now time.Time) error {
	if need <= limit-b.used-b.held {
		return nil
	}
	retry := 1
	remaining := b.used + b.held
	for _, charge := range b.charges {
		remaining -= charge.tokens
		retry = max(1, int(math.Ceil(charge.at.Add(window).Sub(now).Seconds())))
		if need <= limit-remaining {
			break
		}
	}
	// A single request bigger than the whole budget requires a smaller context.
	if need > limit {
		retry = max(1, int(window.Seconds()))
	}
	return &tokenLimitError{scope, limit, b.used + b.held, need, window, retry}
}
func (b *tokenBudget) prune(now time.Time) {
	b.global.prune(now, b.globalWindow)
	for key, chat := range b.chats {
		chat.prune(now, b.chatWindow)
		if chat.used == 0 && chat.held == 0 {
			delete(b.chats, key)
		}
	}
}

type tokenReservation struct {
	budget *tokenBudget
	chat   *tokenBucket
	amount int64
	once   sync.Once
}

func (b *tokenBudget) reserve(chatKey string, amount int64) (*tokenReservation, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	now := b.now()
	b.prune(now)
	if err := bucketLimit("Global", &b.global, amount, b.globalLimit, b.globalWindow, now); err != nil {
		return nil, err
	}
	var chat *tokenBucket
	if chatKey != "" {
		chat = b.chats[chatKey]
		if chat == nil {
			if len(b.chats) >= 4096 {
				return nil, &tokenLimitError{"Chat capacity", 4096, 4096, 1, b.chatWindow, 60}
			}
			chat = &tokenBucket{}
		}
		if err := bucketLimit("Chat", chat, amount, b.chatLimit, b.chatWindow, now); err != nil {
			return nil, err
		}
		b.chats[chatKey] = chat
		chat.held += amount
	}
	b.global.held += amount
	return &tokenReservation{budget: b, chat: chat, amount: amount}, nil
}
func (t *tokenReservation) finish(tokens int64) {
	if t == nil {
		return
	}
	t.once.Do(func() {
		b := t.budget
		b.mu.Lock()
		defer b.mu.Unlock()
		now := b.now()
		tokens = max(0, tokens)
		for _, bucket := range []*tokenBucket{&b.global, t.chat} {
			if bucket == nil {
				continue
			}
			bucket.held -= t.amount
			if tokens > 0 {
				bucket.used += tokens
				bucket.charges = append(bucket.charges, tokenCharge{now, tokens})
			}
		}
	})
}
func (t *tokenReservation) settle(usage *TokenUsage) {
	if t == nil {
		return
	}
	charge := t.amount
	if usage != nil && usage.total() > 0 {
		charge = usage.total()
	}
	t.finish(charge)
}
func llmErrorStatus(w http.ResponseWriter, err error) int {
	var limited *tokenLimitError
	if errors.As(err, &limited) {
		w.Header().Set("Retry-After", strconv.Itoa(limited.RetryAfter))
		return http.StatusTooManyRequests
	}
	return http.StatusBadGateway
}

var chatIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,100}$`)

func chatBudgetContext(ctx context.Context, chatID string) (context.Context, error) {
	if chatID != "" && !chatIDPattern.MatchString(chatID) {
		return ctx, fmt.Errorf("Invalid chat identifier.")
	}
	owner, _ := ctx.Value(tokenOwnerKey{}).(string)
	if owner == "" {
		owner = "legacy"
	}
	if chatID == "" {
		chatID = "legacy"
	}
	return context.WithValue(ctx, tokenScopeKey{}, owner+"/"+chatID), nil
}
func (a *App) tokenBudgetMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if a.llm == nil || a.llm.budget == nil {
			next.ServeHTTP(w, r)
			return
		}
		isLLM := oneOf(r.URL.Path, "/api/investigate", "/api/investigate/export", "/api/llm/generate", "/api/dashboards/generate", "/api/llm/usage")
		if !isLLM {
			next.ServeHTTP(w, r)
			return
		}
		owner := ""
		if cookie, err := r.Cookie("warroom_llm_session"); err == nil && len(cookie.Value) == 64 {
			if _, err := hex.DecodeString(cookie.Value); err == nil {
				owner = cookie.Value
			}
		}
		if owner == "" {
			token := make([]byte, 32)
			if _, err := rand.Read(token); err != nil {
				fail(w, 500, "Cannot create LLM session.")
				return
			}
			owner = hex.EncodeToString(token)
			http.SetCookie(w, &http.Cookie{Name: "warroom_llm_session", Value: owner, Path: "/api", HttpOnly: true, Secure: r.TLS != nil, SameSite: http.SameSiteStrictMode})
		}
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), tokenOwnerKey{}, owner)))
	})
}

func (a *App) tokenUsage(w http.ResponseWriter, r *http.Request) {
	if a.llm == nil || a.llm.budget == nil {
		send(w, 200, map[string]any{"enabled": false})
		return
	}
	ctx, err := chatBudgetContext(r.Context(), r.URL.Query().Get("chatId"))
	if err != nil {
		fail(w, 400, err.Error())
		return
	}
	key, _ := ctx.Value(tokenScopeKey{}).(string)
	b := a.llm.budget
	b.mu.Lock()
	defer b.mu.Unlock()
	b.prune(b.now())
	snapshot := func(bucket *tokenBucket, limit int64, window time.Duration) map[string]any {
		used, held := int64(0), int64(0)
		if bucket != nil {
			used, held = bucket.used, bucket.held
		}
		return map[string]any{"limit": limit, "used": used, "reserved": held, "remaining": max(0, limit-used-held), "windowSeconds": int64(window.Seconds())}
	}
	send(w, 200, map[string]any{"enabled": true, "global": snapshot(&b.global, b.globalLimit, b.globalWindow), "chat": snapshot(b.chats[key], b.chatLimit, b.chatWindow)})
}
