package validate

import (
	"strings"
	"testing"

	"github.com/originplatformlabs/forge/internal/catalog"
	"github.com/originplatformlabs/forge/internal/diag"
	"github.com/originplatformlabs/forge/internal/manifest"
	"github.com/originplatformlabs/forge/internal/resolve"
	"github.com/originplatformlabs/forge/internal/spec"
)

func cap(id string, tier spec.Tier, requires ...string) *spec.Capability {
	c := &spec.Capability{
		SpecVersion: 1, ID: id, Version: "1.0.0", KernelRange: "^1.0.0",
		Name: id, Tier: tier, Price: spec.Price{Model: "included"},
	}
	for _, r := range requires {
		c.Requires = append(c.Requires, spec.Dependency{ID: r, Range: "^1.0.0"})
	}
	return c
}

func mf(ids ...string) *manifest.Manifest {
	m := &manifest.Manifest{
		ManifestVersion: 1,
		Catalog:         manifest.CatalogPin{Snapshot: "2026-07-15"},
		Product:         manifest.Product{ID: "t", Name: "Test"},
		SourceFile:      "forge.yaml",
	}
	for _, id := range ids {
		m.Capabilities = append(m.Capabilities, manifest.Selection{ID: id})
	}
	return m
}

func run(m *manifest.Manifest, caps ...*spec.Capability) *diag.Set {
	g, _ := resolve.Resolve(m, catalog.New(caps...))
	return Run(m, g)
}

func find(ds *diag.Set, check string) *diag.Diagnostic {
	for i := range ds.Items() {
		if ds.Items()[i].Check == check {
			return &ds.Items()[i]
		}
	}
	return nil
}

// Check 8 is the one that catches the most expensive class of bug: a publisher
// emitting a payload version no consumer understands.
func TestConsumerVersionMismatchIsCaughtBeforeAnythingIsBuilt(t *testing.T) {
	pub := cap("pay.card", spec.TierCapability)
	pub.Publishes = []spec.Published{{Name: "payment.succeeded", ContractVersion: 2}}
	sub := cap("pay.invoices", spec.TierCapability)
	sub.Consumes = []spec.Consumed{{
		Name: "payment.succeeded", ContractVersions: []int{1}, Required: true,
		Reason: "mark the invoice paid",
	}}

	ds := run(mf("pay.card", "pay.invoices"), pub, sub)
	d := find(ds, CheckEventContract)
	if d == nil {
		t.Fatalf("want a contract-version mismatch, got %v", ds.Items())
	}
	if !strings.Contains(d.Message, "contract version 2") || !strings.Contains(d.Message, "v1") {
		t.Errorf("message must name both versions, got %q", d.Message)
	}
	if d.Fix == "" {
		t.Error("diagnostic must name a fix")
	}

	// Matching versions must produce nothing.
	sub.Consumes[0].ContractVersions = []int{1, 2}
	if ds := run(mf("pay.card", "pay.invoices"), pub, sub); find(ds, CheckEventContract) != nil {
		t.Errorf("unexpected diagnostic when versions match: %v", ds.Items())
	}
}

func TestRequiredEventWithNoPublisherFailsButOptionalDoesNot(t *testing.T) {
	sub := cap("pay.invoices", spec.TierCapability)
	sub.Consumes = []spec.Consumed{{
		Name: "milestone.due", ContractVersions: []int{1}, Required: true,
		Reason: "invoice a due milestone",
	}}
	if find(run(mf("pay.invoices"), sub), CheckEventContract) == nil {
		t.Error("a required subscription with no publisher must be an error")
	}

	// An optional subscription is inert when nothing publishes it, which is what
	// lets pay.invoices ship without pay.deposits.
	sub.Consumes[0].Required = false
	if d := find(run(mf("pay.invoices"), sub), CheckEventContract); d != nil {
		t.Errorf("an optional subscription must be inert, got %v", d)
	}
}

