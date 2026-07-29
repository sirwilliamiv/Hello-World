package catalog

import (
	"errors"
	"strings"

	"github.com/santhosh-tekuri/jsonschema/v6"
	"golang.org/x/text/language"
	"golang.org/x/text/message"
)

var englishPrinter = message.NewPrinter(language.English)

func asValidationError(err error, target **jsonschema.ValidationError) bool {
	return errors.As(err, target)
}

// leaves flattens a validation error tree to its most specific failures. The
// root of the tree only ever says "doesn't validate", which is useless to
// someone trying to fix a file; the leaves name the actual problem.
func leaves(e *jsonschema.ValidationError) []*jsonschema.ValidationError {
	if len(e.Causes) == 0 {
		return []*jsonschema.ValidationError{e}
	}
	var out []*jsonschema.ValidationError
	for _, c := range e.Causes {
		out = append(out, leaves(c)...)
	}
	return out
}

// instancePath renders the location inside the document, e.g. "owns/0/kind".
func instancePath(e *jsonschema.ValidationError) string {
	if len(e.InstanceLocation) == 0 {
		return ""
	}
	return strings.Join(e.InstanceLocation, "/")
}
