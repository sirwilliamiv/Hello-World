package render

import (
	"path/filepath"
	"sort"

	"github.com/originplatformlabs/forge/internal/manifest"
	"github.com/originplatformlabs/forge/internal/state"
)

// productTemplate is a file belonging to the application skeleton rather than to
// any one capability.
type productTemplate struct {
	id      string
	output  string
	zone    state.Zone
	comment bool // true when the file's syntax supports a // header
}

// productTemplates is the application skeleton.
//
// The zone split here is the whole generated/custom boundary in miniature.
// Files derived from the resolved graph — the package list, the migration
// order, the env schema — are managed, because they must change when
// capabilities change. Files a developer will legitimately edit on day one —
// the root layout, tsconfig, .gitignore — are seeded once and then belong to
// the client, so editing them is not drift.
var productTemplates = []productTemplate{
	{"package.json", "package.json", state.ZoneManaged, false},
	{"next.config.ts", "next.config.ts", state.ZoneManaged, true},
	{"drizzle.config.ts", "drizzle.config.ts", state.ZoneManaged, true},
	{"migrate.ts", "scripts/migrate.ts", state.ZoneManaged, true},
	{"tsconfig.json", "tsconfig.json", state.ZoneSeeded, false},
	{"layout.tsx", "src/app/layout.tsx", state.ZoneSeeded, true},
	{"gitignore", ".gitignore", state.ZoneSeeded, false},
	{"env.example", ".env.example", state.ZoneSeeded, false},
}

// clientTemplates are files derived from the CLIENT's declared data model
// rather than from any capability.
//
// The separation is not accounting: the 400-line budget exists because
// generated lines must be three-way merged when a CAPABILITY upgrades, and
// these files do not change when a capability upgrades — they change when the
// manifest changes, which is an edit we author rather than one a client makes.
// Measuring them against a capability's budget hid that distinction and made
// kernel.data appear to breach at 664 lines for a 12-entity client.
//
// They are still managed files that a developer can hand-edit, so they are
// still hash-tracked and still report drift. What changes is only which budget
// they are held to.
var clientTemplates = []productTemplate{
	{"client-entities.ts", "src/generated/kernel.data/client-entities.ts", state.ZoneManaged, true},
	{"client-entities.sql", "migrations/client/0001_client_entities.sql", state.ZoneManaged, false},
}

// Client renders the manifest-declared data model.
func (r *Renderer) Client(m *manifest.Manifest, env string, facts GraphFacts) ([]Rendered, error) {
	in := Inputs{
		Product: m.Product, Environment: env, Branding: m.Branding,
		Config: map[string]any{}, Entities: m.Entities, Graph: facts,
	}
	hash := productInputsHash(in)

	var out []Rendered
	for _, t := range clientTemplates {
		body, err := r.renderFile("_client", t.id, in)
		if err != nil {
			return nil, err
		}
		content := body
		if t.comment {
			content = append(productHeader(), body...)
		}
		out = append(out, Rendered{
			Path: t.output, Zone: t.zone, Capability: "<client>",
			Template: t.id, TemplateVersion: "1.0.0", Content: content, InputsHash: hash,
		})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Path < out[j].Path })
	return out, nil
}

// Product renders the application skeleton.
//
// package.json is managed because its dependency list is derived from the
// resolved graph: adding a capability must add its package. The cost is that a
// client adding their own dependency registers as drift, which `forge eject
// package.json` resolves at the price of no longer receiving capability
// packages automatically. A manifest-level `dependencies` block would remove
// that trade-off and is the right Phase 2 fix.
func (r *Renderer) Product(m *manifest.Manifest, env string, facts GraphFacts) ([]Rendered, error) {
	in := Inputs{
		Product: m.Product, Environment: env, Branding: m.Branding,
		Config: map[string]any{}, Entities: m.Entities, Graph: facts,
	}
	hash := productInputsHash(in)

	var out []Rendered
	for _, t := range productTemplates {
		body, err := r.renderProductFile(t.id, in)
		if err != nil {
			return nil, err
		}
		content := body
		if t.zone == state.ZoneManaged && t.comment {
			content = append(productHeader(), body...)
		}
		out = append(out, Rendered{
			Path: t.output, Zone: t.zone, Capability: "<product>",
			Template: t.id, TemplateVersion: "1.0.0", Content: content, InputsHash: hash,
		})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Path < out[j].Path })
	return out, nil
}

func (r *Renderer) renderProductFile(id string, in Inputs) ([]byte, error) {
	return r.renderFile("_product", id, in)
}

// productHeader marks a managed file and names the alternative. Product and
// client files have no slots, so the sanctioned route is the manifest for
// anything the manifest expresses, and per-file ejection for anything it does
// not. Saying only "do not edit" without saying what to do instead produces a
// warning people route around.
func productHeader() []byte {
	return []byte(
		"// ┌───────────────────────────────────────────────────────────────────┐\n" +
			"// │ GENERATED BY FORGE — DO NOT EDIT                                   │\n" +
			"// │ Derived from the manifest and the resolved capability graph.       │\n" +
			"// │ Edits are reported by `forge drift` and will conflict on upgrade.  │\n" +
			"// │ Change the manifest and re-apply, or `forge eject <path>` to take  │\n" +
			"// │ ownership of this file permanently.                                │\n" +
			"// └───────────────────────────────────────────────────────────────────┘\n\n")
}

func productInputsHash(in Inputs) string {
	return inputsHashOf(struct {
		Product     manifest.Product
		Environment string
		Branding    *manifest.Branding
		Graph       GraphFacts
		Entities    []manifest.Entity
	}{in.Product, in.Environment, in.Branding, in.Graph, in.Entities})
}

// TemplatePath returns where a capability's template file lives on disk.
func (r *Renderer) TemplatePath(capID, templateID string) string {
	return filepath.Join(r.root, capID, templateID+".tmpl")
}
