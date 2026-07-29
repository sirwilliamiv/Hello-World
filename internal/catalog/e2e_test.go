package catalog_test

import (
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/originplatformlabs/forge/internal/catalog"
	"github.com/originplatformlabs/forge/internal/manifest"
	"github.com/originplatformlabs/forge/internal/resolve"
	"github.com/originplatformlabs/forge/internal/validate"
)

// repoRoot locates the repository from this test file's own path, so the tests
// do not depend on the working directory.
func repoRoot(t *testing.T) string {
	t.Helper()
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("cannot determine test file location")
	}
	return filepath.Join(filepath.Dir(file), "..", "..")
}

func loadRealCatalog(t *testing.T) *catalog.Catalog {
	t.Helper()
	root := repoRoot(t)
	cat, ds, err := catalog.Load(
		filepath.Join(root, "catalog"),
		filepath.Join(root, "schemas", "capability.schema.json"),
	)
	if err != nil {
		t.Fatalf("load catalog: %v", err)
	}
	if ds.HasErrors() {
		for _, d := range ds.Sorted() {
			t.Errorf("%s", d)
		}
		t.Fatalf("the shipped catalog must validate against its own schema")
	}
	return cat
}

// The shipped catalog must always validate against the shipped schema. This is
// the check that stops a hand-edited specification reaching a client.
func TestShippedCatalogValidatesAgainstSchema(t *testing.T) {
	cat := loadRealCatalog(t)
	if cat.Len() == 0 {
		t.Fatal("catalog is empty")
	}
	if len(cat.Kernel()) != 11 {
		t.Errorf("kernel has %d capabilities, want 11", len(cat.Kernel()))
	}
	for _, c := range cat.Selectable() {
		if c.Trigger == "" {
			t.Errorf("%s is sellable but has no buyer-facing trigger sentence", c.ID)
		}
		if c.Price.Model == "fixed" && c.Price.AmountMinor == 0 {
			t.Errorf("%s has a fixed price model but no amount", c.ID)
		}
	}
}

// Every kernel capability a selectable one depends on must exist, or the
// catalog cannot compose anything.
func TestEveryDependencyResolvesWithinTheCatalog(t *testing.T) {
	cat := loadRealCatalog(t)
	for _, id := range cat.IDs() {
		c, _ := cat.Get(id)
		for _, r := range c.Requires {
			if _, ok := cat.Get(r.ID); !ok {
				t.Errorf("%s requires %s, which is not in the catalog", c.ID, r.ID)
			}
		}
		if c.Upgrades != nil {
			if _, ok := cat.Get(c.Upgrades.ID); !ok {
				t.Errorf("%s upgrades %s, which is not in the catalog", c.ID, c.Upgrades.ID)
			}
		}
	}
}

// The Phase 1 reference product: two capabilities selected, three resolved
// transitively, and one kernel capability superseded by an upgrade. If this
// composes correctly the engine composes the catalog.
func TestPhase1ReferenceProductResolvesAndValidates(t *testing.T) {
	root := repoRoot(t)
	cat := loadRealCatalog(t)

	m, ds, err := manifest.Load(
		filepath.Join(root, "examples", "phase1", "forge.yaml"),
		filepath.Join(root, "schemas", "manifest.schema.json"),
	)
	if err != nil {
		t.Fatalf("load manifest: %v", err)
	}
	if ds.HasErrors() {
		for _, d := range ds.Sorted() {
			t.Errorf("%s", d)
		}
		t.Fatal("the reference manifest must validate against its schema")
	}

	g, rds := resolve.Resolve(m, cat)
	for _, d := range rds.Sorted() {
		t.Errorf("resolve: %s", d)
	}
	for _, d := range validate.Run(m, g).Sorted() {
		t.Errorf("validate: %s", d)
	}

	// pay.invoices -> docs.generation -> data.files -> ops.queue. None of the
	// three intermediates is named in the manifest.
	for _, id := range []string{"docs.generation", "data.files", "ops.queue"} {
		if !g.Has(id) {
			t.Fatalf("%s should have been resolved transitively", id)
		}
		if g.Nodes[id].Selected {
			t.Errorf("%s must not be marked selected; it was not named in the manifest", id)
		}
	}
	if got, want := g.Nodes["ops.queue"].ReasonString(),
		"pay.invoices -> docs.generation -> data.files -> ops.queue"; got != want {
		t.Errorf("reason chain = %q, want %q", got, want)
	}

	// ops.queue supersedes kernel.work, and the interface check must pass:
	// enqueue() and schedule() keep working for every existing caller.
	if !g.Nodes["kernel.work"].Superseded() {
		t.Error("kernel.work should be superseded by ops.queue")
	}
	if got := g.Nodes["kernel.work"].SupersededBy; got != "ops.queue" {
		t.Errorf("SupersededBy = %q, want ops.queue", got)
	}
}

// Apply order and diagnostics must be byte-stable across runs. Go randomises
// map iteration, so this would regress silently without a test.
func TestPhase1ResolutionIsDeterministic(t *testing.T) {
	root := repoRoot(t)
	cat := loadRealCatalog(t)
	m, _, err := manifest.Load(
		filepath.Join(root, "examples", "phase1", "forge.yaml"),
		filepath.Join(root, "schemas", "manifest.schema.json"),
	)
	if err != nil {
		t.Fatalf("load manifest: %v", err)
	}

	first, _ := resolve.Resolve(m, cat)
	want := strings.Join(first.Order, ",")
	for i := 0; i < 25; i++ {
		g, _ := resolve.Resolve(m, cat)
		if got := strings.Join(g.Order, ","); got != want {
			t.Fatalf("apply order differs between runs:\n  run 0: %s\n  run %d: %s", want, i+1, got)
		}
	}
}

// The annotated reference manifest ships as documentation, so it must stay
// loadable even though its capability set is not yet in the catalog.
func TestAnnotatedManifestParsesAgainstSchema(t *testing.T) {
	root := repoRoot(t)
	_, ds, err := manifest.Load(
		filepath.Join(root, "examples", "acme.forge.yaml"),
		filepath.Join(root, "schemas", "manifest.schema.json"),
	)
	if err != nil {
		t.Fatalf("load manifest: %v", err)
	}
	if ds.HasErrors() {
		for _, d := range ds.Sorted() {
			t.Errorf("%s", d)
		}
		t.Fatal("examples/acme.forge.yaml must validate against the manifest schema")
	}
}
