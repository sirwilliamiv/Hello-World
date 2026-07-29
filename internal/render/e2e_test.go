package render_test

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/originplatformlabs/forge/internal/catalog"
	"github.com/originplatformlabs/forge/internal/manifest"
	"github.com/originplatformlabs/forge/internal/plan"
	"github.com/originplatformlabs/forge/internal/provider/codegen"
	"github.com/originplatformlabs/forge/internal/render"
	"github.com/originplatformlabs/forge/internal/resolve"
	"github.com/originplatformlabs/forge/internal/state"
)

// generationBudget is the per-capability limit from ARCHITECTURE.md section 4.
// Every generated line is a line that may be hand-edited and must later be
// three-way merged, so the budget is a real constraint rather than a guideline.
const generationBudget = 400

func repoRoot(t *testing.T) string {
	t.Helper()
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("cannot locate test file")
	}
	return filepath.Join(filepath.Dir(file), "..", "..")
}

// renderAll runs the full desired-state pipeline for a manifest.
func renderAll(t *testing.T, manifestPath string) ([]render.Rendered, *manifest.Manifest) {
	t.Helper()
	root := repoRoot(t)

	cat, ds, err := catalog.Load(filepath.Join(root, "catalog"),
		filepath.Join(root, "schemas", "capability.schema.json"))
	if err != nil || ds.HasErrors() {
		t.Fatalf("catalog: %v %v", err, ds.Items())
	}
	m, mds, err := manifest.Load(manifestPath, filepath.Join(root, "schemas", "manifest.schema.json"))
	if err != nil || mds.HasErrors() {
		t.Fatalf("manifest: %v %v", err, mds.Items())
	}
	g, rds := resolve.Resolve(m, cat)
	if rds.HasErrors() {
		t.Fatalf("resolve: %v", rds.Items())
	}

	r := render.New(filepath.Join(root, "templates"))
	facts := render.BuildGraphFacts(m, g)

	out, err := r.Product(m, "development", facts)
	if err != nil {
		t.Fatalf("product: %v", err)
	}
	clientFiles, err := r.Client(m, "development", facts)
	if err != nil {
		t.Fatalf("client: %v", err)
	}
	out = append(out, clientFiles...)
	for _, n := range g.Active() {
		files, err := r.Capability(m, "development", n, facts)
		if err != nil {
			t.Fatalf("capability %s: %v", n.Cap.ID, err)
		}
		out = append(out, files...)
	}
	return out, m
}

func phase1Manifest(t *testing.T) string {
	return filepath.Join(repoRoot(t), "examples", "phase1", "forge.yaml")
}

// Identical manifest plus identical versions must produce byte-identical output,
// or a client that is down cannot be debugged.
func TestRenderingIsByteIdenticalAcrossRuns(t *testing.T) {
	first, _ := renderAll(t, phase1Manifest(t))
	for i := 0; i < 10; i++ {
		again, _ := renderAll(t, phase1Manifest(t))
		if len(again) != len(first) {
			t.Fatalf("file count differs: %d vs %d", len(first), len(again))
		}
		for j := range first {
			if first[j].Path != again[j].Path {
				t.Fatalf("path order differs at %d: %s vs %s", j, first[j].Path, again[j].Path)
			}
			if !bytes.Equal(first[j].Content, again[j].Content) {
				t.Fatalf("content differs for %s on run %d", first[j].Path, i)
			}
		}
	}
}

// Applying twice must be a no-op. This is the single most important Phase 1
// signal: without it, nothing downstream can be trusted.
func TestApplyIsIdempotent(t *testing.T) {
	target := t.TempDir()
	desired, m := renderAll(t, phase1Manifest(t))
	s := state.New(m.Product.ID+"/development", "0.1.0")
	cg := codegen.New()

	first, err := plan.Compute(target, s, desired)
	if err != nil {
		t.Fatal(err)
	}
	if !first.HasChanges() {
		t.Fatal("the first apply against an empty directory must have changes")
	}
	for _, a := range first.Actions {
		if err := cg.Apply(target, a); err != nil {
			t.Fatalf("apply %s: %v", a.Path, err)
		}
		if a.Verb == plan.Create || a.Verb == plan.Update {
			f := state.File{Path: a.Path, Zone: a.Zone, Capability: a.Capability, Template: a.Template}
			if a.Zone == state.ZoneManaged {
				f.GeneratedHash = state.Hash(a.Content)
			}
			s.SetFile(f)
		}
	}

	second, err := plan.Compute(target, s, desired)
	if err != nil {
		t.Fatal(err)
	}
	if second.HasChanges() {
		for _, a := range second.Actions {
			if a.Verb == plan.Create || a.Verb == plan.Update || a.Verb == plan.Delete {
				t.Errorf("second apply would %s %s", a.Verb, a.Path)
			}
		}
		t.Fatal("apply is not idempotent")
	}
	if second.HasDrift() {
		t.Fatal("a freshly applied product must have no drift")
	}
}

