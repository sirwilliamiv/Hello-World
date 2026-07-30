package main

import (
	"bufio"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/originplatformlabs/forge/internal/manifest"
	"github.com/originplatformlabs/forge/internal/plan"
	"github.com/originplatformlabs/forge/internal/provider"
	"github.com/originplatformlabs/forge/internal/provider/codegen"
	"github.com/originplatformlabs/forge/internal/render"
	"github.com/originplatformlabs/forge/internal/resolve"
	"github.com/originplatformlabs/forge/internal/state"
)

const forgeVersion = "0.1.0"

// pipeline is everything plan and apply both need.
type pipeline struct {
	m       *manifest.Manifest
	g       *resolve.Graph
	st      *state.State
	desired []render.Rendered
	target  string
	env     string
}

// build runs resolution, validation, and rendering. It touches nothing on disk
// beyond reading, so plan and apply share one code path and cannot drift apart.
func build(c *commonFlags, target, env string) (*pipeline, int) {
	m, _, g, ds, err := loadAll(c)
	if err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		return nil, 1
	}
	if code := report(ds); code != 0 {
		return nil, code
	}
	if m == nil || g == nil {
		return nil, 1
	}

	if env == "" {
		env = defaultEnv(m)
	}
	if _, ok := m.Environments[env]; !ok {
		fmt.Fprintf(os.Stderr, "error: no environment %q in the manifest\n", env)
		fmt.Fprintf(os.Stderr, "fix: use one of: %s\n", strings.Join(sortedEnvNames(m), ", "))
		return nil, 1
	}

	workspace := m.Product.ID + "/" + env
	st, err := state.Load(target, workspace, forgeVersion)
	if err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		return nil, 1
	}

	r := render.New(filepath.Join(c.root, "templates"))
	facts := render.BuildGraphFacts(m, g)

	desired, err := r.Product(m, env, facts)
	if err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		return nil, 1
	}
	clientFiles, err := r.Client(m, env, facts)
	if err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		return nil, 1
	}
	desired = append(desired, clientFiles...)
	for _, n := range g.Active() {
		files, err := r.Capability(m, env, n, facts)
		if err != nil {
			fmt.Fprintln(os.Stderr, "error:", err)
			return nil, 1
		}
		desired = append(desired, files...)
	}
	sort.Slice(desired, func(i, j int) bool { return desired[i].Path < desired[j].Path })

	return &pipeline{m: m, g: g, st: st, desired: desired, target: target, env: env}, 0
}

func defaultEnv(m *manifest.Manifest) string {
	if _, ok := m.Environments["development"]; ok {
		return "development"
	}
	names := sortedEnvNames(m)
	if len(names) > 0 {
		return names[0]
	}
	return ""
}

func cmdPlan(args []string) int {
	fs := flag.NewFlagSet("plan", flag.ContinueOnError)
	var target, env string
	fs.StringVar(&target, "target-dir", ".", "client repository to plan against")
	fs.StringVar(&env, "env", "", "environment (default: development)")
	c := parseCommon(fs, args)

	p, code := build(c, target, env)
	if code != 0 {
		return code
	}
	pl, err := plan.Compute(target, p.st, p.desired)
	if err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		return 1
	}
	renderPlan(pl, p, false)
	if pl.HasDrift() {
		return 2
	}
	return 0
}

func cmdApply(args []string) int {
	fs := flag.NewFlagSet("apply", flag.ContinueOnError)
	var target, env string
	var yes, acceptDrift bool
	fs.StringVar(&target, "target-dir", ".", "client repository to apply to")
	fs.StringVar(&env, "env", "", "environment (default: development)")
	fs.BoolVar(&yes, "yes", false, "skip the confirmation prompt")
	fs.BoolVar(&acceptDrift, "accept-drift", false, "overwrite hand-edited managed files, discarding the edits")
	c := parseCommon(fs, args)

	p, code := build(c, target, env)
	if code != 0 {
		return code
	}

	// Fail before starting, not halfway through.
	cg := codegen.New()
	if diags := cg.Validate(target); len(diags) > 0 {
		for _, d := range diags {
			fmt.Fprintln(os.Stderr, d)
		}
		return 1
	}

	pl, err := plan.Compute(target, p.st, p.desired)
	if err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		return 1
	}

	if pl.HasDrift() && !acceptDrift {
		renderPlan(pl, p, false)
		fmt.Fprintln(os.Stderr, "\nrefusing to apply: hand-edited managed files would be overwritten")
		fmt.Fprintln(os.Stderr, "fix: `forge eject <path>` to keep the edit, or re-run with --accept-drift to discard it")
		return 2
	}

	if !pl.HasChanges() {
		fmt.Printf("No changes. %s is up to date.\n", p.st.Workspace)
		return 0
	}

	renderPlan(pl, p, acceptDrift)
	if !yes && !confirm() {
		fmt.Println("Aborted. Nothing was written.")
		return 1
	}

	var prov provider.Provider = cg
	priorSerial := p.st.Serial
	written := 0

	for _, a := range pl.Actions {
		if a.Verb == plan.Drift && acceptDrift {
			// The plan withheld content for a drifted file; re-fetch it.
			for i := range p.desired {
				if p.desired[i].Path == a.Path {
					a = plan.Action{Verb: plan.Update, Path: a.Path, Zone: a.Zone,
						Capability: a.Capability, Template: a.Template, Content: p.desired[i].Content}
					break
				}
			}
		}
		if err := prov.Apply(target, a); err != nil {
			fmt.Fprintln(os.Stderr, "error:", err)
			fmt.Fprintf(os.Stderr, "state was not written; %d file(s) had already changed on disk\n", written)
			return 1
		}
		switch a.Verb {
		case plan.Create, plan.Update:
			written++
			recordFile(p, a)
		case plan.Delete:
			p.st.RemoveFile(a.Path)
		}
	}

	p.st.Serial++
	p.st.CatalogSnapshot = p.m.Catalog.Snapshot
	p.st.ManifestHash = manifestHash(p.m)
	p.st.Lock = buildLock(p.g, p.desired)

	if err := state.Save(target, p.st, priorSerial); err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		return 1
	}

	fmt.Printf("\nApplied. %d file(s) written, serial %d.\n", written, p.st.Serial)
	fmt.Printf("Next: cd %s && pnpm install && pnpm migrate && pnpm dev\n", target)
	return 0
}

