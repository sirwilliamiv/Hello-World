// Package manifest loads and validates a product manifest (forge.yaml).
package manifest

import (
	"encoding/json"
	"fmt"
	"os"

	"github.com/santhosh-tekuri/jsonschema/v6"
	"gopkg.in/yaml.v3"

	"github.com/originplatformlabs/forge/internal/diag"
)

// Manifest is the declarative description of one product. It is the only
// artifact a human edits during routine onboarding.
type Manifest struct {
	ManifestVersion int                    `json:"manifest_version" yaml:"manifest_version"`
	Catalog         CatalogPin             `json:"catalog" yaml:"catalog"`
	Product         Product                `json:"product" yaml:"product"`
	Branding        *Branding              `json:"branding,omitempty" yaml:"branding"`
	Capabilities    []Selection            `json:"capabilities,omitempty" yaml:"capabilities"`
	Entities        []Entity               `json:"entities,omitempty" yaml:"entities"`
	Integrations    map[string]Integration `json:"integrations,omitempty" yaml:"integrations"`
	Environments    map[string]Environment `json:"environments" yaml:"environments"`
	Repository      *Repository            `json:"repository,omitempty" yaml:"repository"`
	Commercial      *Commercial            `json:"commercial,omitempty" yaml:"commercial"`

	SourceFile string `json:"-" yaml:"-"`

	// lines maps a document path such as "capabilities/0/id" to its line in the
	// source file, so a diagnostic can point at the exact line.
	lines map[string]int `json:"-" yaml:"-"`
}

type CatalogPin struct {
	Snapshot string `json:"snapshot" yaml:"snapshot"`
}

type Product struct {
	ID          string `json:"id" yaml:"id"`
	Name        string `json:"name" yaml:"name"`
	Description string `json:"description,omitempty" yaml:"description"`
	Vertical    string `json:"vertical,omitempty" yaml:"vertical"`
	Client      Client `json:"client" yaml:"client"`
}

type Client struct {
	Name         string `json:"name" yaml:"name"`
	LegalEntity  string `json:"legal_entity,omitempty" yaml:"legal_entity"`
	ContactEmail string `json:"contact_email,omitempty" yaml:"contact_email"`
	Country      string `json:"country,omitempty" yaml:"country"`
}

type Branding struct {
	Tokens     map[string]any    `json:"tokens,omitempty" yaml:"tokens"`
	Logo       map[string]string `json:"logo,omitempty" yaml:"logo"`
	Typography map[string]string `json:"typography,omitempty" yaml:"typography"`
}

// Selection is one capability the client is buying. Hard dependencies are not
// listed here; they resolve automatically and the plan reports each addition.
type Selection struct {
	ID      string            `json:"id" yaml:"id"`
	Version string            `json:"version,omitempty" yaml:"version"`
	Config  map[string]any    `json:"config,omitempty" yaml:"config"`
	Slots   map[string]string `json:"slots,omitempty" yaml:"slots"`
	Enabled *bool             `json:"enabled,omitempty" yaml:"enabled"`
}

func (s Selection) IsEnabled() bool { return s.Enabled == nil || *s.Enabled }

type Entity struct {
	Name             string  `json:"name" yaml:"name"`
	Plural           string  `json:"plural,omitempty" yaml:"plural"`
	Description      string  `json:"description,omitempty" yaml:"description"`
	PersonalData     bool    `json:"personal_data,omitempty" yaml:"personal_data"`
	TenantScoped     *bool   `json:"tenant_scoped,omitempty" yaml:"tenant_scoped"`
	Listable         *bool   `json:"listable,omitempty" yaml:"listable"`
	Searchable       bool    `json:"searchable,omitempty" yaml:"searchable"`
	DeletionStrategy string  `json:"deletion_strategy,omitempty" yaml:"deletion_strategy"`
	Fields           []Field `json:"fields" yaml:"fields"`
}

type Field struct {
	Name     string   `json:"name" yaml:"name"`
	Type     string   `json:"type" yaml:"type"`
	Required bool     `json:"required,omitempty" yaml:"required"`
	Unique   bool     `json:"unique,omitempty" yaml:"unique"`
	Indexed  bool     `json:"indexed,omitempty" yaml:"indexed"`
	Default  any      `json:"default,omitempty" yaml:"default"`
	Enum     []string `json:"enum,omitempty" yaml:"enum"`
	Label    string   `json:"label,omitempty" yaml:"label"`
	Help     string   `json:"help,omitempty" yaml:"help"`
}

