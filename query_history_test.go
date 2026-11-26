package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func historyRequest(a *App, method, body string, cookie *http.Cookie) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, "/api/history", strings.NewReader(body))
	if cookie != nil {
		r.AddCookie(cookie)
	}
	w := httptest.NewRecorder()
	a.handler().ServeHTTP(w, r)
	return w
}
func TestHistoryCookieSessionIsolationAndClear(t *testing.T) {
	a := newTestApp()
	first := historyRequest(a, "GET", "", nil)
	cookies := first.Result().Cookies()
	if first.Code != 200 || len(cookies) != 1 || cookies[0].MaxAge != 0 || !cookies[0].Expires.IsZero() || !cookies[0].HttpOnly || cookies[0].SameSite != http.SameSiteStrictMode {
		t.Fatal(first.Code, cookies)
	}
	session := cookies[0]
	added := historyRequest(a, "POST", `{"kind":"metrics","query":"sum(up)"}`, session)
	if added.Code != 200 || !strings.Contains(added.Body.String(), "sum(up)") {
		t.Fatal(added.Code, added.Body)
	}
	// Another tab sharing the cookie sees the same history.
	shared := historyRequest(a, "GET", "", session)
	if !strings.Contains(shared.Body.String(), "sum(up)") {
		t.Fatal(shared.Body)
	}
	// Discarding the cookie (session end) cannot recover the previous history.
	fresh := historyRequest(a, "GET", "", nil)
	if strings.TrimSpace(fresh.Body.String()) != "[]" || fresh.Result().Cookies()[0].Value == session.Value {
		t.Fatal(fresh.Body)
	}
	if w := historyRequest(a, "DELETE", "", session); strings.TrimSpace(w.Body.String()) != "[]" {
		t.Fatal(w.Body)
	}
	if w := historyRequest(a, "GET", "", session); strings.TrimSpace(w.Body.String()) != "[]" {
		t.Fatal(w.Body)
	}
	// A restart never persists a cookie's queries to disk.
	if w := historyRequest(newTestApp(), "GET", "", session); strings.TrimSpace(w.Body.String()) != "[]" {
		t.Fatal(w.Body)
	}
}
func TestHistoryDeduplicatesAndBoundsEntriesAndSessions(t *testing.T) {
	a := newTestApp()
	cookie := historyRequest(a, "GET", "", nil).Result().Cookies()[0]
	for i := 0; i < 35; i++ {
		w := historyRequest(a, "POST", fmt.Sprintf(`{"kind":"logs","query":"log-%d"}`, i), cookie)
		if w.Code != 200 {
			t.Fatal(w.Body)
		}
	}
	w := historyRequest(a, "POST", `{"kind":"logs","query":"log-10"}`, cookie)
	var entries []queryHistoryEntry
	_ = json.Unmarshal(w.Body.Bytes(), &entries)
	if len(entries) != 30 || entries[0].Query != "log-10" {
		t.Fatal(entries)
	}
	count := 0
	for _, e := range entries {
		if e.Query == "log-10" {
			count++
		}
	}
	if count != 1 {
		t.Fatal("query not deduplicated")
	}
	a.history.sessions[cookie.Value].touched = time.Now().Add(-historyIdleLimit - time.Second)
	if w := historyRequest(a, "GET", "", cookie); strings.TrimSpace(w.Body.String()) != "[]" {
		t.Fatal(w.Body)
	}
	for i := 0; i < historySessionLimit+5; i++ {
		historyRequest(a, "GET", "", nil)
	}
	if len(a.history.sessions) > historySessionLimit {
		t.Fatal("unbounded history store")
	}
}
func TestHistoryRejectsCrossOriginAndInvalidEntries(t *testing.T) {
	a := newTestApp()
	for _, body := range []string{`{"kind":"unknown","query":"up"}`, `{"kind":"metrics","query":""}`, `{"kind":"metrics","query":"up","at":1}`, `{"kind":"metrics","query":"up"} {}`} {
		w := historyRequest(a, "POST", body, nil)
		if w.Code != 400 {
			t.Fatal(w.Code, w.Body)
		}
	}
	r := httptest.NewRequest("DELETE", "http://local/api/history", nil)
	r.Header.Set("Origin", "https://elsewhere")
	w := httptest.NewRecorder()
	a.handler().ServeHTTP(w, r)
	if w.Code != 403 {
		t.Fatal(w.Code)
	}
	r = httptest.NewRequest("GET", "/api/history", nil)
	r.Header.Set("Sec-Fetch-Site", "cross-site")
	w = httptest.NewRecorder()
	a.handler().ServeHTTP(w, r)
	if w.Code != 403 {
		t.Fatal(w.Code)
	}
}