func recordFile(p *pipeline, a plan.Action) {
	f := state.File{
		Path: a.Path, Zone: a.Zone, Capability: a.Capability, Template: a.Template,
	}
	for i := range p.desired {
		if p.desired[i].Path == a.Path {
			f.TemplateVersion = p.desired[i].TemplateVersion
			f.RenderedInputsHash = p.desired[i].InputsHash
			break
		}
	}
	if a.Zone == state.ZoneSeeded {
		f.SeededAt = f.TemplateVersion
	} else {
		f.GeneratedHash = state.Hash(a.Content)
	}
	p.st.SetFile(f)
}

func buildLock(g *resolve.Graph, desired []render.Rendered) state.Lock {
	l := state.Lock{
		Capabilities:   map[string]string{},
		EventContracts: map[string]int{},
		Templates:      map[string]string{},
	}
	for _, n := range g.All() {
		if n.Cap.IsKernel() {
			if l.Kernel == "" || n.Cap.Version > l.Kernel {
				l.Kernel = n.Cap.Version
			}
			continue
		}
		l.Capabilities[n.Cap.ID] = n.Cap.Version
	}
	for _, n := range g.Active() {
		for _, e := range n.Cap.Publishes {
			l.EventContracts[e.Name] = e.ContractVersion
		}
	}
	for _, d := range desired {
		if d.TemplateVersion != "" {
			l.Templates[d.Capability+":"+d.Template] = d.TemplateVersion
		}
	}
	return l
}

func manifestHash(m *manifest.Manifest) string {
	b, err := os.ReadFile(m.SourceFile)
	if err != nil {
		return ""
	}
	return state.Hash(b)
}

func renderPlan(pl *plan.Plan, p *pipeline, acceptDrift bool) {
	fmt.Printf("Plan for %s\n\n", pl.Workspace)

	symbols := map[plan.Verb]string{
		plan.Create: "+", plan.Update: "~", plan.Delete: "-",
		plan.Drift: "!", plan.NoOp: " ", plan.Adopted: "·", plan.Ejected: "e",
	}
	shown := map[plan.Verb]bool{
		plan.Drift: true, plan.Create: true, plan.Update: true,
		plan.Delete: true, plan.Ejected: true,
	}

	for _, a := range pl.Actions {
		if !shown[a.Verb] {
			continue
		}
		note := a.Detail
		if a.Verb == plan.Drift && acceptDrift {
			note = "hand-edited; --accept-drift will DISCARD the edit and overwrite"
		}
		fmt.Printf("  %s %-52s %s\n", symbols[a.Verb], a.Path, a.Capability)
		if note != "" {
			fmt.Printf("    %s\n", note)
		}
	}

	c := pl.Counts()
	fmt.Printf("\n%d to create, %d to update, %d to delete, %d unchanged",
		c[plan.Create], c[plan.Update], c[plan.Delete], c[plan.NoOp]+c[plan.Adopted])
	if c[plan.Drift] > 0 {
		fmt.Printf(", %d DRIFTED", c[plan.Drift])
	}
	fmt.Println()
}

func confirm() bool {
	fmt.Print("\nApply these changes? [y/N] ")
	sc := bufio.NewScanner(os.Stdin)
	if !sc.Scan() {
		return false
	}
	answer := strings.ToLower(strings.TrimSpace(sc.Text()))
	return answer == "y" || answer == "yes"
}
