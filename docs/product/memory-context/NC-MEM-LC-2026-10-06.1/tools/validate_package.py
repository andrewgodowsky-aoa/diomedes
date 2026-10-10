#!/usr/bin/env python3
"""Validate a memory/context handoff package, not the Nectovia implementation.

Standard-library checks are always available. --schemas uses an already installed
jsonschema package and never downloads or installs anything. Exit nonzero on failure.
"""
from __future__ import annotations
import argparse
import copy
import hashlib
import json
import re
import sys
from pathlib import Path
from urllib.parse import unquote, urlsplit


def load(path: Path):
    return json.loads(path.read_text(encoding='utf-8'))


def validate(root: Path, schemas: bool, hashes: bool) -> dict:
    checks: list[str] = []
    errors: list[str] = []

    def check(ok: bool, text: str) -> None:
        (checks if ok else errors).append(text)

    payloads = [p for p in root.rglob('*') if p.is_file() and '__pycache__' not in p.parts]
    for path in payloads:
        if path.suffix == '.json':
            try:
                load(path)
            except (ValueError, OSError) as exc:
                errors.append(f'Invalid JSON {path.relative_to(root)}: {exc}')
    check(not errors, 'All JSON files parse')
    work = load(root/'work-items.json')['work_items']
    cases = load(root/'eval/acceptance.json')['cases']
    sources = load(root/'sources.json')['sources']
    ids = [w['id'] for w in work]
    check(set(ids) == {f'W{i:02d}' for i in range(12)} and len(ids) == 12, '12 unique work items')
    expected = {f'{prefix}{i:02d}' for prefix in ('M','L') for i in range(1,49)}
    check(len(cases) == 96 and {c['id'] for c in cases} == expected, '96 unique acceptance specifications')
    check(all(c['status'] == 'specified-not-run' for c in cases), 'Product acceptance remains explicitly unrun')
    check(len(sources) == 24 and len({s['id'] for s in sources}) == 24, '24 unique source records')
    mapping = {w['id']: w for w in work}
    done: set[str] = set()
    visiting: set[str] = set()

    def visit(wid: str) -> None:
        if wid in done:
            return
        if wid in visiting:
            raise ValueError(f'Dependency cycle at {wid}')
        if wid not in mapping:
            raise ValueError(f'Unknown work item {wid}')
        visiting.add(wid)
        for dep in mapping[wid]['depends_on']:
            visit(dep)
        visiting.remove(wid)
        done.add(wid)
    try:
        for wid in ids:
            visit(wid)
        checks.append('Dependency graph references exist and are acyclic')
    except ValueError as exc:
        errors.append(str(exc))
    for w in work:
        assigned = {c['id'] for c in cases if c['owner'] == w['id']}
        check(set(w['acceptance_ids']) == assigned, f"{w['id']} exact acceptance ownership mapping")
        check(bool(w.get('linear_id')) and w.get('linear_url','').startswith('https://linear.app/'), f"{w['id']} has published tracking reference")
        for mode in ('IMPLEMENT','REVIEW'):
            check((root/'prompts'/f"{w['id']}_{mode}.md").is_file(), f"{w['id']} {mode} prompt exists")
    check(all(c['owner'] in mapping for c in cases), 'No acceptance case has an unknown owner')
    check(len(list((root/'prompts').glob('*.md'))) == 25, '25 prompts including kickoff')
    check((root/'prompts/00_OPUS_KICKOFF.md').is_file(), 'Kickoff prompt present')
    for p in payloads:
        if p.suffix != '.md' or 'archive' in p.relative_to(root).parts:
            continue
        # Ignore headings and external resources; only actual Markdown file links.
        for target in re.findall(r'(?<!!)\[[^\]\n]+\]\(([^)\n]+)\)', p.read_text(encoding='utf-8')):
            target = target.strip().strip('<>')
            if urlsplit(target).scheme or target.startswith('#'):
                continue
            rel = unquote(target.split('#',1)[0])
            if not rel:
                continue
            resolved = (p.parent/rel).resolve()
            check(resolved.is_relative_to(root) and resolved.exists(), f'Relative link resolves: {p.name} -> {rel}')
    fixture = root/'eval/generated-smoke'
    manifest = load(fixture/'fixture_manifest.json')
    for rel, digest in manifest['files'].items():
        path = (fixture/rel).resolve()
        check(path.is_relative_to(fixture.resolve()) and path.is_file() and hashlib.sha256(path.read_bytes()).hexdigest() == digest, f'Fixture checksum {rel}')
    rows = load(fixture/'agent/inventory.json')
    gold = load(fixture/'evaluator/gold.json')
    fm = load(fixture/'agent/source_manifest.json')
    check(len(rows) == gold['row_count'] == fm['total_rows'] == manifest['rows'] == 512, '512-row smoke fixture counts agree')
    check(len({(row['tenant_id'],row['record_id'],row['revision']) for row in rows}) == len(rows), 'Smoke fixture canonical row IDs unique')
    check(sum(x['on_hand'] for x in rows) == gold['total_on_hand'], 'Independent on-hand arithmetic matches gold')
    check(sum(x['reserved'] for x in rows) == gold['total_reserved'], 'Independent reserved arithmetic matches gold')
    check(sum(x['on_hand']-x['reserved'] for x in rows) == gold['total_available'], 'Independent available arithmetic matches gold')
    coverage = [i for part in fm['partitions'] for i in range(part['start'],part['end_exclusive'])]
    check(coverage == list(range(len(rows))), 'Partitions cover every row exactly once')
    perturb = load(fixture/'evaluator/perturbations.json')
    check(perturb['steps'] == 100 and len(perturb['forced_rollovers_at_steps']) == 20, '100-step / 20-rollover scenario configured (not executed)')
    check(not manifest['model_evaluation_performed'], 'Fixture labels make no model-performance claim')
    examples = load(root/'contracts/examples.json')
    check(len(examples) == 5, 'Five contract examples')
    schema_result = 'not requested'
    if schemas:
        try:
            from jsonschema import Draft202012Validator, FormatChecker
            schema = load(root/'contracts/records.schema.json')
            Draft202012Validator.check_schema(schema)
            validator = Draft202012Validator(schema, format_checker=FormatChecker())
            for i, value in enumerate(examples):
                validator.validate(value)
                modified = copy.deepcopy(value)
                modified['unrecognizedModelAuthority'] = 'allow-everything'
                check(not validator.is_valid(modified), f'Example {i+1} rejects undeclared authority key')
            checks.append('All five examples satisfy strict JSON Schema with format checks')
            schema_result = 'passed'
        except ImportError:
            errors.append('--schemas requires an already installed jsonschema package; nothing was installed')
        except Exception as exc:
            errors.append(f'Schema validation: {type(exc).__name__}: {exc}')
    if hashes:
        listed: set[str] = set()
        for line in (root/'SHA256SUMS.txt').read_text().splitlines():
            digest, rel = line.split('  ',1)
            path = (root/rel).resolve()
            if not path.is_relative_to(root) or not path.is_file():
                errors.append(f'Invalid checksum path {rel}')
                continue
            listed.add(rel)
            check(hashlib.sha256(path.read_bytes()).hexdigest() == digest, f'Payload checksum {rel}')
        exempt = {'SHA256SUMS.txt','package-validation.json'}
        actual = {p.relative_to(root).as_posix() for p in payloads} - exempt
        check(actual == listed, 'Checksum manifest covers all non-exempt payloads')
    return {'kind':'package-only-validation','package':'NC-MEM-LC-2026-10-06.1','passed':not errors,'checks_passed':len(checks),'checks':checks,'errors':errors,'schema_validation':schema_result,'product_tests_run':False,'model_evaluation_run':False,'specified_product_cases':96}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root',type=Path,default=Path(__file__).resolve().parents[1])
    parser.add_argument('--schemas',action='store_true')
    parser.add_argument('--skip-hashes',action='store_true',help='Authoring only, before freezing payload')
    parser.add_argument('--report',type=Path,help='Write package-validation.json; omitted by default')
    args = parser.parse_args()
    try:
        result = validate(args.root.resolve(),args.schemas,not args.skip_hashes)
        if args.report:
            args.report.write_text(json.dumps(result,indent=2)+'\n',encoding='utf-8')
        print(json.dumps({k:v for k,v in result.items() if k!='checks'},indent=2))
        return 0 if result['passed'] else 1
    except (OSError,ValueError,KeyError,TypeError) as exc:
        print(f'Package validation failed: {exc}',file=sys.stderr)
        return 1
if __name__ == '__main__':
    raise SystemExit(main())