// Check 13, added after the catalog review found ops.queue and ops.dispatch
// both publishing job.started with unrelated payloads.
func TestTwoCapabilitiesCannotPublishTheSameEventName(t *testing.T) {
	a := cap("ops.queue", spec.TierCapability)
	a.Publishes = []spec.Published{{Name: "job.started", ContractVersion: 1}}
	b := cap("ops.dispatch", spec.TierCapability)
	b.Publishes = []spec.Published{{Name: "job.started", ContractVersion: 1}}

	ds := run(mf("ops.queue", "ops.dispatch"), a, b)
	d := find(ds, CheckEventOwner)
	if d == nil {
		t.Fatalf("want a duplicate-publisher error, got %v", ds.Items())
	}
	if !strings.Contains(d.Fix, "ops.dispatch.started") && !strings.Contains(d.Fix, "ops.queue.started") {
		t.Errorf("fix should suggest namespacing, got %q", d.Fix)
	}
}

func TestKernelRangeIntersectionMustBeNonEmpty(t *testing.T) {
	a := cap("pay.card", spec.TierCapability)
	a.KernelRange = "^1.0.0"
	b := cap("pay.invoices", spec.TierCapability)
	b.KernelRange = "^2.0.0"

	ds := run(mf("pay.card", "pay.invoices"), a, b)
	d := find(ds, CheckKernelRange)
	if d == nil {
		t.Fatalf("want a kernel range conflict, got %v", ds.Items())
	}
	// The message must name the two capabilities that actually disagree.
	if !strings.Contains(d.Message, "pay.card") || !strings.Contains(d.Message, "pay.invoices") {
		t.Errorf("message must name both capabilities, got %q", d.Message)
	}

	b.KernelRange = ">=1.2.0 <3.0.0"
	if d := find(run(mf("pay.card", "pay.invoices"), a, b), CheckKernelRange); d != nil {
		t.Errorf("overlapping ranges must pass, got %v", d)
	}
}

func TestMissingCredentialIsCaughtAtValidateNotApply(t *testing.T) {
	c := cap("pay.card", spec.TierCapability)
	c.External = []spec.External{{
		Service: "Stripe", Purpose: "charges",
		Credentials: []spec.Credential{{Name: "STRIPE_SECRET_KEY", Description: "secret key"}},
	}}

	ds := run(mf("pay.card"), c)
	d := find(ds, CheckCredentials)
	if d == nil {
		t.Fatalf("want a missing-credential error, got %v", ds.Items())
	}
	if !strings.Contains(d.Message, "STRIPE_SECRET_KEY") {
		t.Errorf("message must name the credential, got %q", d.Message)
	}

	m := mf("pay.card")
	m.Integrations = map[string]manifest.Integration{
		"stripe": {Credentials: map[string]manifest.SecretRef{
			"STRIPE_SECRET_KEY": {SecretRef: "acme/stripe_secret_key"},
		}},
	}
	if d := find(run(m, c), CheckCredentials); d != nil {
		t.Errorf("a bound credential must pass, got %v", d)
	}
}

func TestPrivacyHandlersOnlyRequiredWhenPrivacyIsEnabled(t *testing.T) {
	c := cap("pay.card", spec.TierCapability)
	c.Owns = []spec.Entity{{Name: "Charge", Kind: "table", PersonalData: true}}

	// Without data.privacy the handlers are not required.
	if d := find(run(mf("pay.card"), c), CheckPrivacy); d != nil {
		t.Errorf("privacy handlers must not be required without data.privacy, got %v", d)
	}

	priv := cap("data.privacy", spec.TierCapability)
	ds := run(mf("pay.card", "data.privacy"), c, priv)
	if find(ds, CheckPrivacy) == nil {
		t.Fatalf("want a privacy-handler error, got %v", ds.Items())
	}

	c.Owns[0].Privacy = &spec.Privacy{ExportHandler: "exportCharges", DeletionStrategy: "anonymize"}
	if d := find(run(mf("pay.card", "data.privacy"), c, priv), CheckPrivacy); d != nil {
		t.Errorf("declared handlers must pass, got %v", d)
	}
}

