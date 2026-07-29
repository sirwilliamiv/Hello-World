package main

import (
	"flag"
	"fmt"
	"os"
	"path/filepath"

	"github.com/originplatformlabs/forge/internal/boundary"
	"github.com/originplatformlabs/forge/internal/catalog"
)

// cmdLint enforces the "nothing undeclared" rule across the capability packages.
//
// This is the CI step ARCHITECTURE.md section 9.3 calls for. It is separate
// from `forge validate`, which checks a product; lint checks the catalog's own
// source, so it runs on every change to this repository rather than per client.
func cmdLint(args []string) int {
	fs := flag.NewFlagSet("lint", flag.ContinueOnError)
	var packagesDir string
	var strict bool
	fs.StringVar(&packagesDir, "packages", "", "packages directory (default <root>/packages)")
	fs.BoolVar(&strict, "strict", false, "treat warnings as errors")
	c := parseCommon(fs, args)

	if packagesDir == "" {
		packagesDir = filepath.Join(c.root, "packages")
	}

	cat, cds, err := catalog.Load(c.catalogDir(), c.capSchema())
	if err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		return 1
	}
	if cds.HasErrors() {
		return report(cds)
	}

	ds, err := boundary.Check(packagesDir, cat)
	if err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		return 1
	}

	errs, warns := ds.Count()
	if errs == 0 && warns == 0 {
		fmt.Printf("No boundary violations. Every cross-capability import in %s is declared.\n", packagesDir)
		return 0
	}

	code := report(ds)
	if code == 0 && strict && warns > 0 {
		fmt.Fprintln(os.Stderr, "failing on warnings (--strict)")
		return 1
	}
	return code
}
