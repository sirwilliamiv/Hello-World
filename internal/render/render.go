// Package render turns templates plus resolved inputs into file content.
//
// Rendering takes only (template, template_version, resolved_inputs). No clock,
// no random source, no environment, no network. Identical inputs produce
// byte-identical output or a client that is down cannot be debugged.
package render

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"text/template"

	"github.com/originplatformlabs/forge/internal/manifest"
	"github.com/originplatformlabs/forge/internal/resolve"
	"github.com/originplatformlabs/forge/internal/spec"
	"github.com/originplatformlabs/forge/internal/state"
)

// Inputs is everything a template may see. It is a closed set on purpose: a
// template that could reach the filesystem or the clock would be
// non-deterministic, and determinism is the property the whole system rests on.
type Inputs struct {
	Product      manifest.Product
	Environment  string
	Branding     *manifest.Branding
	Capability   *spec.Capability
	Config       map[string]any
	Entities     []manifest.Entity
	Graph        GraphFacts
	Credentials  []string
	CapabilityID string
}

// GraphFacts are the resolved-graph projections templates need. Every slice is
// sorted, because Go randomises map iteration and unsorted output would produce
// a spurious diff on every run.
type GraphFacts struct {
	Active        []string
	Packages      []string
	Entities      []EntityFact
	Subscriptions []SubscriptionFact
	Permissions   []string
	NavItems      []NavFact
	Migrations    []MigrationFact
	EnvVars       []string
	SupersededBy  map[string]string
}

type EntityFact struct {
	Name         string
	Capability   string
	Kind         string
	TenantScoped bool
	AppendOnly   bool
	PersonalData bool
	Client       bool
	Fields       []manifest.Field
}

type SubscriptionFact struct {
	Event    string
	Consumer string
	Handler  string
	Versions []int
	Package  string
}

type NavFact struct {
	Label      string
	Path       string
	Group      string
	Order      int
	Permission string
}

type MigrationFact struct {
	Capability string
	ID         string
	Up         string
	Down       string
}

// Rendered is one file produced from one template.
type Rendered struct {
	Path            string
	Zone            state.Zone
	Capability      string
	Template        string
	TemplateVersion string
	Content         []byte
	InputsHash      string
}

// Renderer loads templates from a directory tree at templates/<capability>/.
type Renderer struct {
	root  string
	funcs template.FuncMap
}

func New(templatesRoot string) *Renderer {
	return &Renderer{root: templatesRoot, funcs: funcs()}
}

