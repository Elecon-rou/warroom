package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"sync"
	"time"
	"unicode/utf8"
)

const historyCookie = "warroom_history_session"
const historySessionLimit = 128
const historyIdleLimit = 7 * 24 * time.Hour

type queryHistoryEntry struct {
	Kind     string `json:"kind"`
	SourceID string `json:"sourceId,omitempty"`
	Query    string `json:"query"`
	At       int64  `json:"at"`
}
type queryHistorySession struct {
	entries []queryHistoryEntry
	touched time.Time
}
type queryHistoryStore struct {
	mu       sync.Mutex
	sessions map[string]*queryHistorySession
}

func newQueryHistoryStore() *queryHistoryStore {
	return &queryHistoryStore{sessions: map[string]*queryHistorySession{}}
}

func (a *App) queryHistory(w http.ResponseWriter, r *http.Request) {
	// A session cookie is the only identifier. Queries never go into browser storage
	// or cookies; server memory is bounded and never written to disk.
	if r.Header.Get("Sec-Fetch-Site") == "cross-site" {
		fail(w, 403, "Cross-origin history access is not allowed.")
		return
	}
	if origin := r.Header.Get("Origin"); origin != "" {
		u, err := url.Parse(origin)
		if err != nil || u.Host != r.Host || !oneOf(u.Scheme, "http", "https") {
			fail(w, 403, "Cross-origin history access is not allowed.")
			return
		}
	}
	var entry queryHistoryEntry
	if r.Method == http.MethodPost {
		var input struct {
			Kind     string `json:"kind"`
			SourceID string `json:"sourceId,omitempty"`
			Query    string `json:"query"`
		}
		dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 100<<10))
		dec.DisallowUnknownFields()
		if dec.Decode(&input) != nil || dec.Decode(new(any)) != io.EOF || !oneOf(input.Kind, "metrics", "logs", "traces") || !dashboardText(input.Query, 16000) || !utf8.ValidString(input.Query) {
			fail(w, 400, "Invalid history entry.")
			return
		}
		entry = queryHistoryEntry{Kind: input.Kind, SourceID: input.SourceID, Query: input.Query, At: time.Now().UnixMilli()}
	}
	store := a.history
	if store == nil {
		fail(w, 503, "Query history unavailable.")
		return
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	now := time.Now()
	for id, s := range store.sessions {
		if now.Sub(s.touched) > historyIdleLimit {
			delete(store.sessions, id)
		}
	}
	id := ""
	if cookie, err := r.Cookie(historyCookie); err == nil {
		id = cookie.Value
	}
	session := store.sessions[id]
	if session == nil {
		token := make([]byte, 32)
		if _, err := rand.Read(token); err != nil {
			fail(w, 500, "Could not create history session.")
			return
		}
		id = hex.EncodeToString(token)
		// Evict the least recently used orphan/session when the process budget is full.
		if len(store.sessions) >= historySessionLimit {
			oldestID := ""
			oldest := now
			for key, s := range store.sessions {
				if oldestID == "" || s.touched.Before(oldest) {
					oldestID = key
					oldest = s.touched
				}
			}
			delete(store.sessions, oldestID)
		}
		session = &queryHistorySession{entries: []queryHistoryEntry{}}
		store.sessions[id] = session
		http.SetCookie(w, &http.Cookie{Name: historyCookie, Value: id, Path: "/api/history", HttpOnly: true, Secure: r.TLS != nil, SameSite: http.SameSiteStrictMode})
	}
	session.touched = now
	if r.Method == http.MethodPost {
		next := []queryHistoryEntry{entry}
		for _, old := range session.entries {
			if (old.Kind != entry.Kind || old.SourceID != entry.SourceID || old.Query != entry.Query) && len(next) < 30 {
				next = append(next, old)
			}
		}
		session.entries = next
	} else if r.Method == http.MethodDelete {
		session.entries = []queryHistoryEntry{}
	}
	send(w, 200, session.entries)
}
