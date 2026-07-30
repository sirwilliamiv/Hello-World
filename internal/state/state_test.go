package state

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestLoadReturnsFreshStateWhenNoneExists(t *testing.T) {
	s, err := Load(t.TempDir(), "acme/production", "0.1.0")
	if err != nil {
		t.Fatal(err)
	}
	if s.Serial != 0 || s.Workspace != "acme/production" {
		t.Fatalf("fresh state = %+v", s)
	}
	if s.Lock.Capabilities == nil || s.Lock.EventContracts == nil || s.Lock.Templates == nil {
		t.Error("lock maps must be initialised so callers need not nil-check")
	}
}

func TestSaveAndLoadRoundTrip(t *testing.T) {
	root := t.TempDir()
	s := New("acme/production", "0.1.0")
	s.Serial = 1
	s.CatalogSnapshot = "2026-07-15"
	s.Lock.Capabilities["pay.card"] = "1.0.0"
	s.SetFile(File{Path: "src/a.ts", Zone: ZoneManaged, Capability: "pay.card",
		GeneratedHash: Hash([]byte("x"))})

	if err := Save(root, s, 0); err != nil {
		t.Fatal(err)
	}
	got, err := Load(root, "acme/production", "0.1.0")
	if err != nil {
		t.Fatal(err)
	}
	if got.Serial != 1 || got.Lock.Capabilities["pay.card"] != "1.0.0" {
		t.Fatalf("round trip lost data: %+v", got)
	}
	if f, ok := got.FileByPath("src/a.ts"); !ok || f.GeneratedHash != Hash([]byte("x")) {
		t.Fatal("file tracking did not survive the round trip")
	}
}

// A stale write means another apply ran in between. Overwriting it would lose
// that apply's record of what is on disk, which is unrecoverable.
func TestConcurrentApplyIsRejected(t *testing.T) {
	root := t.TempDir()
	s := New("acme/production", "0.1.0")
	s.Serial = 1
	if err := Save(root, s, 0); err != nil {
		t.Fatal(err)
	}

	// A second process wrote serial 2 while we were planning against serial 1.
	other := New("acme/production", "0.1.0")
	other.Serial = 2
	if err := Save(root, other, 1); err != nil {
		t.Fatal(err)
	}

	s.Serial = 2
	if err := Save(root, s, 1); err != ErrStale {
		t.Fatalf("err = %v, want ErrStale", err)
	}
}

// Every mutating state write keeps the prior serial recoverable.
func TestSaveBacksUpThePriorVersion(t *testing.T) {
	root := t.TempDir()
	s := New("acme/production", "0.1.0")
	s.Serial = 1
	if err := Save(root, s, 0); err != nil {
		t.Fatal(err)
	}
	s.Serial = 2
	if err := Save(root, s, 1); err != nil {
		t.Fatal(err)
	}

	backup := filepath.Join(root, ".forge", "state.backups", "1.json")
	b, err := os.ReadFile(backup)
	if err != nil {
		t.Fatalf("no backup of serial 1: %v", err)
	}
	var old State
	if err := json.Unmarshal(b, &old); err != nil || old.Serial != 1 {
		t.Fatalf("backup is not serial 1: %+v", old)
	}
}

// State is committed to a client repository, so its diff must be reviewable and
// byte-stable. Any churn here would make every apply look like a change.
func TestMarshalIsCanonicalAndCarriesNoTimestamps(t *testing.T) {
	s := New("acme/production", "0.1.0")
	s.SetFile(File{Path: "src/b.ts", Zone: ZoneManaged, Capability: "x.y"})
	s.SetFile(File{Path: "src/a.ts", Zone: ZoneManaged, Capability: "x.y"})

	first, err := Marshal(s)
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 20; i++ {
		again, _ := Marshal(s)
		if string(again) != string(first) {
			t.Fatal("state encoding is not byte-stable across runs")
		}
	}
	if !strings.HasSuffix(string(first), "\n") {
		t.Error("state must end with a newline")
	}

	// Files sort by path so a reader can find one, and a reordering never shows
	// up as a diff.
	if s.Files[0].Path != "src/a.ts" {
		t.Errorf("files must be sorted by path, got %s first", s.Files[0].Path)
	}

	for _, banned := range []string{"timestamp", "created_at", "applied_at", "\"time\""} {
		if strings.Contains(string(first), banned) {
			t.Errorf("state must carry no wall-clock time, found %q", banned)
		}
	}
}

// Secrets are resolved in memory at apply time and never persisted.
func TestStateHasNoFieldForSecretValues(t *testing.T) {
	b, err := Marshal(New("acme/production", "0.1.0"))
	if err != nil {
		t.Fatal(err)
	}
	for _, banned := range []string{"secret_value", "credentials", "password", "api_key"} {
		if strings.Contains(strings.ToLower(string(b)), banned) {
			t.Errorf("state must never carry secrets, found %q", banned)
		}
	}
}

func TestRemoveFileStopsTracking(t *testing.T) {
	s := New("t/dev", "0.1.0")
	s.SetFile(File{Path: "a", Zone: ZoneManaged})
	s.SetFile(File{Path: "b", Zone: ZoneManaged})
	s.RemoveFile("a")
	if _, ok := s.FileByPath("a"); ok {
		t.Error("a was not removed")
	}
	if _, ok := s.FileByPath("b"); !ok {
		t.Error("b should still be tracked")
	}
}

func TestSetFileReplacesRatherThanDuplicates(t *testing.T) {
	s := New("t/dev", "0.1.0")
	s.SetFile(File{Path: "a", Zone: ZoneManaged, GeneratedHash: "one"})
	s.SetFile(File{Path: "a", Zone: ZoneManaged, GeneratedHash: "two"})
	if len(s.Files) != 1 {
		t.Fatalf("got %d entries, want 1", len(s.Files))
	}
	if s.Files[0].GeneratedHash != "two" {
		t.Error("SetFile must replace the prior entry")
	}
}

func TestUnknownStateVersionIsRefused(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, ".forge"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(Path(root), []byte(`{"state_version":99}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := Load(root, "t/dev", "0.1.0"); err == nil {
		t.Fatal("a future state version must be refused rather than misread")
	}
}