// BuildGraphFacts projects the resolved graph into the closed set of facts
// templates may read.
func BuildGraphFacts(m *manifest.Manifest, g *resolve.Graph) GraphFacts {
	f := GraphFacts{SupersededBy: map[string]string{}}

	for _, n := range g.Active() {
		f.Active = append(f.Active, n.Cap.ID)
		if n.Cap.Package != nil {
			f.Packages = append(f.Packages, n.Cap.Package.Name)
		}
		for _, e := range n.Cap.Owns {
			if e.Kind != "table" {
				continue
			}
			f.Entities = append(f.Entities, EntityFact{
				Name: e.Name, Capability: n.Cap.ID, Kind: e.Kind,
				TenantScoped: e.IsTenantScoped(), AppendOnly: e.AppendOnly,
				PersonalData: e.PersonalData,
			})
		}
		for _, c := range n.Cap.Consumes {
			if c.Handler == "" {
				continue
			}
			pkg := ""
			if n.Cap.Package != nil {
				pkg = n.Cap.Package.Name
			}
			f.Subscriptions = append(f.Subscriptions, SubscriptionFact{
				Event: c.Name, Consumer: n.Cap.ID, Handler: c.Handler,
				Versions: c.ContractVersions, Package: pkg,
			})
		}
		for _, r := range n.Cap.Registers {
			if !strings.HasSuffix(r.Registry, ":permissions") {
				continue
			}
			for _, entry := range r.Entries {
				if action, ok := entry["action"].(string); ok {
					f.Permissions = append(f.Permissions, action)
				}
			}
		}
		for _, s := range n.Cap.Surfaces {
			if s.Nav == nil || s.Path == "" {
				continue
			}
			f.NavItems = append(f.NavItems, NavFact{
				Label: s.Nav.Label, Path: s.Path, Group: s.Nav.Group,
				Order: s.Nav.Order, Permission: s.Permission,
			})
		}
		for _, mig := range n.Cap.Migrations {
			f.Migrations = append(f.Migrations, MigrationFact{
				Capability: n.Cap.ID, ID: mig.ID, Up: mig.Up, Down: mig.Down,
			})
		}
		for _, ext := range n.Cap.External {
			for _, cred := range ext.Credentials {
				f.EnvVars = append(f.EnvVars, cred.Name)
			}
		}
	}

	for _, n := range g.All() {
		if n.Superseded() {
			f.SupersededBy[n.Cap.ID] = n.SupersededBy
		}
	}

	for _, e := range m.Entities {
		f.Entities = append(f.Entities, EntityFact{
			Name: e.Name, Capability: "<client>", Kind: "table",
			TenantScoped: e.TenantScoped == nil || *e.TenantScoped,
			PersonalData: e.PersonalData, Client: true, Fields: e.Fields,
		})
	}

	// Sorting is load-bearing, not cosmetic.
	sort.Strings(f.Active)
	sort.Strings(f.Packages)
	sort.Strings(f.Permissions)
	f.Permissions = dedupe(f.Permissions)
	sort.Strings(f.EnvVars)
	f.EnvVars = dedupe(f.EnvVars)
	sort.Slice(f.Entities, func(i, j int) bool { return f.Entities[i].Name < f.Entities[j].Name })
	sort.Slice(f.Subscriptions, func(i, j int) bool {
		if f.Subscriptions[i].Event != f.Subscriptions[j].Event {
			return f.Subscriptions[i].Event < f.Subscriptions[j].Event
		}
		return f.Subscriptions[i].Consumer < f.Subscriptions[j].Consumer
	})
	sort.Slice(f.NavItems, func(i, j int) bool {
		if f.NavItems[i].Order != f.NavItems[j].Order {
			return f.NavItems[i].Order < f.NavItems[j].Order
		}
		return f.NavItems[i].Path < f.NavItems[j].Path
	})
	sort.Slice(f.Migrations, func(i, j int) bool {
		if f.Migrations[i].ID != f.Migrations[j].ID {
			return f.Migrations[i].ID < f.Migrations[j].ID
		}
		return f.Migrations[i].Capability < f.Migrations[j].Capability
	})
	return f
}

// Capability renders every template a capability declares.
func (r *Renderer) Capability(m *manifest.Manifest, env string, n *resolve.Node, facts GraphFacts) ([]Rendered, error) {
	var out []Rendered
	cfg := configFor(m, env, n.Cap)

	var creds []string
	for _, ext := range n.Cap.External {
		for _, c := range ext.Credentials {
			creds = append(creds, c.Name)
		}
	}
	sort.Strings(creds)

	in := Inputs{
		Product: m.Product, Environment: env, Branding: m.Branding,
		Capability: n.Cap, Config: cfg, Entities: m.Entities,
		Graph: facts, Credentials: creds, CapabilityID: n.Cap.ID,
	}
	hash := inputsHash(in)

	for _, t := range n.Cap.Templates {
		// A slot directory template seeds one stub per declared slot.
		if strings.HasSuffix(t.Output, "/") {
			files, err := r.slotStubs(n.Cap, t)
			if err != nil {
				return nil, err
			}
			for i := range files {
				files[i].InputsHash = hash
			}
			out = append(out, files...)
			continue
		}

		body, err := r.renderFile(n.Cap.ID, t.ID, in)
		if err != nil {
			return nil, err
		}
		content := body
		if state.Zone(t.Zone) == state.ZoneManaged {
			content = append(header(n.Cap, t), body...)
		}
		out = append(out, Rendered{
			Path: t.Output, Zone: state.Zone(t.Zone), Capability: n.Cap.ID,
			Template: t.ID, TemplateVersion: t.Version, Content: content, InputsHash: hash,
		})
	}
	return out, nil
}

// slotStubs seeds one file per declared slot. Seeded files carry no generated
// header: they belong to the client repository the moment they are written.
func (r *Renderer) slotStubs(c *spec.Capability, t spec.Template) ([]Rendered, error) {
	var out []Rendered
	for _, s := range c.Slots {
		var b bytes.Buffer
		fmt.Fprintf(&b, "import type { %s } from '%s'\n\n", s.Signature, packageOf(c))
		fmt.Fprintf(&b, "// Seeded by Forge from %s@%s. This file is yours —\n", c.ID, c.Version)
		fmt.Fprintf(&b, "// Forge will not modify it again.\n")
		if s.When != "" {
			fmt.Fprintf(&b, "//\n// Called %s.\n", s.When)
		}
		fmt.Fprintf(&b, "// %s\n\n", s.Description)
		fmt.Fprintf(&b, "export const %s: %s = async (ctx) => {\n", s.Name, s.Signature)
		fmt.Fprintf(&b, "  return ctx.proceed()\n}\n")

		out = append(out, Rendered{
			Path: filepath.Join(t.Output, s.Name+".ts"), Zone: state.ZoneSeeded,
			Capability: c.ID, Template: t.ID, TemplateVersion: t.Version,
			Content: b.Bytes(),
		})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Path < out[j].Path })
	return out, nil
}

