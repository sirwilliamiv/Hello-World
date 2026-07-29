// Package spec holds the in-memory form of a capability specification.
//
// The JSON Schema in schemas/capability.schema.json is authoritative for what a
// legal specification looks like; this package is the typed view the engine
// works with after that validation has passed.
package spec

// Tier classifies how a capability participates in a product.
type Tier string

const (
	TierKernel     Tier = "kernel"     // always present, never in a manifest
	TierCapability Tier = "capability" // selectable
	TierUpgrade    Tier = "upgrade"    // selectable, supersedes something else
)

// Capability is one entry in the catalog.
type Capability struct {
	SpecVersion       int            `json:"spec_version"`
	ID                string         `json:"id"`
	Version           string         `json:"version"`
	KernelRange       string         `json:"kernel_range"`
	Name              string         `json:"name"`
	Trigger           string         `json:"trigger,omitempty"`
	Summary           string         `json:"summary,omitempty"`
	Tier              Tier           `json:"tier"`
	Price             Price          `json:"price"`
	IntegrationWeight int            `json:"integration_weight"`
	Requires          []Dependency   `json:"requires,omitempty"`
	Enhances          []Enhancement  `json:"enhances,omitempty"`
	Conflicts         []Conflict     `json:"conflicts,omitempty"`
	Upgrades          *UpgradeTarget `json:"upgrades,omitempty"`
	Owns              []Entity       `json:"owns,omitempty"`
	Extends           []Extension    `json:"extends,omitempty"`
	Publishes         []Published    `json:"publishes,omitempty"`
	Consumes          []Consumed     `json:"consumes,omitempty"`
	Exposes           []Exposed      `json:"exposes,omitempty"`
	Registers         []Registration `json:"registers,omitempty"`
	External          []External     `json:"external,omitempty"`
	Config            map[string]any `json:"config,omitempty"`
	Slots             []Slot         `json:"slots,omitempty"`
	Surfaces          []Surface      `json:"surfaces,omitempty"`
	Tests             Tests          `json:"tests,omitempty"`
	Migrations        []Migration    `json:"migrations,omitempty"`
	Templates         []Template     `json:"templates,omitempty"`
	Package           *Package       `json:"package,omitempty"`

	// SourceFile is where this specification was loaded from. Diagnostics name
	// it, because an error that does not say which file to open is unactionable.
	SourceFile string `json:"-"`
}

// IsKernel reports whether this capability is present in every product by
// definition and may therefore never appear in a manifest.
func (c *Capability) IsKernel() bool { return c.Tier == TierKernel }

type Price struct {
	Model       string `json:"model"` // included | fixed | quoted
	AmountMinor int    `json:"amount_minor,omitempty"`
	Currency    string `json:"currency,omitempty"`
}

type Dependency struct {
	ID     string `json:"id"`
	Range  string `json:"range"`
	Reason string `json:"reason,omitempty"`
}

type Enhancement struct {
	Target  string `json:"target"` // capability id, "ns.*" glob, or a selector
	Range   string `json:"range,omitempty"`
	Unlocks string `json:"unlocks"`
}

type Conflict struct {
	ID     string `json:"id"`
	Reason string `json:"reason"`
}

type UpgradeTarget struct {
	ID                  string   `json:"id"`
	Migration           string   `json:"migration"`
	InterfaceExceptions []string `json:"interface_exceptions,omitempty"`
}

type Entity struct {
	Name         string   `json:"name"`
	Kind         string   `json:"kind"` // table | value_type | registry
	Description  string   `json:"description,omitempty"`
	PersonalData bool     `json:"personal_data,omitempty"`
	TenantScoped *bool    `json:"tenant_scoped,omitempty"` // pointer: default is true
	Listable     *bool    `json:"listable,omitempty"`      // pointer: default is true
	Searchable   bool     `json:"searchable,omitempty"`
	AppendOnly   bool     `json:"append_only,omitempty"`
	Privacy      *Privacy `json:"privacy,omitempty"`
}

// IsTenantScoped applies the schema default (true) for an omitted flag.
func (e Entity) IsTenantScoped() bool { return e.TenantScoped == nil || *e.TenantScoped }

type Privacy struct {
	ExportHandler    string `json:"export_handler,omitempty"`
	DeletionStrategy string `json:"deletion_strategy,omitempty"`
	DeletionHandler  string `json:"deletion_handler,omitempty"`
	RetentionNote    string `json:"retention_note,omitempty"`
}

