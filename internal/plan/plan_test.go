package plan

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/originplatformlabs/forge/internal/render"
	"github.com/originplatformlabs/forge/internal/state"
)

func managed(path, content string) render.Rendered {
	return render.Rendered{
		Path: path, Zone: state.ZoneManaged, Capability: "pay.card",
		Template: "config.ts", TemplateVersion: "1.0.0", Content: []byte(content),
	}
}

func seeded(path, content string) render.Rendered {
	return render.Rendered{
		Path: path, Zone: state.ZoneSeeded, Capability: "pay.card",
		Template: "slots", TemplateVersion: "1.0.0", Content: []byte(content),
	}
}

func write(t *testing.T, root, path, content string) {
	t.Helper()
	abs := filepath.Join(root, path)
	if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(abs, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func verbFor(p *Plan, path string) Verb {
	for _, a := range p.Actions {
		if a.Path == path {
			return a.Verb
		}
	}
	return ""
}

func TestMissingFileIsCreated(t *testing.T) {
	root := t.TempDir()
	s := state.New("t/dev", "0.1.0")

	p, err := Compute(root, s, []render.Rendered{managed("src/a.ts", "hello")})
	if err != nil {
		t.Fatal(err)
	}
	if got := verbFor(p, "src/a.ts"); got != Create {
		t.Fatalf("verb = %q, want create", got)
	}
	if !p.HasChanges() {
		t.Error("a create is a change")
	}
}

// The single most important Phase 1 signal: applying twice must do nothing the
// second time.
func TestUnchangedFileIsNoOp(t *testing.T) {
	root := t.TempDir()
	content := "hello"
	write(t, root, "src/a.ts", content)

	s := state.New("t/dev", "0.1.0")
	s.SetFile(state.File{
		Path: "src/a.ts", Zone: state.ZoneManaged, Capability: "pay.card",
		Template: "config.ts", TemplateVersion: "1.0.0",
		GeneratedHash: state.Hash([]byte(content)),
	})

	p, err := Compute(root, s, []render.Rendered{managed("src/a.ts", content)})
	if err != nil {
		t.Fatal(err)
	}
	if got := verbFor(p, "src/a.ts"); got != NoOp {
		t.Fatalf("verb = %q, want no-op", got)
	}
	if p.HasChanges() {
		t.Error("an unchanged product must report no changes; idempotency is broken")
	}
}

// A hand-edited managed file is drift. It is reported and never silently
// overwritten, because overwriting it is data loss in a client's repository.
func TestHandEditedManagedFileIsDriftNotUpdate(t *testing.T) {
	root := t.TempDir()
	write(t, root, "src/a.ts", "hello, and then a developer edited this")

	s := state.New("t/dev", "0.1.0")
	s.SetFile(state.File{
		Path: "src/a.ts", Zone: state.ZoneManaged, Capability: "pay.card",
		Template: "config.ts", TemplateVersion: "1.0.0",
		GeneratedHash: state.Hash([]byte("hello")),
	})

	p, err := Compute(root, s, []render.Rendered{managed("src/a.ts", "hello v2")})
	if err != nil {
		t.Fatal(err)
	}
	if got := verbFor(p, "src/a.ts"); got != Drift {
		t.Fatalf("verb = %q, want drift", got)
	}
	if !p.HasDrift() {
		t.Error("HasDrift must be true")
	}
	if p.HasChanges() {
		t.Error("drift must not be counted as a change apply can make")
	}
	for _, a := range p.Actions {
		if a.Verb == Drift && len(a.Content) > 0 {
			t.Error("a drift action must carry no content; apply must not be able to write it by accident")
		}
	}
}

// A template change to a clean managed file is a normal update.
func TestTemplateChangeOnCleanFileIsUpdate(t *testing.T) {
	root := t.TempDir()
	write(t, root, "src/a.ts", "hello")

	s := state.New("t/dev", "0.1.0")
	s.SetFile(state.File{
		Path: "src/a.ts", Zone: state.ZoneManaged, Capability: "pay.card",
		Template: "config.ts", TemplateVersion: "1.0.0",
		GeneratedHash: state.Hash([]byte("hello")),
	})

	next := managed("src/a.ts", "hello v2")
	next.TemplateVersion = "2.0.0"
	p, err := Compute(root, s, []render.Rendered{next})
	if err != nil {
		t.Fatal(err)
	}
	if got := verbFor(p, "src/a.ts"); got != Update {
		t.Fatalf("verb = %q, want update", got)
	}
	for _, a := range p.Actions {
		if a.Path == "src/a.ts" && a.Detail != "template 1.0.0 -> 2.0.0" {
			t.Errorf("detail = %q, want the template version transition", a.Detail)
		}
	}
}

// Seeded files are written once and then belong to the client. Editing one is
// not drift — that is the entire point of the seeded zone.
func TestSeededFileIsWrittenOnceThenLeftAlone(t *testing.T) {
	root := t.TempDir()
	s := state.New("t/dev", "0.1.0")

	p, _ := Compute(root, s, []render.Rendered{seeded("src/slots/pay.card/beforeCharge.ts", "stub")})
	if got := verbFor(p, "src/slots/pay.card/beforeCharge.ts"); got != Create {
		t.Fatalf("first pass verb = %q, want create", got)
	}

	write(t, root, "src/slots/pay.card/beforeCharge.ts", "the client's own fraud screening")
	p, _ = Compute(root, s, []render.Rendered{seeded("src/slots/pay.card/beforeCharge.ts", "stub")})
	if got := verbFor(p, "src/slots/pay.card/beforeCharge.ts"); got != Adopted {
		t.Fatalf("verb = %q, want adopted — an edited slot is not drift", got)
	}
	if p.HasChanges() || p.HasDrift() {
		t.Error("an edited seeded file must produce neither a change nor drift")
	}
}

func TestTrackedFileNoLongerProducedIsDeleted(t *testing.T) {
	root := t.TempDir()
	write(t, root, "src/gone.ts", "old")

	s := state.New("t/dev", "0.1.0")
	s.SetFile(state.File{Path: "src/gone.ts", Zone: state.ZoneManaged, Capability: "pay.card"})

	p, _ := Compute(root, s, nil)
	if got := verbFor(p, "src/gone.ts"); got != Delete {
		t.Fatalf("verb = %q, want delete", got)
	}
}

// Seeded files are never deleted when a capability is removed: they contain the
// client's code.
func TestSeededFileIsNeverDeleted(t *testing.T) {
	root := t.TempDir()
	s := state.New("t/dev", "0.1.0")
	s.SetFile(state.File{Path: "src/slots/x.ts", Zone: state.ZoneSeeded, Capability: "pay.card"})

	p, _ := Compute(root, s, nil)
	if got := verbFor(p, "src/slots/x.ts"); got == Delete {
		t.Fatal("a seeded file must never be deleted; it holds client code")
	}
}

// Ejection is per-file and permanent: the file is left entirely alone even
// though the graph still produces it.
func TestEjectedFileIsLeftAloneEvenWhenStillProduced(t *testing.T) {
	root := t.TempDir()
	write(t, root, "src/a.ts", "the client's version")

	s := state.New("t/dev", "0.1.0")
	s.Ejected = append(s.Ejected, state.Ejected{Path: "src/a.ts", Reason: "client-specific"})

	p, _ := Compute(root, s, []render.Rendered{managed("src/a.ts", "the generated version")})
	if got := verbFor(p, "src/a.ts"); got != Ejected {
		t.Fatalf("verb = %q, want ejected", got)
	}
	if p.HasChanges() {
		t.Error("an ejected file must never be rewritten")
	}
}

// Plan output must be stable so a fleet diff is reviewable rather than noisy.
func TestPlanOrderingIsDeterministic(t *testing.T) {
	root := t.TempDir()
	write(t, root, "src/drifted.ts", "edited")

	s := state.New("t/dev", "0.1.0")
	s.SetFile(state.File{
		Path: "src/drifted.ts", Zone: state.ZoneManaged, Capability: "pay.card",
		GeneratedHash: state.Hash([]byte("original")),
	})

	desired := []render.Rendered{
		managed("src/z.ts", "z"), managed("src/a.ts", "a"),
		managed("src/drifted.ts", "new"), managed("src/m.ts", "m"),
	}

	first, _ := Compute(root, s, desired)
	want := ""
	for _, a := range first.Actions {
		want += string(a.Verb) + ":" + a.Path + ";"
	}
	// Drift sorts first: it is the thing a reader must not miss.
	if first.Actions[0].Verb != Drift {
		t.Errorf("drift must sort first, got %q", first.Actions[0].Verb)
	}
	for i := 0; i < 20; i++ {
		p, _ := Compute(root, s, desired)
		got := ""
		for _, a := range p.Actions {
			got += string(a.Verb) + ":" + a.Path + ";"
		}
		if got != want {
			t.Fatalf("plan ordering differs between runs:\n  %s\n  %s", want, got)
		}
	}
}