func (r *Renderer) renderFile(capID, templateID string, in Inputs) ([]byte, error) {
	path := filepath.Join(r.root, capID, templateID+".tmpl")
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("template %s/%s: %w", capID, templateID, err)
	}
	t, err := template.New(templateID).Funcs(r.funcs).Option("missingkey=error").Parse(string(raw))
	if err != nil {
		return nil, fmt.Errorf("parse template %s/%s: %w", capID, templateID, err)
	}
	var b bytes.Buffer
	if err := t.Execute(&b, in); err != nil {
		return nil, fmt.Errorf("render template %s/%s: %w", capID, templateID, err)
	}
	return b.Bytes(), nil
}

// header marks a managed file and names the sanctioned alternative. A
// generated-code warning that does not say where to put your change is a
// warning people route around.
func header(c *spec.Capability, t spec.Template) []byte {
	alt := "eject it with `forge eject` if it must diverge"
	if len(c.Slots) > 0 {
		names := make([]string, 0, len(c.Slots))
		for _, s := range c.Slots {
			names = append(names, s.Name)
		}
		sort.Strings(names)
		alt = fmt.Sprintf("customise via the %s slot(s) instead", strings.Join(names, ", "))
	}
	return []byte(fmt.Sprintf(
		"// ┌───────────────────────────────────────────────────────────────────┐\n"+
			"// │ GENERATED BY FORGE — DO NOT EDIT                                   │\n"+
			"// │ capability: %-54s│\n"+
			"// │ template:   %-54s│\n"+
			"// │ Edits are reported by `forge drift` and will conflict on upgrade.  │\n"+
			"// │ %-66s│\n"+
			"// └───────────────────────────────────────────────────────────────────┘\n\n",
		c.ID+"@"+c.Version, t.ID+"@"+t.Version, alt))
}

// inputsHashOf hashes any input projection in canonical JSON.
func inputsHashOf(v any) string {
	b, err := json.Marshal(v)
	if err != nil {
		return ""
	}
	return state.Hash(b)
}

// inputsHash records what the render saw, so a later run can prove it was
// input-identical rather than assuming it.
func inputsHash(in Inputs) string {
	return inputsHashOf(struct {
		Product      manifest.Product
		Environment  string
		Branding     *manifest.Branding
		CapabilityID string
		Version      string
		Config       map[string]any
		Graph        GraphFacts
		Credentials  []string
		Entities     []manifest.Entity
	}{in.Product, in.Environment, in.Branding, in.Capability.ID, in.Capability.Version,
		in.Config, in.Graph, in.Credentials, in.Entities})
}

// configFor merges capability defaults, manifest config, and any per-environment
// override, in that order.
func configFor(m *manifest.Manifest, env string, c *spec.Capability) map[string]any {
	out := map[string]any{}
	if props, ok := c.Config["properties"].(map[string]any); ok {
		for k, v := range props {
			if spec, ok := v.(map[string]any); ok {
				if d, has := spec["default"]; has {
					out[k] = d
				}
			}
		}
	}
	for _, sel := range m.Capabilities {
		if sel.ID == c.ID {
			for k, v := range sel.Config {
				out[k] = v
			}
		}
	}
	if e, ok := m.Environments[env]; ok {
		if ov, ok := e.CapabilityOverrides[c.ID].(map[string]any); ok {
			for k, v := range ov {
				out[k] = v
			}
		}
	}
	return out
}

func packageOf(c *spec.Capability) string {
	if c.Package != nil {
		return c.Package.Name
	}
	return "@forge/" + strings.ReplaceAll(c.ID, ".", "-")
}

func dedupe(in []string) []string {
	if len(in) == 0 {
		return in
	}
	out := in[:1]
	for _, s := range in[1:] {
		if s != out[len(out)-1] {
			out = append(out, s)
		}
	}
	return out
}
