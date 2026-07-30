// Package boundary enforces the rule that makes the catalog composable:
// nothing undeclared.
//
// A capability may not import another capability's package unless the
// relationship is declared in its specification, and may not reach past a
// package's public entry point even when the relationship IS declared.
//
// ARCHITECTURE.md section 9.3 is explicit that this is "a CI step, not a code
// review norm". A rule enforced by reviewer attention decays the first week
// someone is in a hurry, and the failure is silent: the fleet fragments at the
// undeclared edge and nobody finds out until an upgrade breaks a client.
package boundary

import (
	"encoding/json"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"github.com/originplatformlabs/forge/internal/catalog"
	"github.com/originplatformlabs/forge/internal/diag"
	"github.com/originplatformlabs/forge/internal/spec"
)

const (
	CheckUndeclared     = "FORGE030"
	CheckDeepImport     = "FORGE031"
	CheckSelfImport     = "FORGE032"
	CheckRawSQL         = "FORGE033"
	CheckMissingPackage = "FORGE034"
)

// importRe matches ES import and re-export specifiers, plus dynamic import().
var importRe = regexp.MustCompile(`(?m)(?:from\s*|import\s*\(\s*)['"]([^'"]+)['"]`)

// rawTableRe finds a SQL identifier following FROM, JOIN, INTO, or UPDATE in a
// template literal. Cross-capability table access bypasses the repository layer,
// which is where tenant scoping and append-only enforcement live.
var rawTableRe = regexp.MustCompile(`(?i)\b(?:from|join|into|update)\s+"?([a-z_][a-z0-9_]*)"?`)

// Result is one package's declared surface, resolved from its specification.
type pkgInfo struct {
	capability  *spec.Capability
	dir         string
	allowed     map[string]bool // package names this package may import
	ownedTables map[string]bool
}

// Check scans the packages tree and reports every undeclared dependency.
//
// packagesRoot is the directory holding one subdirectory per npm package.
func Check(packagesRoot string, cat *catalog.Catalog) (*diag.Set, error) {
	ds := &diag.Set{}

	// Map npm package name -> capability, from the specifications rather than
	// from the workspace: the catalog is the authority on what exists.
	byPackage := map[string]*spec.Capability{}
	for _, id := range cat.IDs() {
		c, _ := cat.Get(id)
		if c.Package != nil && c.Package.Name != "" {
			byPackage[c.Package.Name] = c
		}
	}

	// Every table owned by any capability, so a raw query naming someone else's
	// table can be identified.
	tableOwner := map[string]string{}
	for _, id := range cat.IDs() {
		c, _ := cat.Get(id)
		for _, e := range c.Owns {
			if e.Kind == "table" {
				tableOwner[snake(e.Name)] = c.ID
			}
		}
	}

	// Every capability declaring a package must have one. A capability whose
	// package is missing still resolves into the graph and still lands in the
	// generated app's dependency list, so the failure surfaces as an install
	// error in a CLIENT repository rather than here — which is the worst place
	// for it. kernel.audit was missing for exactly this reason and was only
	// found when the reference app failed to install.
	for _, id := range cat.IDs() {
		c, _ := cat.Get(id)
		if c.Package == nil || c.Package.Name == "" {
			continue
		}
		dir := filepath.Join(packagesRoot, strings.TrimPrefix(c.Package.Name, "@forge/"))
		if _, err := os.Stat(dir); os.IsNotExist(err) {
			ds.Errorf(CheckMissingPackage, c.SourceFile, "package.name",
				fmt.Sprintf("create %s, or remove the package declaration from %s", dir, c.ID),
				"%s declares package %q, which does not exist in the workspace; every product resolving %s would fail to install",
				c.ID, c.Package.Name, c.ID)
		}
	}

	entries, err := os.ReadDir(packagesRoot)
	if err != nil {
		return ds, fmt.Errorf("read packages directory: %w", err)
	}

	var pkgs []pkgInfo
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		dir := filepath.Join(packagesRoot, e.Name())
		name := readPackageName(dir)
		if name == "" {
			continue
		}
		c, ok := byPackage[name]
		if !ok {
			ds.Errorf(CheckUndeclared, dir, "package.json",
				"add a capability specification declaring this package, or delete the directory",
				"package %q is in the workspace but no capability in the catalog declares it", name)
			continue
		}
		pkgs = append(pkgs, pkgInfo{
			capability:  c,
			dir:         dir,
			allowed:     allowedImports(c, byPackage),
			ownedTables: ownedTables(c),
		})
	}
	sort.Slice(pkgs, func(i, j int) bool { return pkgs[i].capability.ID < pkgs[j].capability.ID })

	for _, p := range pkgs {
		if err := checkPackage(p, byPackage, tableOwner, packagesRoot, ds); err != nil {
			return ds, err
		}
	}
	return ds, nil
}