// Every managed file must announce itself and name the sanctioned alternative.
// A generated-code warning that does not say where to put your change is a
// warning people route around.
func TestManagedFilesCarryAWarningAndNameAnAlternative(t *testing.T) {
	desired, _ := renderAll(t, phase1Manifest(t))
	checked := 0
	for _, d := range desired {
		if d.Zone != state.ZoneManaged {
			continue
		}
		// JSON has no comment syntax; the rest must carry the banner.
		if strings.HasSuffix(d.Path, ".json") || strings.HasSuffix(d.Path, ".sql") ||
			strings.HasSuffix(d.Path, ".css") {
			continue
		}
		checked++
		body := string(d.Content)
		if !strings.Contains(body, "GENERATED BY FORGE") {
			t.Errorf("%s carries no generated-code banner", d.Path)
		}
		if !strings.Contains(body, "forge drift") {
			t.Errorf("%s does not tell the reader how edits are detected", d.Path)
		}
		if !strings.Contains(body, "slot") && !strings.Contains(body, "eject") {
			t.Errorf("%s does not name a sanctioned alternative to editing it", d.Path)
		}
	}
	if checked == 0 {
		t.Fatal("no managed files were checked")
	}
}

// Seeded files must NOT carry the banner: they belong to the client the moment
// they are written, and telling someone not to edit their own file is wrong.
func TestSeededFilesCarryNoDoNotEditBanner(t *testing.T) {
	desired, _ := renderAll(t, phase1Manifest(t))
	for _, d := range desired {
		if d.Zone != state.ZoneSeeded {
			continue
		}
		if strings.Contains(string(d.Content), "DO NOT EDIT") {
			t.Errorf("%s is seeded and belongs to the client; it must not say DO NOT EDIT", d.Path)
		}
	}
}

// The generation budget, enforced rather than asserted in prose.
//
// Client-derived output is measured separately: it changes when the manifest
// changes, not when a capability upgrades, so it does not carry the merge risk
// the budget exists to bound.
func TestGeneratedCodeStaysWithinTheBudget(t *testing.T) {
	desired, _ := renderAll(t, phase1Manifest(t))
	lines := map[string]int{}
	for _, d := range desired {
		if d.Zone != state.ZoneManaged {
			continue
		}
		lines[d.Capability] += bytes.Count(d.Content, []byte("\n"))
	}
	for cap, n := range lines {
		if cap == "<client>" || cap == "<product>" || cap == "<graph>" {
			continue
		}
		if n > generationBudget {
			t.Errorf("%s generates %d lines, over the %d-line budget; move the excess "+
				"into its npm package behind config or a slot, or declare a reviewed waiver",
				cap, n, generationBudget)
		}
	}
	if len(lines) == 0 {
		t.Fatal("no managed output was measured")
	}
}

// Capability output must not scale with the client's data model. It scaling was
// the concern flagged in ARCHITECTURE.md section 9.1, and this is the test that
// keeps the fix honest.
func TestCapabilityOutputDoesNotScaleWithClientEntities(t *testing.T) {
	base, _ := renderAll(t, phase1Manifest(t))

	// Same manifest plus twelve client entities.
	src, err := os.ReadFile(phase1Manifest(t))
	if err != nil {
		t.Fatal(err)
	}
	var b strings.Builder
	b.WriteString("entities:\n")
	for i := 0; i < 12; i++ {
		fmt.Fprintf(&b, "  - name: Entity%d\n    fields:\n", i)
		for j := 0; j < 8; j++ {
			fmt.Fprintf(&b, "      - { name: field_%d, type: string }\n", j)
		}
	}
	b.WriteString("\nintegrations:")
	scaled := strings.Replace(string(src), "integrations:", b.String(), 1)

	dir := t.TempDir()
	scaledPath := filepath.Join(dir, "forge.yaml")
	if err := os.WriteFile(scaledPath, []byte(scaled), 0o644); err != nil {
		t.Fatal(err)
	}
	withEntities, _ := renderAll(t, scaledPath)

	count := func(files []render.Rendered) map[string]int {
		out := map[string]int{}
		for _, d := range files {
			if d.Zone == state.ZoneManaged {
				out[d.Capability] += bytes.Count(d.Content, []byte("\n"))
			}
		}
		return out
	}
	a, c := count(base), count(withEntities)

	if c["<client>"] <= a["<client>"] {
		t.Error("client-derived output should grow with the client's data model")
	}
	for cap, before := range a {
		if cap == "<client>" || cap == "<product>" || cap == "<graph>" {
			continue
		}
		if grown := c[cap] - before; grown > 50 {
			t.Errorf("%s grew %d lines for 12 client entities; capability output must be "+
				"flat against the client data model or the budget cannot hold", cap, grown)
		}
		if c[cap] > generationBudget {
			t.Errorf("%s exceeds the budget at %d lines with 12 client entities", cap, c[cap])
		}
	}
}

// Templates must not reach for anything outside the closed input set.
func TestTemplatesReferenceNoAmbientState(t *testing.T) {
	root := filepath.Join(repoRoot(t), "templates")
	banned := []string{"os.Getenv", "time.Now", "rand.", "Date.now"}
	err := filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
		if err != nil || info.IsDir() || !strings.HasSuffix(path, ".tmpl") {
			return err
		}
		b, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		for _, bad := range banned {
			if bytes.Contains(b, []byte(bad)) {
				t.Errorf("%s references %q; rendering must be deterministic", path, bad)
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}
