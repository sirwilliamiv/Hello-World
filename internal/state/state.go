// Package state is the durable record of what was built.
//
// State is written in canonical form — keys sorted, two-space indent, LF — so a
// state diff is reviewable in git and byte-stable across runs. It deliberately
// contains no secret values and no timestamps: timestamps would churn on every
// apply and defeat reviewability, so ordering is carried by `serial` instead.
package state

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
)

const Version = 1

// Zone determines what apply may do to a file.
type Zone string

const (
	// ZoneManaged files are generated, hash-tracked, and overwritten on apply.
	// A hash mismatch is drift: reported, never silently overwritten.
	ZoneManaged Zone = "managed"
	// ZoneSeeded files are written once on create and then belong to the client
	// repository. Forge never touches them again.
	ZoneSeeded Zone = "seeded"
)

type State struct {
	StateVersion    int               `json:"state_version"`
	Workspace       string            `json:"workspace"`
	ForgeVersion    string            `json:"forge_version"`
	Serial          int               `json:"serial"`
	ManifestHash    string            `json:"manifest_hash"`
	CatalogSnapshot string            `json:"catalog_snapshot"`
	Lock            Lock              `json:"lock"`
	Files           []File            `json:"files"`
	Ejected         []Ejected         `json:"ejected,omitempty"`
	Migrations      []Migration       `json:"migrations,omitempty"`
	Resources       []Resource        `json:"resources,omitempty"`
	Outputs         map[string]string `json:"outputs,omitempty"`
}

type Lock struct {
	Kernel         string            `json:"kernel"`
	Capabilities   map[string]string `json:"capabilities"`
	EventContracts map[string]int    `json:"event_contracts"`
	Templates      map[string]string `json:"templates"`
}

type File struct {
	Path       string `json:"path"`
	Zone       Zone   `json:"zone"`
	Capability string `json:"capability"`
	Template   string `json:"template"`
	// TemplateVersion lets an upgrade three-way merge only the templates that
	// actually changed, rather than every file the capability owns.
	TemplateVersion string `json:"template_version,omitempty"`
	// GeneratedHash is what Forge wrote. A file on disk whose hash differs has
	// been hand-edited: that is drift.
	GeneratedHash string `json:"generated_hash,omitempty"`
	// RenderedInputsHash proves a re-render was input-identical, which is how
	// determinism is verified rather than assumed.
	RenderedInputsHash string `json:"rendered_inputs_hash,omitempty"`
	SeededAt           string `json:"seeded_at,omitempty"`
}

type Ejected struct {
	Path                       string `json:"path"`
	EjectedFromTemplate        string `json:"ejected_from_template"`
	EjectedAtCapabilityVersion string `json:"ejected_at_capability_version"`
	Reason                     string `json:"reason"`
}

type Migration struct {
	Capability        string `json:"capability"`
	ID                string `json:"id"`
	AppliedSerial     int    `json:"applied_serial"`
	Checksum          string `json:"checksum"`
	RollbackAvailable bool   `json:"rollback_available"`
}

type Resource struct {
	Provider   string            `json:"provider"`
	Type       string            `json:"type"`
	ID         string            `json:"id"`
	Attributes map[string]string `json:"attributes,omitempty"`
}

// New returns empty state for a workspace.
func New(workspace, forgeVersion string) *State {
	return &State{
		StateVersion: Version,
		Workspace:    workspace,
		ForgeVersion: forgeVersion,
		Lock: Lock{
			Capabilities:   map[string]string{},
			EventContracts: map[string]int{},
			Templates:      map[string]string{},
		},
	}
}

// FileByPath returns the tracked file at path.
func (s *State) FileByPath(path string) (File, bool) {
	for _, f := range s.Files {
		if f.Path == path {
			return f, true
		}
	}
	return File{}, false
}