// allowedImports is the closed set a capability may import: its own package,
// plus every package named in `requires` or `enhances`.
//
// `enhances` counts because an optional relationship still has to compile — the
// behaviour is guarded at runtime by whether the other capability is present,
// not by whether the import exists.
func allowedImports(c *spec.Capability, byPackage map[string]*spec.Capability) map[string]bool {
	out := map[string]bool{}
	add := func(id string) {
		for name, other := range byPackage {
			if other.ID == id {
				out[name] = true
			}
		}
	}
	for _, r := range c.Requires {
		add(r.ID)
	}
	for _, e := range c.Enhances {
		// Selector and glob targets are not concrete packages; an enhancement
		// expressed as a selector cannot license a direct import.
		if strings.Contains(e.Target, ".") && !strings.HasSuffix(e.Target, ".*") {
			add(e.Target)
		}
	}
	return out
}

func ownedTables(c *spec.Capability) map[string]bool {
	out := map[string]bool{}
	for _, e := range c.Owns {
		if e.Kind == "table" {
			out[snake(e.Name)] = true
		}
	}
	return out
}

func checkPackage(p pkgInfo, byPackage map[string]*spec.Capability, tableOwner map[string]string, packagesRoot string, ds *diag.Set) error {
	srcDir := filepath.Join(p.dir, "src")
	if _, err := os.Stat(srcDir); os.IsNotExist(err) {
		return nil // not implemented yet
	}

	self := ""
	if p.capability.Package != nil {
		self = p.capability.Package.Name
	}

	return filepath.WalkDir(srcDir, func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		ext := filepath.Ext(path)
		if ext != ".ts" && ext != ".tsx" {
			return nil
		}
		b, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		body := string(b)
		rel, _ := filepath.Rel(p.dir, path)

		for _, m := range importRe.FindAllStringSubmatch(body, -1) {
			target := m[1]
			if !strings.HasPrefix(target, "@forge/") {
				continue // third-party or relative; not our concern
			}

			root := packageRoot(target)

			if root == self {
				if target != self {
					ds.Errorf(CheckSelfImport, path, rel,
						"use a relative import inside your own package",
						"%s imports its own package by name (%q); use a relative path instead",
						p.capability.ID, target)
				}
				continue
			}

			if target != root && !isDeclaredEntryPoint(root, target, packagesRoot) {
				owner := "another capability"
				if c, ok := byPackage[root]; ok {
					owner = c.ID
				}
				ds.Errorf(CheckDeepImport, path, rel,
					fmt.Sprintf("import from %q only — anything you need must be in its public entry point, and if it is not, %s should expose it",
						root, owner),
					"%s reaches past %s's public entry point (%q); a capability's internals are not part of its contract",
					p.capability.ID, owner, target)
				continue
			}

			if p.allowed[root] || isKernelPackage(root, byPackage) {
				// The kernel is present in every product by definition, and every
				// capability already declares its kernel dependency as a version
				// range (`kernel_range`). A per-kernel-capability `requires` edge
				// would be noise that guarantees nothing new — the same reasoning
				// that exempts kernel registries from declaration. Capability-to-
				// capability imports are the coupling that actually fragments a
				// fleet, and those still must be declared.
				continue
			}

			other, known := byPackage[root]
			otherID := root
			if known {
				otherID = other.ID
			}
			ds.Errorf(CheckUndeclared, path, rel,
				fmt.Sprintf("add %s to %s's `requires` (hard dependency) or `enhances` (optional) in %s, or remove the import",
					otherID, p.capability.ID, shortPath(p.capability.SourceFile)),
				"%s imports %s without declaring the relationship; nothing undeclared may be used",
				p.capability.ID, otherID)
		}

		// A raw query naming a table this capability does not own bypasses the
		// repository layer, and with it tenant scoping and append-only
		// enforcement. Reported as a warning: the regex sees SQL-shaped strings
		// and cannot always tell a real query from prose.
		for _, m := range rawTableRe.FindAllStringSubmatch(stripComments(body), -1) {
			table := strings.ToLower(m[1])
			owner, isOwned := tableOwner[table]
			if !isOwned || p.ownedTables[table] || owner == p.capability.ID {
				continue
			}
			ds.Warnf(CheckRawSQL, path, rel,
				fmt.Sprintf("go through %s's exposed interface, or subscribe to the event it publishes", owner),
				"%s appears to query %q, a table owned by %s; only its owner may write it, and reads should go through the repository layer",
				p.capability.ID, table, owner)
		}
		return nil
	})
}

