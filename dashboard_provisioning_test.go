package main

import (
	"encoding/json"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeDashboardFile(t *testing.T, path, id string) {
	t.Helper()
	d := testDashboard()
	d.ID = id
	b, _ := json.Marshal(d)
	if err := os.WriteFile(path, b, 0600); err != nil {
		t.Fatal(err)
	}
}
func TestDashboardProvisioningReloadValidationAndIsolation(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "overview.json")
	writeDashboardFile(t, file, "overview")
	if err := os.WriteFile(filepath.Join(dir, "broken.json"), []byte(`{"version":1}`), 0600); err != nil {
		t.Fatal(err)
	}
	writeDashboardFile(t, filepath.Join(dir, "duplicate.json"), "overview")
	writeDashboardFile(t, filepath.Join(dir, "ignored.txt"), "ignore")
	catalog := loadDashboardCatalog(dir)
	if len(catalog.Dashboards) != 1 || len(catalog.Errors) != 2 {
		t.Fatal(catalog)
	}
	writeDashboardFile(t, file, "changed")
	catalog = loadDashboardCatalog(dir)
	if len(catalog.Dashboards) != 2 || catalog.Dashboards[1].ID != "changed" {
		t.Fatal(catalog)
	}
	outside := filepath.Join(t.TempDir(), "secret.json")
	writeDashboardFile(t, outside, "outside")
	if err := os.Symlink(outside, filepath.Join(dir, "external.json")); err != nil {
		t.Fatal(err)
	}
	// ConfigMap-style projection links must continue to work.
	nested := filepath.Join(dir, "..data-version")
	os.Mkdir(nested, 0700)
	writeDashboardFile(t, filepath.Join(nested, "projected.json"), "projected")
	if err := os.Symlink(filepath.Join("..data-version", "projected.json"), filepath.Join(dir, "mounted.json")); err != nil {
		t.Fatal(err)
	}
	catalog = loadDashboardCatalog(dir)
	if len(catalog.Dashboards) != 3 || !strings.Contains(strings.Join(catalog.Errors, " "), "must remain inside") {
		t.Fatal(catalog)
	}
}
func TestProvisionedDashboardsHaveNoMutationAPI(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "overview.json")
	writeDashboardFile(t, file, "overview")
	t.Setenv("DASHBOARDS_DIR", dir)
	before, _ := os.ReadFile(file)
	a := newTestApp()
	get := httptest.NewRecorder()
	a.handler().ServeHTTP(get, httptest.NewRequest("GET", "/api/dashboards", nil))
	if get.Code != 200 || !strings.Contains(get.Body.String(), `"id":"overview"`) {
		t.Fatal(get.Code, get.Body)
	}
	for _, method := range []string{"DELETE", "PUT", "POST", "PATCH"} {
		w := httptest.NewRecorder()
		a.handler().ServeHTTP(w, httptest.NewRequest(method, "/api/dashboards", strings.NewReader(`{}`)))
		if w.Code < 400 {
			t.Fatal("mutable catalog", method, w.Code)
		}
	}
	after, _ := os.ReadFile(file)
	if string(before) != string(after) {
		t.Fatal("provisioned file changed")
	}
}
func TestDashboardProvisioningMissingDirectoryAndSizeLimit(t *testing.T) {
	if catalog := loadDashboardCatalog(filepath.Join(t.TempDir(), "missing")); len(catalog.Dashboards) != 0 || len(catalog.Errors) != 0 {
		t.Fatal(catalog)
	}
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "large.json"), []byte(strings.Repeat("x", provisionedDashboardFileLimit+1)), 0600)
	catalog := loadDashboardCatalog(dir)
	if len(catalog.Dashboards) != 0 || len(catalog.Errors) != 1 {
		t.Fatal(catalog)
	}
}