// IsEjected reports whether a path has been deliberately released from
// management. An ejected file no longer receives capability upgrades.
func (s *State) IsEjected(path string) bool {
	for _, e := range s.Ejected {
		if e.Path == path {
			return true
		}
	}
	return false
}

// SetFile inserts or replaces a tracked file, keeping Files sorted by path so
// state diffs stay readable.
func (s *State) SetFile(f File) {
	for i := range s.Files {
		if s.Files[i].Path == f.Path {
			s.Files[i] = f
			return
		}
	}
	s.Files = append(s.Files, f)
	sort.Slice(s.Files, func(i, j int) bool { return s.Files[i].Path < s.Files[j].Path })
}

// RemoveFile stops tracking a path.
func (s *State) RemoveFile(path string) {
	out := s.Files[:0]
	for _, f := range s.Files {
		if f.Path != path {
			out = append(out, f)
		}
	}
	s.Files = out
}

// Hash returns the canonical content hash used for drift detection.
func Hash(b []byte) string {
	sum := sha256.Sum256(b)
	return "sha256:" + hex.EncodeToString(sum[:])
}

// ErrStale is returned when the on-disk serial has moved past what the caller
// read, meaning another apply ran in between.
var ErrStale = errors.New("state has changed since it was read; re-run plan")

// Path returns the state file location for a repository root.
func Path(root string) string { return filepath.Join(root, ".forge", "state.json") }

// Load reads state, returning fresh state when none exists yet.
func Load(root, workspace, forgeVersion string) (*State, error) {
	b, err := os.ReadFile(Path(root))
	if errors.Is(err, os.ErrNotExist) {
		return New(workspace, forgeVersion), nil
	}
	if err != nil {
		return nil, fmt.Errorf("read state: %w", err)
	}
	var s State
	if err := json.Unmarshal(b, &s); err != nil {
		return nil, fmt.Errorf("parse state at %s: %w", Path(root), err)
	}
	if s.StateVersion != Version {
		return nil, fmt.Errorf("state version %d is not supported by this forge (want %d)", s.StateVersion, Version)
	}
	if s.Lock.Capabilities == nil {
		s.Lock.Capabilities = map[string]string{}
	}
	if s.Lock.EventContracts == nil {
		s.Lock.EventContracts = map[string]int{}
	}
	if s.Lock.Templates == nil {
		s.Lock.Templates = map[string]string{}
	}
	return &s, nil
}

// Save writes state atomically, backing up the prior version first. Every
// mutating state operation keeps the previous serial recoverable, because state
// corruption is the failure mode that cannot be undone from the client's repo.
func Save(root string, s *State, expectSerial int) error {
	dir := filepath.Join(root, ".forge")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("create state directory: %w", err)
	}

	if prior, err := os.ReadFile(Path(root)); err == nil {
		var old State
		if json.Unmarshal(prior, &old) == nil {
			if old.Serial != expectSerial {
				return ErrStale
			}
			backupDir := filepath.Join(dir, "state.backups")
			if err := os.MkdirAll(backupDir, 0o755); err != nil {
				return fmt.Errorf("create backup directory: %w", err)
			}
			backup := filepath.Join(backupDir, fmt.Sprintf("%d.json", old.Serial))
			if err := os.WriteFile(backup, prior, 0o644); err != nil {
				return fmt.Errorf("write state backup: %w", err)
			}
		}
	}

	b, err := Marshal(s)
	if err != nil {
		return err
	}
	tmp := Path(root) + ".tmp"
	if err := os.WriteFile(tmp, b, 0o644); err != nil {
		return fmt.Errorf("write state: %w", err)
	}
	return os.Rename(tmp, Path(root))
}

// Marshal renders state in canonical form: sorted keys, two-space indent, and a
// trailing newline, so the file is stable byte-for-byte across runs.
func Marshal(s *State) ([]byte, error) {
	b, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return nil, fmt.Errorf("encode state: %w", err)
	}
	return append(b, '\n'), nil
}
