package render

import (
	"fmt"
	"sort"
	"strings"
)

// PublishedEventFact is one event the resolved graph emits, with its payload
// schema rendered as a TypeScript type.
//
// This is what closes the loop the Next.js choice was made for: publishing an
// event with the wrong payload shape becomes a `tsc` error in the client build
// rather than a runtime surprise in production.
type PublishedEventFact struct {
	Name            string
	ContractVersion int
	Publisher       string
	PayloadType     string
	PerEntity       bool
}

// tsTypeFromSchema converts a JSON Schema fragment to a TypeScript type literal.
//
// It covers the subset capability payload schemas actually use — object,
// string, integer, number, boolean, array, and nullable unions. Anything
// outside that becomes `unknown`, which is honest: a payload the generator does
// not understand should not be given a type that claims otherwise.
func tsTypeFromSchema(schema map[string]any, indent string) string {
	if schema == nil {
		return "unknown"
	}

	switch t := schema["type"].(type) {
	case string:
		return tsScalar(t, schema, indent)
	case []any:
		// A type union, most often ["string", "null"].
		parts := make([]string, 0, len(t))
		for _, v := range t {
			if s, ok := v.(string); ok {
				parts = append(parts, tsScalar(s, schema, indent))
			}
		}
		if len(parts) == 0 {
			return "unknown"
		}
		return strings.Join(parts, " | ")
	}
	return "unknown"
}

func tsScalar(t string, schema map[string]any, indent string) string {
	switch t {
	case "string":
		return "string"
	case "integer", "number":
		return "number"
	case "boolean":
		return "boolean"
	case "null":
		return "null"
	case "array":
		items, _ := schema["items"].(map[string]any)
		inner := tsTypeFromSchema(items, indent)
		if strings.ContainsAny(inner, " |") {
			return "Array<" + inner + ">"
		}
		return inner + "[]"
	case "object":
		props, ok := schema["properties"].(map[string]any)
		if !ok || len(props) == 0 {
			return "Record<string, unknown>"
		}
		required := map[string]bool{}
		if req, ok := schema["required"].([]any); ok {
			for _, r := range req {
				if s, ok := r.(string); ok {
					required[s] = true
				}
			}
		}
		// Sorted: Go randomises map iteration, and unsorted output would be a
		// spurious diff on every run.
		names := make([]string, 0, len(props))
		for name := range props {
			names = append(names, name)
		}
		sort.Strings(names)

		var b strings.Builder
		b.WriteString("{\n")
		for _, name := range names {
			sub, _ := props[name].(map[string]any)
			opt := ""
			if !required[name] {
				opt = "?"
			}
			fmt.Fprintf(&b, "%s  %s%s: %s\n", indent, tsPropName(name), opt,
				tsTypeFromSchema(sub, indent+"  "))
		}
		b.WriteString(indent + "}")
		return b.String()
	}
	return "unknown"
}

// tsPropName quotes a property name that is not a bare identifier.
func tsPropName(name string) string {
	if name == "" {
		return `""`
	}
	for i, r := range name {
		ok := r == '_' || r == '$' ||
			(r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') ||
			(i > 0 && r >= '0' && r <= '9')
		if !ok {
			return fmt.Sprintf("%q", name)
		}
	}
	return name
}