type Integration struct {
	Enabled     *bool                `json:"enabled,omitempty" yaml:"enabled"`
	Provider    string               `json:"provider,omitempty" yaml:"provider"`
	Credentials map[string]SecretRef `json:"credentials,omitempty" yaml:"credentials"`
	Settings    map[string]any       `json:"settings,omitempty" yaml:"settings"`
}

// SecretRef is a NAME, never a value. Validate checks presence via the secrets
// provider and never reads the value; apply resolves it in memory and never
// writes it to state, to a generated file, or to a log.
type SecretRef struct {
	SecretRef string `json:"secret_ref" yaml:"secret_ref"`
}

type Environment struct {
	Provider            string          `json:"provider" yaml:"provider"`
	Region              string          `json:"region,omitempty" yaml:"region"`
	Domain              string          `json:"domain,omitempty" yaml:"domain"`
	ProjectID           string          `json:"project_id,omitempty" yaml:"project_id"`
	Secrets             *SecretsBackend `json:"secrets,omitempty" yaml:"secrets"`
	Database            map[string]any  `json:"database,omitempty" yaml:"database"`
	Scale               map[string]any  `json:"scale,omitempty" yaml:"scale"`
	CapabilityOverrides map[string]any  `json:"capability_overrides,omitempty" yaml:"capability_overrides"`
}

type SecretsBackend struct {
	Provider string `json:"provider" yaml:"provider"`
	Path     string `json:"path,omitempty" yaml:"path"`
	Prefix   string `json:"prefix,omitempty" yaml:"prefix"`
}

type Repository struct {
	URL             string `json:"url,omitempty" yaml:"url"`
	DefaultBranch   string `json:"default_branch,omitempty" yaml:"default_branch"`
	UpgradeStrategy string `json:"upgrade_strategy,omitempty" yaml:"upgrade_strategy"`
}

type Commercial struct {
	Currency             string `json:"currency,omitempty" yaml:"currency"`
	IntegrationRateMinor int    `json:"integration_rate_minor,omitempty" yaml:"integration_rate_minor"`
	DiscountMinor        int    `json:"discount_minor,omitempty" yaml:"discount_minor"`
	Notes                string `json:"notes,omitempty" yaml:"notes"`
}

// Line returns the source line for a document path such as "capabilities/2/id",
// or 0 when it cannot be determined.
func (m *Manifest) Line(path string) int {
	if m.lines == nil {
		return 0
	}
	return m.lines[path]
}

// Load parses a manifest and validates it against schemaPath.
func Load(path, schemaPath string) (*Manifest, *diag.Set, error) {
	ds := &diag.Set{}

	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, ds, fmt.Errorf("read manifest: %w", err)
	}

	var root yaml.Node
	if err := yaml.Unmarshal(raw, &root); err != nil {
		ds.Errorf("FORGE001", path, "", "fix the YAML syntax", "invalid YAML: %v", err)
		return nil, ds, nil
	}

	var doc any
	if err := yaml.Unmarshal(raw, &doc); err != nil {
		ds.Errorf("FORGE001", path, "", "fix the YAML syntax", "invalid YAML: %v", err)
		return nil, ds, nil
	}
	doc = normalise(doc)

	sch, err := compileSchema(schemaPath)
	if err != nil {
		return nil, ds, err
	}

	lines := map[string]int{}
	if len(root.Content) > 0 {
		collectLines(root.Content[0], "", lines)
	}

	if err := sch.Validate(doc); err != nil {
		var ve *jsonschema.ValidationError
		if asValidationError(err, &ve) {
			for _, leaf := range schemaLeaves(ve) {
				p := joinPath(leaf.InstanceLocation)
				ds.Add(diag.Diagnostic{
					Severity: diag.Error, Check: "FORGE001", File: path, Line: lines[p], Path: p,
					Message: leaf.ErrorKind.LocalizedString(englishPrinter),
					Fix:     "see schemas/manifest.schema.json for the expected shape",
				})
			}
		} else {
			ds.Errorf("FORGE001", path, "", "see schemas/manifest.schema.json", "%v", err)
		}
		return nil, ds, nil
	}

	// Round-trip through JSON so the struct tags used are the json ones, keeping
	// one source of truth for field names between the schema and the types.
	jb, err := json.Marshal(doc)
	if err != nil {
		return nil, ds, fmt.Errorf("re-encode manifest: %w", err)
	}
	var m Manifest
	if err := json.Unmarshal(jb, &m); err != nil {
		return nil, ds, fmt.Errorf("decode manifest: %w", err)
	}
	m.SourceFile = path
	m.lines = lines

	return &m, ds, nil
}
