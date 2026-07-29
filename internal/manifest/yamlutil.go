package manifest

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"

	"github.com/santhosh-tekuri/jsonschema/v6"
	"golang.org/x/text/language"
	"golang.org/x/text/message"
	"gopkg.in/yaml.v3"
)

var englishPrinter = message.NewPrinter(language.English)

func asValidationError(err error, target **jsonschema.ValidationError) bool {
	return errors.As(err, target)
}

func schemaLeaves(e *jsonschema.ValidationError) []*jsonschema.ValidationError {
	if len(e.Causes) == 0 {
		return []*jsonschema.ValidationError{e}
	}
	var out []*jsonschema.ValidationError
	for _, c := range e.Causes {
		out = append(out, schemaLeaves(c)...)
	}
	return out
}

func joinPath(loc []string) string { return strings.Join(loc, "/") }

func compileSchema(path string) (*jsonschema.Schema, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read manifest schema: %w", err)
	}
	var doc any
	if err := json.Unmarshal(raw, &doc); err != nil {
		return nil, fmt.Errorf("parse manifest schema: %w", err)
	}
	c := jsonschema.NewCompiler()
	if err := c.AddResource("manifest.schema.json", doc); err != nil {
		return nil, fmt.Errorf("add manifest schema: %w", err)
	}
	return c.Compile("manifest.schema.json")
}

// normalise converts the map[any]any that YAML can produce into the
// map[string]any the JSON Schema validator requires.
func normalise(v any) any {
	switch t := v.(type) {
	case map[string]any:
		out := make(map[string]any, len(t))
		for k, val := range t {
			out[k] = normalise(val)
		}
		return out
	case map[any]any:
		out := make(map[string]any, len(t))
		for k, val := range t {
			out[fmt.Sprint(k)] = normalise(val)
		}
		return out
	case []any:
		out := make([]any, len(t))
		for i, val := range t {
			out[i] = normalise(val)
		}
		return out
	default:
		return v
	}
}

// collectLines walks the YAML node tree recording the source line of every
// value, keyed by its document path. This is what lets a schema violation be
// reported as file:line rather than as a path the reader has to go hunting for.
func collectLines(n *yaml.Node, prefix string, out map[string]int) {
	if n == nil {
		return
	}
	switch n.Kind {
	case yaml.DocumentNode:
		for _, c := range n.Content {
			collectLines(c, prefix, out)
		}
	case yaml.MappingNode:
		for i := 0; i+1 < len(n.Content); i += 2 {
			key, val := n.Content[i], n.Content[i+1]
			path := key.Value
			if prefix != "" {
				path = prefix + "/" + key.Value
			}
			// Point at the key: that is the line a reader needs to edit.
			out[path] = key.Line
			collectLines(val, path, out)
		}
	case yaml.SequenceNode:
		for i, c := range n.Content {
			path := strconv.Itoa(i)
			if prefix != "" {
				path = prefix + "/" + path
			}
			out[path] = c.Line
			collectLines(c, path, out)
		}
	}
}
