# refresh-tooling

Planning and verification tooling for the **codebase-modernization-refresh** spec.

This workspace holds the checkers/components and property-based tests that drive and
validate the behavior-preserving modernization refresh of the `saas-cell-based-architecture`
repository and its companion AWS Workshop Studio content.

## Layout

```
refresh-tooling/
├── ts/                 TypeScript package (fast-check + Jest)
│   ├── src/
│   │   ├── models.ts   Shared data-model types (the contract between change-classes)
│   │   └── *.ts        Checkers/components (Dependency Upgrade Planner, Lockstep
│   │                   Comparator, Runtime Alignment Checker, Aurora Engine Selector,
│   │                   Artifact Untracker, line-anchor/semver/answer-key/bootstrap
│   │                   checkers, Verification Runner)
│   └── tests live alongside sources as *.test.ts
└── py/                 Python package (pytest + hypothesis)
    └── refresh_tooling/ SQL-side checkers and the source-edit helpers
        └── tests/      SQL-side property tests (no-interpolation, safe-identifier,
                        hardened-query equivalence, python-dep hygiene)
```

The two languages match the existing repositories and the design's Testing Strategy:

- **TypeScript** (`fast-check` + Jest) — planning/verification checkers and the
  TypeScript-side property tests.
- **Python** (`hypothesis` + `pytest`) — the SQL-side property tests and the source
  edits to `rds.py`, `product.py`, `authorizer.py`, and `requirements.txt`.

## Getting started

TypeScript:

```bash
cd ts
npm install
npm run build
npm test
```

Python:

```bash
cd py
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements-dev.txt
pytest
```

Property tests run a minimum of 100 iterations and are tagged
`Feature: codebase-modernization-refresh, Property N`.

## Recorded planning artifacts

- `assumption-log.json` — resolved target versions, substitutions, engine decision,
  bootstrap elements, and maintainer constraints (task 1.4).
- `inventory/compat-inventory.json` — Construct-API compatibility inventory (task 4.1).
- `workshop-sync-flags.json` — **Phase 2 synchronization flags** emitted by task 8.4
  (Req 9.6). For each CC7 SQL-hardening edit (tasks 8.1 / 8.2) that altered a code
  region referenced by a workshop `Line_Anchor` or `Answer_Key`, a flag is recorded
  for Phase 2: `Line_Anchor` flags feed CC9 line re-anchoring (task 13) and
  `Answer_Key` flags feed CC10 answer-key sync (task 14). The typed shape is
  `WorkshopSyncFlag` in `ts/src/models.ts`. The flag is the deliverable; the actual
  re-anchoring/answer-key regeneration happens in Phase 2.
