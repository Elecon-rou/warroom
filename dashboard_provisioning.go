package main

import (
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

const provisionedDashboardLimit = 50
const provisionedDashboardFileLimit = 512 << 10
const provisionedDashboardTotalLimit = 8 << 20

type dashboardCatalog struct {
	Dashboards []Dashboard `json:"dashboards"`
	Errors     []string    `json:"errors"`
}

// This API only reads operator-managed files. There is no dashboard write/delete API.
// Reload on each request so atomically replaced files and ConfigMap mounts are visible.
func loadDashboardCatalog(directory string) dashboardCatalog {
	catalog := dashboardCatalog{Dashboards: []Dashboard{}, Errors: []string{}}
	if directory == "" {
		return catalog
	}
	root, err := filepath.Abs(directory)
	if err == nil {
		root, err = filepath.EvalSymlinks(root)
	}
	if os.IsNotExist(err) {
		return catalog
	}
	if err != nil {
		catalog.Errors = append(catalog.Errors, "Dashboard directory is unavailable.")
		return catalog
	}
	entries, err := os.ReadDir(root)
	if err != nil {
		catalog.Errors = append(catalog.Errors, "Dashboard directory cannot be read.")
		return catalog
	}
	seen := map[string]bool{}
	total := 0
	count := 0
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(strings.ToLower(entry.Name()), ".json") {
			continue
		}
		count++
		if count > provisionedDashboardLimit {
			catalog.Errors = append(catalog.Errors, "Dashboard file limit (50) reached.")
			break
		}
		name := entry.Name()
		// Allow in-directory links (including Kubernetes ConfigMap projections), but
		// never follow one to a file outside the configured directory.
		path, err := filepath.EvalSymlinks(filepath.Join(root, name))
		if err != nil {
			catalog.Errors = append(catalog.Errors, name+": cannot read file.")
			continue
		}
		relative, err := filepath.Rel(root, path)
		if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
			catalog.Errors = append(catalog.Errors, name+": file must remain inside the dashboard directory.")
			continue
		}
		info, err := os.Stat(path)
		if err != nil || !info.Mode().IsRegular() {
			catalog.Errors = append(catalog.Errors, name+": expected a regular JSON file.")
			continue
		}
		f, err := os.Open(path)
		if err != nil {
			catalog.Errors = append(catalog.Errors, name+": cannot read file.")
			continue
		}
		info, err = f.Stat()
		if err != nil || !info.Mode().IsRegular() {
			f.Close()
			catalog.Errors = append(catalog.Errors, name+": expected a regular JSON file.")
			continue
		}
		data, err := io.ReadAll(io.LimitReader(f, provisionedDashboardFileLimit+1))
		f.Close()
		if err != nil || len(data) > provisionedDashboardFileLimit {
			catalog.Errors = append(catalog.Errors, name+": file exceeds 512 KiB or could not be read.")
			continue
		}
		total += len(data)
		if total > provisionedDashboardTotalLimit {
			catalog.Errors = append(catalog.Errors, "Dashboard data limit (8 MiB) reached.")
			break
		}
		dashboard, err := parseDashboard(string(data))
		if err != nil {
			catalog.Errors = append(catalog.Errors, fmt.Sprintf("%s: %v", name, err))
			continue
		}
		if seen[dashboard.ID] {
			catalog.Errors = append(catalog.Errors, name+": duplicate dashboard id; file ignored.")
			continue
		}
		seen[dashboard.ID] = true
		catalog.Dashboards = append(catalog.Dashboards, dashboard)
	}
	return catalog
}
func (a *App) provisionedDashboards(w http.ResponseWriter, r *http.Request) {
	send(w, 200, loadDashboardCatalog(os.Getenv("DASHBOARDS_DIR")))
}
