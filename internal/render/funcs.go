package render

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"text/template"
)

// funcs is the closed set of helpers templates may use. Nothing here reads the
// clock, the environment, or the filesystem.
func funcs() template.FuncMap {
	return template.FuncMap{
		"json": func(v any) (string, error) {
			b, err := json.Marshal(v)
			return string(b), err
		},
		// jsonIndent sorts object keys, because Go's encoder does but a
		// hand-built string would not, and unsorted output is a spurious diff.
		"jsonIndent": func(indent string, v any) (string, error) {
			b, err := json.MarshalIndent(v, indent, "  ")
			return string(b), err
		},
		"quote":      func(s string) string { return fmt.Sprintf("%q", s) },
		"camel":      camel,
		"pascal":     pascal,
		"snake":      snake,
		"kebab":      func(s string) string { return strings.ReplaceAll(snake(s), "_", "-") },
		"upper":      strings.ToUpper,
		"lower":      strings.ToLower,
		"join":       strings.Join,
		"contains":   strings.Contains,
		"hasPrefix":  strings.HasPrefix,
		"trimPrefix": strings.TrimPrefix,
		"sorted": func(in []string) []string {
			out := append([]string{}, in...)
			sort.Strings(out)
			return out
		},
		"cfg": func(cfg map[string]any, key string, fallback any) any {
			if v, ok := cfg[key]; ok {
				return v
			}
			return fallback
		},
		"cfgStr": func(cfg map[string]any, key, fallback string) string {
			if v, ok := cfg[key]; ok {
				if s, ok := v.(string); ok {
					return s
				}
				return fmt.Sprint(v)
			}
			return fallback
		},
		// sqlType maps a manifest field type to a Postgres column type. Money is
		// an integer of minor units: floating point currency is a defect.
		"sqlType": sqlType,
		// tsType maps a manifest field type to a TypeScript type.
		"tsType": tsType,
		// list gives array-typed config a correctly-typed fallback. `dict` was
		// being used for this, which would render `{}` for an array field if a
		// capability ever declared one without a default — the merged spec
		// default hides it today, so it is a trap rather than a live bug.
		"list": func(items ...any) []any { return items },
		"dict": func(pairs ...any) (map[string]any, error) {
			if len(pairs)%2 != 0 {
				return nil, fmt.Errorf("dict requires an even number of arguments")
			}
			out := make(map[string]any, len(pairs)/2)
			for i := 0; i < len(pairs); i += 2 {
				k, ok := pairs[i].(string)
				if !ok {
					return nil, fmt.Errorf("dict keys must be strings")
				}
				out[k] = pairs[i+1]
			}
			return out, nil
		},
	}
}

func sqlType(t string) string {
	if strings.HasPrefix(t, "ref:") {
		return "uuid"
	}
	switch t {
	case "string", "email", "phone", "url":
		return "text"
	case "text":
		return "text"
	case "integer":
		return "bigint"
	case "decimal":
		return "numeric(19,4)"
	case "boolean":
		return "boolean"
	case "date":
		return "date"
	case "datetime":
		return "timestamptz"
	case "money":
		return "bigint" // minor units
	case "json":
		return "jsonb"
	case "file":
		return "uuid"
	default:
		return "text"
	}
}

func tsType(t string) string {
	if strings.HasPrefix(t, "ref:") {
		return "string"
	}
	if strings.HasPrefix(t, "refs:") {
		return "string[]"
	}
	switch t {
	case "integer", "money":
		return "number"
	case "decimal":
		return "string" // exact decimal, never a float
	case "boolean":
		return "boolean"
	case "date", "datetime":
		return "Date"
	case "json":
		return "unknown"
	default:
		return "string"
	}
}

func splitWords(s string) []string {
	var words []string
	var cur strings.Builder
	for i, r := range s {
		switch {
		case r == '.' || r == '_' || r == '-' || r == ' ' || r == '/':
			if cur.Len() > 0 {
				words = append(words, cur.String())
				cur.Reset()
			}
		case r >= 'A' && r <= 'Z' && i > 0 && cur.Len() > 0:
			words = append(words, cur.String())
			cur.Reset()
			cur.WriteRune(r)
		default:
			cur.WriteRune(r)
		}
	}
	if cur.Len() > 0 {
		words = append(words, cur.String())
	}
	return words
}

func pascal(s string) string {
	var b strings.Builder
	for _, w := range splitWords(s) {
		if w == "" {
			continue
		}
		b.WriteString(strings.ToUpper(w[:1]))
		b.WriteString(strings.ToLower(w[1:]))
	}
	return b.String()
}

func camel(s string) string {
	p := pascal(s)
	if p == "" {
		return p
	}
	return strings.ToLower(p[:1]) + p[1:]
}

func snake(s string) string {
	words := splitWords(s)
	for i := range words {
		words[i] = strings.ToLower(words[i])
	}
	return strings.Join(words, "_")
}
