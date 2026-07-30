// Package catalog loads capability specifications from disk and validates them
// against the capability JSON Schema.
package catalog

import (
	"encoding/json"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/santhosh-tekuri/jsonschema/v6"

	"github.com/originplatformlabs/forge/internal/diag"
	"github.com/originplatformlabs/forge/internal/spec"
)

// Catalog is the set of capabilities available to compose a product from.
type Catalog struct {
	byID map[string]*spec.Capability
	root string
}

// Load reads every *.capability.json under root, validating each against
// schemaPath. Loading never stops at the first bad file: every specification is
// checked so one command run reports every problem.
func Load(root, schemaPath string) (*Catalog, *diag.Set, error) {
	ds := &diag.Set{}

	compiler := jsonschema.NewCompiler()
	raw, err := os.ReadFile(schemaPath)
	if err != nil {
		return nil, ds, fmt.Errorf("read capability schema: %w", err)
	}
	var schemaDoc any
	if err := json.Unmarshal(raw, &schemaDoc); err != nil {
		return nil, ds, fmt.Errorf("parse capability schema: %w", err)
	}
	if err := compiler.AddResource("capability.schema.json", schemaDoc); err != nil {
		return nil, ds, fmt.Errorf("add capability schema: %w", err)
	}
	sch, err := compiler.Compile("capability.schema.json")
	if err != nil {
		return nil, ds, fmt.Errorf("compile capability schema: %w", err)
	}

	c := &Catalog{byID: map[string]*spec.Capability{}, root: root}

	var files []string
	err = filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if !d.IsDir() && strings.HasSuffix(path, ".capability.json") {
			files = append(files, path)
		}
		return nil
	})
	if err != nil {
		return nil, ds, fmt.Errorf("walk catalog: %w", err)
	}
	sort.Strings(files) // deterministic load order

	for _, path := range files {
		b, err := os.ReadFile(path)
		if err != nil {
			ds.Errorf("FORGE002", path, "", "check file permissions", "cannot read: %v", err)
			continue
		}

		var doc any
		if err := json.Unmarshal(b, &doc); err != nil {
			ds.Errorf("FORGE002", path, "", "fix the JSON syntax", "invalid JSON: %v", err)
			continue
		}
		// $schema is an editor affordance pointing at a relative path; it is not
		// part of the instance the engine validates.
		if m, ok := doc.(map[string]any); ok {
			delete(m, "$schema")
		}

		if err := sch.Validate(doc); err != nil {
			var ve *jsonschema.ValidationError
			if ok := asValidationError(err, &ve); ok {
				for _, leaf := range leaves(ve) {
					ds.Errorf("FORGE002", path, instancePath(leaf),
						"see schemas/capability.schema.json for the expected shape",
						"%s", leaf.ErrorKind.LocalizedString(englishPrinter))
				}
			} else {
				ds.Errorf("FORGE002", path, "", "see schemas/capability.schema.json", "%v", err)
			}
			continue
		}

		var cap spec.Capability
		if err := json.Unmarshal(b, &cap); err != nil {
			ds.Errorf("FORGE002", path, "", "fix the specification", "cannot decode: %v", err)
			continue
		}
		cap.SourceFile = path

		if prior, dup := c.byID[cap.ID]; dup {
			ds.Errorf("FORGE002", path, "id",
				fmt.Sprintf("rename one of them, or delete the duplicate in %s", prior.SourceFile),
				"capability %q is already defined in %s", cap.ID, prior.SourceFile)
			continue
		}
		c.byID[cap.ID] = &cap
	}

	return c, ds, nil
}

// Get returns a capability by id.
func (c *Catalog) Get(id string) (*spec.Capability, bool) {
	cap, ok := c.byID[id]
	return cap, ok
}

// IDs returns every capability id, sorted.
func (c *Catalog) IDs() []string {
	out := make([]string, 0, len(c.byID))
	for id := range c.byID {
		out = append(out, id)
	}
	sort.Strings(out)
	return out
}

// Kernel returns the kernel capabilities, sorted. These are mandatory and
// implicit: always present, never listed in a manifest.
func (c *Catalog) Kernel() []*spec.Capability {
	var out []*spec.Capability
	for _, id := range c.IDs() {
		if cap := c.byID[id]; cap.IsKernel() {
			out = append(out, cap)
		}
	}
	return out
}

// Selectable returns the capabilities a manifest may name.
func (c *Catalog) Selectable() []*spec.Capability {
	var out []*spec.Capability
	for _, id := range c.IDs() {
		if cap := c.byID[id]; !cap.IsKernel() {
			out = append(out, cap)
		}
	}
	return out
}

func (c *Catalog) Len() int { return len(c.byID) }

// New builds a catalog from in-memory specifications, bypassing disk and schema
// validation. Intended for tests that need to construct a specific graph shape.
func New(caps ...*spec.Capability) *Catalog {
	c := &Catalog{byID: map[string]*spec.Capability{}}
	for _, cap := range caps {
		if cap.SourceFile == "" {
			cap.SourceFile = "<test>/" + cap.ID + ".capability.json"
		}
		c.byID[cap.ID] = cap
	}
	return c
}