type Extension struct {
	Target string           `json:"target"`
	Fields []ExtensionField `json:"fields"`
	Reason string           `json:"reason"`
}

type ExtensionField struct {
	Name     string `json:"name"`
	Type     string `json:"type"`
	Nullable *bool  `json:"nullable,omitempty"`
	Indexed  bool   `json:"indexed,omitempty"`
}

type Published struct {
	Name            string         `json:"name"`
	ContractVersion int            `json:"contract_version"`
	Payload         map[string]any `json:"payload"`
	Description     string         `json:"description,omitempty"`
	PerEntity       bool           `json:"per_entity,omitempty"`
	Deprecates      int            `json:"deprecates,omitempty"`
}

type Consumed struct {
	Name             string `json:"name"` // event name, glob, or "**"
	ContractVersions []int  `json:"contract_versions"`
	Required         bool   `json:"required"`
	Reason           string `json:"reason"`
	Handler          string `json:"handler,omitempty"`
}

// Handles reports whether this consumer accepts the given contract version.
func (c Consumed) Handles(version int) bool {
	for _, v := range c.ContractVersions {
		if v == version {
			return true
		}
	}
	return false
}

type Exposed struct {
	Kind          string `json:"kind"`
	Name          string `json:"name"`
	Signature     string `json:"signature,omitempty"`
	Path          string `json:"path,omitempty"`
	Stability     string `json:"stability,omitempty"`
	AgentCallable bool   `json:"agent_callable,omitempty"`
	Consequence   string `json:"consequence,omitempty"`
	Description   string `json:"description,omitempty"`
}

type Registration struct {
	Registry    string           `json:"registry"` // "<capability>:<registry>"
	Entries     []map[string]any `json:"entries"`
	WhenPresent *bool            `json:"when_present,omitempty"`
}

type External struct {
	Service     string       `json:"service"`
	Purpose     string       `json:"purpose"`
	Optional    bool         `json:"optional,omitempty"`
	Via         string       `json:"via,omitempty"`
	Credentials []Credential `json:"credentials"`
}

type Credential struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	Scope       string `json:"scope,omitempty"`
	Optional    bool   `json:"optional,omitempty"`
}

type Slot struct {
	Name        string `json:"name"`
	Signature   string `json:"signature"`
	Description string `json:"description"`
	When        string `json:"when,omitempty"`
	Required    bool   `json:"required,omitempty"`
}

type Surface struct {
	Area        string   `json:"area"`
	Name        string   `json:"name"`
	Path        string   `json:"path,omitempty"`
	Nav         *NavItem `json:"nav,omitempty"`
	Permission  string   `json:"permission,omitempty"`
	Description string   `json:"description,omitempty"`
}

type NavItem struct {
	Label string `json:"label,omitempty"`
	Group string `json:"group,omitempty"`
	Order int    `json:"order,omitempty"`
}

type Tests struct {
	Smoke    []SmokeTest    `json:"smoke,omitempty"`
	Contract []ContractTest `json:"contract,omitempty"`
}

type SmokeTest struct {
	Name                string `json:"name"`
	Asserts             string `json:"asserts"`
	RequiresCredentials bool   `json:"requires_credentials,omitempty"`
}

type ContractTest struct {
	With      string `json:"with"`
	Scenario  string `json:"scenario"`
	Asserts   string `json:"asserts"`
	Mandatory bool   `json:"mandatory,omitempty"`
}

type Migration struct {
	ID               string `json:"id"`
	IntroducedIn     string `json:"introduced_in"`
	Up               string `json:"up"`
	Down             string `json:"down"`
	Kind             string `json:"kind,omitempty"`
	Destructive      bool   `json:"destructive,omitempty"`
	RequiredForMajor bool   `json:"required_for_major,omitempty"`
	Description      string `json:"description,omitempty"`
}

type Template struct {
	ID          string `json:"id"`
	Version     string `json:"version"`
	Output      string `json:"output"`
	Zone        string `json:"zone"` // managed | seeded
	Description string `json:"description,omitempty"`
}

type Package struct {
	Name             string            `json:"name"`
	PeerRequirements map[string]string `json:"peer_requirements,omitempty"`
}
