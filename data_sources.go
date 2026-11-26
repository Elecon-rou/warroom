package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"sort"
	"strings"
)

type Source struct {
	ID   string `json:"id"`
	Kind string `json:"kind"`
	Name string `json:"name"`
	URL  string `json:"url"`
}
type sourceAuth struct {
	BearerTokenEnv  string            `json:"bearerTokenEnv,omitempty"`
	BearerTokenFile string            `json:"bearerTokenFile,omitempty"`
	HeaderEnv       map[string]string `json:"headerEnv,omitempty"`
	Headers         map[string]string `json:"headers,omitempty"`
}
type sourceConfig struct {
	Source
	sourceAuth
	MCP *struct {
		URL    string `json:"url"`
		Tenant string `json:"tenant,omitempty"`
		sourceAuth
	} `json:"mcp,omitempty"`
}
type sourceContextKey struct{}

var sourceIDPattern = regexp.MustCompile(`^[a-z][a-z0-9_-]{0,39}$`)

func validateSourceURL(raw string) bool {
	u, err := url.Parse(raw)
	return err == nil && oneOf(u.Scheme, "http", "https") && u.Host != "" && u.User == nil && u.RawQuery == "" && u.Fragment == ""
}
func validateSourceAuth(auth sourceAuth) error {
	if auth.BearerTokenEnv != "" && auth.BearerTokenFile != "" {
		return fmt.Errorf("choose bearerTokenEnv or bearerTokenFile")
	}
	for key, value := range auth.Headers {
		if strings.EqualFold(key, "Authorization") || strings.ContainsAny(key+value, "\r\n") {
			return fmt.Errorf("credentials must use environment/file references and headers must be single-line")
		}
	}
	for key, value := range auth.HeaderEnv {
		if strings.ContainsAny(key+value, "\r\n") || value == "" {
			return fmt.Errorf("invalid header environment reference")
		}
	}
	return nil
}
func loadDataSources() ([]sourceConfig, error) {
	data := []byte(os.Getenv("DATA_SOURCES_JSON"))
	if file := os.Getenv("DATA_SOURCES_FILE"); file != "" {
		if len(data) > 0 {
			return nil, fmt.Errorf("set only DATA_SOURCES_FILE or DATA_SOURCES_JSON")
		}
		f, err := os.Open(file)
		if err != nil {
			return nil, fmt.Errorf("cannot open data-source configuration")
		}
		defer f.Close()
		data, err = io.ReadAll(io.LimitReader(f, (1<<20)+1))
		if err != nil {
			return nil, fmt.Errorf("cannot read data-source configuration")
		}
	}
	if len(data) == 0 {
		return []sourceConfig{}, nil
	}
	if len(data) > 1<<20 {
		return nil, fmt.Errorf("data-source configuration exceeds 1 MiB")
	}
	var configs []sourceConfig
	dec := json.NewDecoder(strings.NewReader(string(data)))
	dec.DisallowUnknownFields()
	if dec.Decode(&configs) != nil || dec.Decode(new(any)) != io.EOF || configs == nil || len(configs) > 16 {
		return nil, fmt.Errorf("data-source configuration must be an array of up to 16 sources")
	}
	seen := map[string]bool{}
	for i, c := range configs {
		if !sourceIDPattern.MatchString(c.ID) || seen[c.ID] || !oneOf(c.Kind, "metrics", "logs", "traces") || !dashboardText(c.Name, 120) || !validateSourceURL(c.URL) {
			return nil, fmt.Errorf("invalid or duplicate data source at index %d", i)
		}
		if err := validateSourceAuth(c.sourceAuth); err != nil {
			return nil, fmt.Errorf("source %s: %w", c.ID, err)
		}
		if c.MCP != nil {
			if !validateSourceURL(c.MCP.URL) || len(c.MCP.Tenant) > 100 {
				return nil, fmt.Errorf("invalid MCP configuration for %s", c.ID)
			}
			if err := validateSourceAuth(c.MCP.sourceAuth); err != nil {
				return nil, fmt.Errorf("source %s MCP: %w", c.ID, err)
			}
		}
		seen[c.ID] = true
	}
	return configs, nil
}
func (a *App) configureDataSources(configs []sourceConfig) {
	a.sources = map[string]Source{}
	a.mcps = map[string]*MCPClient{}
	a.sourceAuth = map[string]sourceAuth{}
	a.sourceOrder = nil
	for _, c := range configs {
		a.sources[c.ID] = c.Source
		a.sourceOrder = append(a.sourceOrder, c.ID)
		a.sourceAuth[c.ID] = c.sourceAuth
		if c.MCP != nil {
			client := newMCP(c.Kind)
			client.endpoint = c.MCP.URL
			client.tenant = c.MCP.Tenant
			client.auth = c.MCP.sourceAuth
			a.mcps[c.ID] = client
		}
	}
}
func (a *App) sourceList() []Source {
	list := []Source{}
	seen := map[string]bool{}
	for _, id := range a.sourceOrder {
		if s, ok := a.sources[id]; ok {
			list = append(list, s)
			seen[id] = true
		}
	}
	extra := []string{}
	for id := range a.sources {
		if !seen[id] {
			extra = append(extra, id)
		}
	}
	sort.Strings(extra)
	for _, id := range extra {
		s := a.sources[id]
		if s.ID == "" {
			s.ID = id
		}
		list = append(list, s)
	}
	return list
}
func (a *App) resolveSource(ctx context.Context, kind, id string) (Source, error) {
	if id == "" {
		if selected, ok := ctx.Value(sourceContextKey{}).(map[string]string); ok {
			id = selected[kind]
		}
	}
	if id != "" {
		s, ok := a.sources[id]
		if !ok || s.Kind != kind {
			return Source{}, fmt.Errorf("unknown or incompatible source %q", id)
		}
		if s.ID == "" {
			s.ID = id
		}
		return s, nil
	}
	found := []Source{}
	for _, s := range a.sourceList() {
		if s.Kind == kind {
			found = append(found, s)
		}
	}
	if len(found) == 0 {
		return Source{}, fmt.Errorf("no %s data source configured", kind)
	}
	if len(found) > 1 {
		return Source{}, fmt.Errorf("sourceId is required: multiple %s sources are configured", kind)
	}
	return found[0], nil
}
func (a *App) bindSource(ctx context.Context, kind, id string) (context.Context, Source, error) {
	source, err := a.resolveSource(ctx, kind, id)
	if err != nil {
		return ctx, source, err
	}
	selected := map[string]string{}
	if previous, ok := ctx.Value(sourceContextKey{}).(map[string]string); ok {
		for k, v := range previous {
			selected[k] = v
		}
	}
	selected[kind] = source.ID
	return context.WithValue(ctx, sourceContextKey{}, selected), source, nil
}
func (a *App) mcpFor(ctx context.Context, kind string) *MCPClient {
	source, err := a.resolveSource(ctx, kind, "")
	if err != nil {
		return nil
	}
	return a.mcps[source.ID]
}
func applySourceAuth(r *http.Request, auth sourceAuth) error {
	token := ""
	if auth.BearerTokenEnv != "" {
		token = os.Getenv(auth.BearerTokenEnv)
		if token == "" {
			return fmt.Errorf("source credential environment variable is not set")
		}
	}
	if auth.BearerTokenFile != "" {
		data, err := os.ReadFile(auth.BearerTokenFile)
		if err != nil {
			return fmt.Errorf("source credential file is unavailable")
		}
		token = strings.TrimSpace(string(data))
		if token == "" {
			return fmt.Errorf("source credential file is empty")
		}
	}
	if strings.ContainsAny(token, "\r\n") {
		return fmt.Errorf("invalid source credential")
	}
	if token != "" {
		r.Header.Set("Authorization", "Bearer "+token)
	}
	for k, v := range auth.Headers {
		r.Header.Set(k, v)
	}
	for k, name := range auth.HeaderEnv {
		value := os.Getenv(name)
		if value == "" {
			return fmt.Errorf("source header credential environment variable is not set")
		}
		if strings.ContainsAny(value, "\r\n") {
			return fmt.Errorf("invalid source header")
		}
		r.Header.Set(k, value)
	}
	return nil
}
func (a *App) metadataSource(kind string, next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx, _, err := a.bindSource(r.Context(), kind, r.URL.Query().Get("sourceId"))
		if err != nil {
			fail(w, 400, err.Error())
			return
		}
		next(w, r.WithContext(ctx))
	}
}