func TestClientEntityCollidingWithACapabilityEntityIsRejected(t *testing.T) {
	c := cap("pay.invoices", spec.TierCapability)
	c.Owns = []spec.Entity{{Name: "Invoice", Kind: "table"}}

	m := mf("pay.invoices")
	m.Entities = []manifest.Entity{{Name: "Invoice", Fields: []manifest.Field{{Name: "x", Type: "string"}}}}

	ds := run(m, c)
	d := find(ds, CheckEntityNames)
	if d == nil {
		t.Fatalf("want an entity collision error, got %v", ds.Items())
	}
	if d.Path != "entities/0/name" {
		t.Errorf("Path = %q, want entities/0/name", d.Path)
	}
}

func TestTwoCapabilitiesCannotOwnTheSameEntity(t *testing.T) {
	a := cap("x.a", spec.TierCapability)
	a.Owns = []spec.Entity{{Name: "Widget", Kind: "table"}}
	b := cap("x.b", spec.TierCapability)
	b.Owns = []spec.Entity{{Name: "Widget", Kind: "table"}}

	if find(run(mf("x.a", "x.b"), a, b), CheckEntityNames) == nil {
		t.Error("two capabilities owning one entity must be an error")
	}
}

func TestIntegrationCapabilitiesRequireADurableQueue(t *testing.T) {
	c := cap("integrate.accounting", spec.TierCapability)
	ds := run(mf("integrate.accounting"), c)
	if find(ds, CheckAsyncDurable) == nil {
		t.Fatalf("an integration capability without ops.queue must be an error, got %v", ds.Items())
	}

	q := cap("ops.queue", spec.TierCapability)
	if d := find(run(mf("integrate.accounting", "ops.queue"), c, q), CheckAsyncDurable); d != nil {
		t.Errorf("with ops.queue present this must pass, got %v", d)
	}
}

func TestEveryDiagnosticNamesAFix(t *testing.T) {
	// The brief's constraint: errors name the file, the line, and the fix. A
	// diagnostic that cannot say what to do is not finished.
	a := cap("pay.card", spec.TierCapability)
	a.KernelRange = "^1.0.0"
	a.Publishes = []spec.Published{{Name: "payment.succeeded", ContractVersion: 2}}
	a.External = []spec.External{{Service: "Stripe", Purpose: "charges",
		Credentials: []spec.Credential{{Name: "STRIPE_SECRET_KEY", Description: "key"}}}}
	b := cap("pay.invoices", spec.TierCapability)
	b.KernelRange = "^2.0.0"
	b.Consumes = []spec.Consumed{{Name: "payment.succeeded", ContractVersions: []int{1},
		Required: true, Reason: "mark paid"}}

	ds := run(mf("pay.card", "pay.invoices"), a, b)
	if len(ds.Items()) == 0 {
		t.Fatal("expected diagnostics")
	}
	for _, d := range ds.Items() {
		if d.Fix == "" {
			t.Errorf("%s has no fix: %s", d.Check, d.Message)
		}
		if d.Message == "" {
			t.Errorf("%s has no message", d.Check)
		}
	}
}

func TestValidationDoesNotShortCircuit(t *testing.T) {
	// One command run must report every problem, not the first one.
	a := cap("pay.card", spec.TierCapability)
	a.KernelRange = "^1.0.0"
	a.External = []spec.External{{Service: "Stripe", Purpose: "charges",
		Credentials: []spec.Credential{{Name: "STRIPE_SECRET_KEY", Description: "key"}}}}
	a.Owns = []spec.Entity{{Name: "Charge", Kind: "table", PersonalData: true}}
	b := cap("pay.invoices", spec.TierCapability)
	b.KernelRange = "^2.0.0"
	priv := cap("data.privacy", spec.TierCapability)

	ds := run(mf("pay.card", "pay.invoices", "data.privacy"), a, b, priv)
	seen := map[string]bool{}
	for _, d := range ds.Items() {
		seen[d.Check] = true
	}
	for _, want := range []string{CheckKernelRange, CheckCredentials, CheckPrivacy} {
		if !seen[want] {
			t.Errorf("check %s did not run; validation appears to short-circuit (saw %v)", want, seen)
		}
	}
}