// isDeclaredEntryPoint reports whether a subpath is a published entry point of
// the target package.
//
// A subpath listed in package.json `exports` IS part of the public contract —
// that is precisely what the field means. Treating every subpath as a boundary
// violation would have forced kernel.admin to pull the whole React component
// library into server-side resolution just to reach a pure data helper. What
// the rule must actually forbid is reaching into paths the owner never
// published.
func isDeclaredEntryPoint(root, target, packagesRoot string) bool {
	dir := filepath.Join(packagesRoot, strings.TrimPrefix(root, "@forge/"))
	b, err := os.ReadFile(filepath.Join(dir, "package.json"))
	if err != nil {
		return false
	}
	var pkg struct {
		Exports map[string]any `json:"exports"`
	}
	if json.Unmarshal(b, &pkg) != nil {
		return false
	}
	sub := "." + strings.TrimPrefix(target, root)
	_, ok := pkg.Exports[sub]
	return ok
}

// isKernelPackage reports whether a package belongs to a kernel capability.
func isKernelPackage(name string, byPackage map[string]*spec.Capability) bool {
	c, ok := byPackage[name]
	return ok && c.IsKernel()
}

// stripComments removes line and block comments so the raw-SQL scan reads code
// rather than prose. Without it, a comment like "keys come from user-supplied
// filenames" reads as a query against the `user` table.
func stripComments(body string) string {
	var b strings.Builder
	b.Grow(len(body))
	for i := 0; i < len(body); i++ {
		switch {
		case strings.HasPrefix(body[i:], "//"):
			for i < len(body) && body[i] != '\n' {
				i++
			}
			b.WriteByte('\n')
		case strings.HasPrefix(body[i:], "/*"):
			end := strings.Index(body[i+2:], "*/")
			if end < 0 {
				return b.String()
			}
			i += end + 3
			b.WriteByte(' ')
		default:
			b.WriteByte(body[i])
		}
	}
	return b.String()
}

// packageRoot reduces "@forge/pay-card/internal/x" to "@forge/pay-card".
func packageRoot(target string) string {
	parts := strings.Split(target, "/")
	if len(parts) >= 2 {
		return parts[0] + "/" + parts[1]
	}
	return target
}

func readPackageName(dir string) string {
	b, err := os.ReadFile(filepath.Join(dir, "package.json"))
	if err != nil {
		return ""
	}
	m := regexp.MustCompile(`"name"\s*:\s*"([^"]+)"`).FindSubmatch(b)
	if m == nil {
		return ""
	}
	return string(m[1])
}

func shortPath(p string) string {
	if i := strings.Index(p, "catalog/"); i >= 0 {
		return p[i:]
	}
	return p
}

// snake converts a PascalCase entity name to its table name.
func snake(s string) string {
	var b strings.Builder
	for i, r := range s {
		if r >= 'A' && r <= 'Z' {
			if i > 0 {
				b.WriteByte('_')
			}
			b.WriteRune(r + 32)
			continue
		}
		b.WriteRune(r)
	}
	return b.String()
}
