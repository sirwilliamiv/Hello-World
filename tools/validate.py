#!/usr/bin/env python3
"""Validate the Phase 0 artifacts: both schemas are legal JSON Schema, every
kernel capability validates against capability.schema.json, and the annotated
manifest validates against manifest.schema.json."""
import json, sys, glob, os
import yaml
from jsonschema import Draft202012Validator

ROOT = "/home/user/Hello-World"
fail = 0

def load(p):
    with open(p) as f:
        return json.load(f)

# 1. Both schemas must themselves be legal Draft 2020-12.
schemas = {}
for name in ("capability", "manifest"):
    p = f"{ROOT}/schemas/{name}.schema.json"
    s = load(p)
    try:
        Draft202012Validator.check_schema(s)
        print(f"PASS  schema is legal Draft 2020-12: {name}.schema.json")
    except Exception as e:
        print(f"FAIL  schema is illegal: {name}.schema.json\n      {e}")
        fail += 1
    schemas[name] = s

cap_v = Draft202012Validator(schemas["capability"])
man_v = Draft202012Validator(schemas["manifest"])

# 2. Every kernel capability validates.
files = sorted(glob.glob(f"{ROOT}/catalog/kernel/*.capability.json"))
print(f"\n-- {len(files)} kernel capability specs --")
for p in files:
    doc = load(p)
    doc.pop("$schema", None)   # local relative ref, not part of the instance
    errs = sorted(cap_v.iter_errors(doc), key=lambda e: list(e.path))
    if errs:
        fail += 1
        print(f"FAIL  {os.path.basename(p)}")
        for e in errs[:6]:
            print(f"      at {'/'.join(map(str, e.path)) or '<root>'}: {e.message}")
    else:
        print(f"PASS  {os.path.basename(p)}  ({doc['id']} {doc['version']})")

# 3. The annotated manifest validates.
print("\n-- manifest --")
mp = f"{ROOT}/examples/acme.forge.yaml"
with open(mp) as f:
    m = yaml.safe_load(f)
errs = sorted(man_v.iter_errors(m), key=lambda e: list(e.path))
if errs:
    fail += 1
    print("FAIL  acme.forge.yaml")
    for e in errs[:10]:
        print(f"      at {'/'.join(map(str, e.path)) or '<root>'}: {e.message}")
else:
    print("PASS  acme.forge.yaml")

# 4. Cross-checks the engine will later enforce, run here by hand so the
#    reference kernel is not internally inconsistent from day one.
print("\n-- kernel cross-checks --")
caps = {}
for p in files:
    d = load(p); d.pop("$schema", None); caps[d["id"]] = d

ids = set(caps)
for cid, c in caps.items():
    for r in c.get("requires", []):
        if r["id"] not in ids:
            print(f"FAIL  {cid} requires unknown capability {r['id']}"); fail += 1

published = {}
for cid, c in caps.items():
    for e in c.get("publishes", []):
        published.setdefault(e["name"], []).append((cid, e["contract_version"]))

def matches(pattern, name):
    if pattern == "**":
        return True
    if pattern.endswith(".*"):
        return name.startswith(pattern[:-1])
    return pattern == name

for cid, c in caps.items():
    for con in c.get("consumes", []):
        hits = [n for n in published if matches(con["name"], n)]
        if not hits and con["required"]:
            print(f"FAIL  {cid} requires event '{con['name']}' with no publisher in the kernel"); fail += 1
        for n in hits:
            for pub_id, ver in published[n]:
                if ver not in con["contract_versions"]:
                    print(f"FAIL  {pub_id} emits {n} v{ver}; {cid} handles {con['contract_versions']}"); fail += 1

entities = {}
for cid, c in caps.items():
    for e in c.get("owns", []):
        if e["name"] in entities:
            print(f"FAIL  entity {e['name']} owned by both {entities[e['name']]} and {cid}"); fail += 1
        entities[e["name"]] = cid

for cid, c in caps.items():
    for reg in c.get("registers", []):
        owner, rname = reg["registry"].split(":")
        target = caps.get(owner)
        if not target:
            print(f"FAIL  {cid} registers into unknown capability {owner}"); fail += 1
            continue
        if not any(x["kind"] == "registry" and x["name"] == rname for x in target.get("exposes", [])):
            print(f"FAIL  {cid} registers into {reg['registry']}, which {owner} does not expose"); fail += 1
        deps = {r["id"] for r in c.get("requires", [])} | {
            e["target"] for e in c.get("enhances", []) if isinstance(e.get("target"), str)}
        if owner not in deps:
            print(f"FAIL  {cid} registers into {owner} without declaring it in requires or enhances"); fail += 1

print(f"  {len(entities)} entities owned, no collisions" if not fail else "")
print(f"\n{'ALL CHECKS PASSED' if fail == 0 else str(fail) + ' FAILURE(S)'}")
sys.exit(1 if fail else 0)
