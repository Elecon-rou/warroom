package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

const maxDashboardVariables = 20
const allVariableValues = "$__all"

var dashboardVariableName = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]{0,63}$`)
var dashboardVariableReference = regexp.MustCompile(`\$\$|\$(?:\{([A-Za-z_][A-Za-z0-9_]*)(?::[a-z]+)?\}|([A-Za-z_][A-Za-z0-9_]*))`)

type DashboardVariable struct {
	Name       string   `json:"name"`
	Label      string   `json:"label,omitempty"`
	Type       string   `json:"type"`
	Source     string   `json:"source,omitempty"`
	SourceID   string   `json:"sourceId,omitempty"`
	Query      string   `json:"query,omitempty"`
	Options    []string `json:"options,omitempty"`
	Current    []string `json:"current,omitempty"`
	Multi      bool     `json:"multi,omitempty"`
	IncludeAll bool     `json:"includeAll,omitempty"`
}

func validateDashboardVariables(variables []DashboardVariable) error {
	if len(variables) > maxDashboardVariables {
		return fmt.Errorf("A dashboard supports at most %d variables.", maxDashboardVariables)
	}
	seen := map[string]bool{}
	for _, v := range variables {
		if !dashboardVariableName.MatchString(v.Name) || strings.HasPrefix(v.Name, "__") || seen[v.Name] || len(v.Label) > 120 || !oneOf(v.Type, "custom", "textbox", "query") {
			return fmt.Errorf("Invalid or duplicate dashboard variable: %s.", v.Name)
		}
		if len(v.Options) > 200 || len(v.Current) > 20 || (!v.Multi && len(v.Current) > 1) {
			return fmt.Errorf("Invalid option/selection count for variable %s.", v.Name)
		}
		for _, values := range [][]string{v.Options, v.Current} {
			unique := map[string]bool{}
			for _, value := range values {
				if len(value) > 1024 || unique[value] {
					return fmt.Errorf("Invalid or duplicate value for variable %s.", v.Name)
				}
				unique[value] = true
			}
		}
		for _, value := range v.Options {
			if value == allVariableValues {
				return fmt.Errorf("Reserved All option in variable %s.", v.Name)
			}
		}
		for _, value := range v.Current {
			if value == allVariableValues && (!v.IncludeAll || len(v.Current) != 1) {
				return fmt.Errorf("Invalid All selection for variable %s.", v.Name)
			}
			if v.Type == "custom" && value != allVariableValues && !oneOf(value, v.Options...) {
				return fmt.Errorf("Selection is not an option for variable %s.", v.Name)
			}
		}
		if v.Type == "custom" && len(v.Options) == 0 {
			return fmt.Errorf("Variable %s needs at least one option.", v.Name)
		}
		if v.Type == "textbox" && (v.Multi || v.IncludeAll) {
			return fmt.Errorf("Text variable %s must have a single value.", v.Name)
		}
		if v.Type == "query" {
			if !oneOf(v.Source, "metrics", "logs", "traces") || !dashboardText(v.Query, 4000) {
				return fmt.Errorf("Variable %s needs a source and option query.", v.Name)
			}
			for _, match := range dashboardVariableReference.FindAllStringSubmatch(v.Query, -1) {
				name := match[1]
				if name == "" {
					name = match[2]
				}
				if name == "" {
					continue
				}
				if !strings.HasPrefix(name, "__") && !seen[name] {
					return fmt.Errorf("Variable %s must follow its dependency %s.", v.Name, name)
				}
			}
		}
		seen[v.Name] = true
	}
	return nil
}

// Query variables use bounded native discovery APIs, never arbitrary URLs or LLMs.
func (a *App) dashboardVariableOptions(w http.ResponseWriter, r *http.Request) {
	var q struct {
		Kind     string  `json:"kind"`
		SourceID string  `json:"sourceId"`
		Query    string  `json:"query"`
		Start    float64 `json:"start"`
		End      float64 `json:"end"`
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 32<<10))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&q) != nil || decoder.Decode(new(any)) != io.EOF || !finite(q.Start) || !finite(q.End) || q.Start <= 0 || q.End <= q.Start || q.End-q.Start > 31*86400 || !dashboardText(q.Query, 4000) {
		fail(w, 400, "Invalid dashboard variable query or time range.")
		return
	}
	requestCtx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	ctx, _, err := a.bindSource(requestCtx, q.Kind, q.SourceID)
	if err != nil {
		fail(w, 400, err.Error())
		return
	}
	query := strings.TrimSpace(q.Query)
	params := url.Values{"start": {strconv.FormatFloat(q.Start, 'f', 3, 64)}, "end": {strconv.FormatFloat(q.End, 'f', 3, 64)}}
	delegated := r.Clone(ctx)
	delegated.Method = "GET"
	delegated.URL = &url.URL{RawQuery: params.Encode()}
	switch q.Kind {
	case "metrics":
		label, selector := "", ""
		if query == "metrics()" {
			label = "__name__"
		} else if strings.HasPrefix(query, "label_values(") && strings.HasSuffix(query, ")") {
			body := strings.TrimSpace(query[len("label_values(") : len(query)-1])
			comma := strings.LastIndex(body, ",")
			if comma < 0 {
				label = body
			} else {
				selector = strings.TrimSpace(body[:comma])
				label = strings.TrimSpace(body[comma+1:])
			}
		}
		if !labelIdentifier.MatchString(label) {
			fail(w, 400, "Use label_values(label), label_values(selector, label), or metrics().")
			return
		}
		params.Set("limit", "201")
		if selector != "" {
			params.Set("match[]", selector)
		}
		data, err := a.upstream(ctx, "metrics", "/api/v1/label/"+label+"/values", params)
		if err != nil {
			fail(w, 502, err.Error())
			return
		}
		var result struct {
			Status string   `json:"status"`
			Data   []string `json:"data"`
		}
		if json.Unmarshal(data, &result) != nil || result.Status != "success" {
			fail(w, 502, "Invalid metric variable options response.")
			return
		}
		values := []string{}
		seen := map[string]bool{}
		for _, value := range result.Data {
			if len(value) <= 1024 && value != allVariableValues && !seen[value] {
				values = append(values, value)
				seen[value] = true
			}
		}
		sort.Strings(values)
		truncated := len(values) > 200
		if truncated {
			values = values[:200]
		}
		send(w, 200, map[string]any{"data": values, "truncated": truncated})
	case "logs":
		if !strings.HasPrefix(query, "field_values(") || !strings.HasSuffix(query, ")") {
			fail(w, 400, "Use field_values(field) or field_values(field, LogsQL filter).")
			return
		}
		parts := strings.SplitN(query[len("field_values("):len(query)-1], ",", 2)
		field := strings.TrimSpace(parts[0])
		if unquoted, e := strconv.Unquote(field); e == nil {
			field = unquoted
		}
		params.Set("type", "values")
		params.Set("field", field)
		if len(parts) > 1 {
			params.Set("query", strings.TrimSpace(parts[1]))
		}
		delegated.URL.RawQuery = params.Encode()
		a.logMetadata(w, delegated)
	case "traces":
		if query == "services()" {
			a.services(w, delegated)
			return
		}
		if !strings.HasPrefix(query, "operations(") || !strings.HasSuffix(query, ")") {
			fail(w, 400, "Use services() or operations(service).")
			return
		}
		service := strings.TrimSpace(query[len("operations(") : len(query)-1])
		if unquoted, e := strconv.Unquote(service); e == nil {
			service = unquoted
		}
		params.Set("service", service)
		delegated.URL.RawQuery = params.Encode()
		a.operations(w, delegated)
	}
}

// Apply this to completed LLM output only. Partial streamed widgets may arrive
// before their variable definitions and must remain visible as pending previews.
func validateGeneratedVariableReferences(d Dashboard) error {
	names := map[string]bool{}
	for _, name := range []string{"__from", "__to", "__range", "__range_s", "__range_ms", "__interval", "__interval_ms", "__rate_interval"} {
		names[name] = true
	}
	for _, variable := range d.Variables {
		names[variable.Name] = true
	}
	for _, widget := range d.Widgets {
		for _, text := range []string{widget.Query, widget.Title} {
			for _, match := range dashboardVariableReference.FindAllStringSubmatch(text, -1) {
				name := match[1]
				if name == "" {
					name = match[2]
				}
				if name != "" && !names[name] {
					return fmt.Errorf("Define dashboard variable %s before using it in %s.", name, widget.Title)
				}
			}
		}
	}
	return nil
}
