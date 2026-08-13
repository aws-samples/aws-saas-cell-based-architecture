"""Seeded-state behavior-equivalence integration tests for hardened queries.

Feature: codebase-modernization-refresh (Task 11.4)
Validates: Requirements 9.4, 9.5

What this module proves
-----------------------
Requirement 9.4 requires that, during the Verification_Suite, *each hardened
query returns a result set identical to the pre-change baseline for the same
inputs and database state*. Requirement 9.5 requires that, *if* a hardened
query's result set diverges from the baseline, the system reports the diverging
query and retains the (post-hardening) behavior pending review.

This is the **integration-style** complement to Property 7 (task 8.7). Where
Property 7 checks the *parameter-binding contract* at the SQL-string level
(template + params -> effective statement) over random inputs, this module
seeds a representative in-memory ``app.products`` table and runs the *concrete
hardened queries* from the refreshed sources against that seeded state:

* ``product.py`` ``get_products`` ->
  ``SELECT product_id, product_name, product_description, product_price,
  tenant_id FROM app.products WHERE tenant_id = %s``
* ``product.py`` ``create_product`` ->
  ``INSERT INTO app.products (...) VALUES (%s, %s, %s, %s, %s)``

For each query it builds BOTH constructions against the *same* seeded state:

* the **baseline** (pre-change) construction — manual single-quote
  interpolation of the value into the SQL text, and
* the **hardened** construction — driver-bound ``%s`` parameters,

then compares the *result sets* (and any table side-effects) the database
actually produces. For legitimate operational inputs the result sets are
identical (Req 9.4). For injection-bearing inputs the comparator detects and
reports the divergence and the harness retains the hardened behavior (Req 9.5).

Why an in-memory harness
------------------------
A live PostgreSQL/Aurora is not available in the tooling environment, so this
module uses a faithful, bounded in-memory query engine. It reuses the
``psycopg`` parameter-binding model from the task 8.7 test
(:func:`bind_literal` / :func:`_bind_all`, which mirror text-mode adaptation
under ``standard_conforming_strings = on``) and adds a small SQL executor that
runs the resulting effective statement(s) against seeded rows. The executor is
intentionally scoped to the statement shapes the refreshed sources emit
(``SELECT`` / ``INSERT`` / ``DELETE`` / ``DROP`` over ``app.products``).
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Sequence, Tuple

import pytest

# Reuse the task 8.7 driver-binding model (psycopg parameter-binding contract).
from refresh_tooling.tests.test_hardened_query_equivalence_property import (
    _bind_all,
    bind_literal,
)

# --------------------------------------------------------------------------- #
# Schema + representative seed                                                 #
# --------------------------------------------------------------------------- #

# Column order matches the concrete SELECT/INSERT in product.py.
PRODUCT_COLUMNS: Tuple[str, ...] = (
    "product_id",
    "product_name",
    "product_description",
    "product_price",
    "tenant_id",
)

# Representative rows across several tenants, including tenant ids that carry
# spaces and non-ASCII characters. None of these legitimate tenant ids contain
# a single quote, so the baseline interpolation is well-defined for them and the
# Req 9.4 equivalence must hold exactly.
SEED_ROWS: Tuple[Dict[str, Any], ...] = (
    {"product_id": 1, "product_name": "Widget", "product_description": "A basic widget", "product_price": 100, "tenant_id": "tenant-123"},
    {"product_id": 2, "product_name": "Gadget", "product_description": "A useful gadget", "product_price": 250, "tenant_id": "tenant-123"},
    {"product_id": 3, "product_name": "Gizmo", "product_description": "Shiny gizmo", "product_price": 75, "tenant_id": "acme_corp"},
    {"product_id": 4, "product_name": "Sprocket", "product_description": "Metal sprocket", "product_price": 40, "tenant_id": "acme_corp"},
    {"product_id": 5, "product_name": "Cog", "product_description": "Small cog", "product_price": 10, "tenant_id": "tenant 7"},
    {"product_id": 6, "product_name": "Bolt", "product_description": "Unicode tenant", "product_price": 5, "tenant_id": "te\u00e9\u5230nant"},
)

# Tenants that exist in the seed (distinct), plus one that is absent.
SEEDED_TENANTS: Tuple[str, ...] = ("tenant-123", "acme_corp", "tenant 7", "te\u00e9\u5230nant")
ABSENT_TENANT = "ghost-tenant"


# --------------------------------------------------------------------------- #
# Minimal in-memory SQL executor over app.products                            #
# --------------------------------------------------------------------------- #

Row = Tuple[Any, ...]


@dataclass
class ExecutionResult:
    """Outcome of executing one effective statement string against the table."""

    rows: List[Row] = field(default_factory=list)   # last SELECT projection
    error: Optional[str] = None


def _split_statements(sql: str) -> List[str]:
    """Split ``sql`` into top-level statements at ``;`` outside string literals.

    Single-quoted literals (with ``''`` escaping) are consumed atomically so a
    ``;`` inside a bound/quoted value does not split statements. A trailing
    ``--`` line comment outside a literal is stripped from each statement.
    """
    statements: List[str] = []
    cur: List[str] = []
    i = 0
    n = len(sql)
    while i < n:
        c = sql[i]
        if c == "'":
            cur.append(c)
            j = i + 1
            while j < n:
                cur.append(sql[j])
                if sql[j] == "'":
                    if j + 1 < n and sql[j + 1] == "'":
                        cur.append(sql[j + 1])
                        j += 2
                        continue
                    j += 1
                    break
                j += 1
            i = j
            continue
        if c == "-" and i + 1 < n and sql[i + 1] == "-":
            # line comment to end of line (or end of string)
            nl = sql.find("\n", i)
            i = n if nl == -1 else nl
            continue
        if c == ";":
            statements.append("".join(cur))
            cur = []
            i += 1
            continue
        cur.append(c)
        i += 1
    tail = "".join(cur)
    if tail.strip():
        statements.append(tail)
    return [s.strip() for s in statements if s.strip()]


def _split_top_level(text: str, sep_word: str) -> List[str]:
    """Split ``text`` on a whole-word boundary ``sep_word`` outside literals."""
    parts: List[str] = []
    cur: List[str] = []
    i = 0
    n = len(text)
    pat = re.compile(r"\b" + re.escape(sep_word) + r"\b", re.IGNORECASE)
    while i < n:
        c = text[i]
        if c == "'":
            cur.append(c)
            j = i + 1
            while j < n:
                cur.append(text[j])
                if text[j] == "'":
                    if j + 1 < n and text[j + 1] == "'":
                        cur.append(text[j + 1])
                        j += 2
                        continue
                    j += 1
                    break
                j += 1
            i = j
            continue
        m = pat.match(text, i)
        if m:
            parts.append("".join(cur))
            cur = []
            i = m.end()
            continue
        cur.append(c)
        i += 1
    parts.append("".join(cur))
    return parts


def _split_commas(text: str) -> List[str]:
    """Split a parenthesized value list on top-level commas (quote-aware)."""
    parts: List[str] = []
    cur: List[str] = []
    i = 0
    n = len(text)
    while i < n:
        c = text[i]
        if c == "'":
            cur.append(c)
            j = i + 1
            while j < n:
                cur.append(text[j])
                if text[j] == "'":
                    if j + 1 < n and text[j + 1] == "'":
                        cur.append(text[j + 1])
                        j += 2
                        continue
                    j += 1
                    break
                j += 1
            i = j
            continue
        if c == ",":
            parts.append("".join(cur))
            cur = []
            i += 1
            continue
        cur.append(c)
        i += 1
    parts.append("".join(cur))
    return [p.strip() for p in parts]


def _parse_literal(token: str) -> Any:
    """Parse a SQL literal token into a Python value.

    A single-quoted literal becomes a ``str`` with doubled quotes collapsed; a
    bare integer becomes an ``int``. Anything else is returned as its raw text
    (used by the condition evaluator to compare a bare column token).
    """
    token = token.strip()
    if len(token) >= 2 and token[0] == "'" and token[-1] == "'":
        return token[1:-1].replace("''", "'")
    if re.fullmatch(r"-?\d+", token):
        return int(token)
    return token  # raw (e.g. a column name)


class _Operand:
    __slots__ = ("kind", "value")

    def __init__(self, kind: str, value: Any) -> None:
        self.kind = kind      # "literal" | "column"
        self.value = value


def _resolve_operand(token: str) -> _Operand:
    token = token.strip()
    if len(token) >= 2 and token[0] == "'" and token[-1] == "'":
        return _Operand("literal", token[1:-1].replace("''", "'"))
    if re.fullmatch(r"-?\d+", token):
        return _Operand("literal", int(token))
    return _Operand("column", token)


def _eval_eq(expr: str, row: Dict[str, Any]) -> bool:
    if "=" not in expr:
        return False
    lhs, rhs = expr.split("=", 1)
    left = _resolve_operand(lhs)
    right = _resolve_operand(rhs)
    lval = row.get(left.value) if left.kind == "column" else left.value
    rval = row.get(right.value) if right.kind == "column" else right.value
    return lval == rval


def _eval_condition(cond: str, row: Dict[str, Any]) -> bool:
    """Evaluate a WHERE condition of ``= ...`` comparisons joined by AND/OR.

    Sufficient for the shapes emitted here: a single equality
    (``tenant_id = '...'``) and the classic tautology injection
    (``... OR '1'='1'``). OR has lower precedence than AND.
    """
    or_parts = _split_top_level(cond, "OR")
    for or_part in or_parts:
        and_parts = _split_top_level(or_part, "AND")
        if all(_eval_eq(a, row) for a in and_parts):
            return True
    return False


class SeededProductDB:
    """A faithful, bounded in-memory model of the tenant ``app.products`` table.

    ``execute(query, params)`` mirrors the ``psycopg`` contract: when ``params``
    is provided the ``%s`` placeholders are bound using the driver model from
    task 8.7 (:func:`_bind_all`) to form the *effective* statement; when
    ``params`` is ``None`` the ``query`` is treated as already-final SQL (the
    baseline / interpolated path). The effective statement(s) are then executed
    against the seeded rows, mutating them for ``INSERT`` / ``DELETE`` / ``DROP``.
    """

    def __init__(self, rows: Sequence[Dict[str, Any]]) -> None:
        self.rows: List[Dict[str, Any]] = [dict(r) for r in rows]
        self.table_dropped: bool = False

    # -- public driver-like surface ------------------------------------- #

    def execute(self, query: str, params: Optional[Tuple[Any, ...]] = None) -> List[Row]:
        effective = query if params is None else _bind_all(query, params)
        last: List[Row] = []
        for stmt in _split_statements(effective):
            result = self._run_statement(stmt)
            if result.error:
                raise ValueError(result.error)
            if stmt.lstrip().lower().startswith("select"):
                last = result.rows
        return last

    # -- statement dispatch --------------------------------------------- #

    def _run_statement(self, stmt: str) -> ExecutionResult:
        head = stmt.lstrip().lower()
        if head.startswith("select"):
            return self._run_select(stmt)
        if head.startswith("insert"):
            return self._run_insert(stmt)
        if head.startswith("delete"):
            return self._run_delete(stmt)
        if head.startswith("drop"):
            self.table_dropped = True
            self.rows = []
            return ExecutionResult()
        return ExecutionResult(error=f"unsupported statement: {stmt!r}")

    def _require_table(self) -> Optional[ExecutionResult]:
        if self.table_dropped:
            return ExecutionResult(error="relation \"app.products\" does not exist")
        return None

    def _run_select(self, stmt: str) -> ExecutionResult:
        missing = self._require_table()
        if missing:
            return missing
        m = re.match(
            r"(?is)\s*select\s+(?P<cols>.+?)\s+from\s+(?P<rest>.+)$", stmt
        )
        if not m:
            return ExecutionResult(error=f"unparseable SELECT: {stmt!r}")
        cols_text = m.group("cols").strip()
        rest = m.group("rest").strip()
        where_split = _split_top_level(rest, "WHERE")
        cond = where_split[1].strip() if len(where_split) > 1 else None

        if cols_text == "*":
            cols = list(PRODUCT_COLUMNS)
        else:
            cols = [c.strip() for c in _split_commas(cols_text)]

        out: List[Row] = []
        for row in self.rows:
            if cond is None or _eval_condition(cond, row):
                out.append(tuple(row.get(c) for c in cols))
        return ExecutionResult(rows=out)

    def _run_insert(self, stmt: str) -> ExecutionResult:
        missing = self._require_table()
        if missing:
            return missing
        m = re.match(
            r"(?is)\s*insert\s+into\s+\S+\s*\((?P<cols>[^)]*)\)\s*values\s*\((?P<vals>.*)\)\s*$",
            stmt,
        )
        if not m:
            return ExecutionResult(error=f"unparseable INSERT: {stmt!r}")
        cols = [c.strip() for c in _split_commas(m.group("cols"))]
        vals = [_parse_literal(v) for v in _split_commas(m.group("vals"))]
        if len(cols) != len(vals):
            return ExecutionResult(error="INSERT column/value count mismatch")
        self.rows.append(dict(zip(cols, vals)))
        return ExecutionResult()

    def _run_delete(self, stmt: str) -> ExecutionResult:
        missing = self._require_table()
        if missing:
            return missing
        rest_split = _split_top_level(stmt, "WHERE")
        cond = rest_split[1].strip() if len(rest_split) > 1 else None
        if cond is None:
            self.rows = []
        else:
            self.rows = [r for r in self.rows if not _eval_condition(cond, r)]
        return ExecutionResult()


# --------------------------------------------------------------------------- #
# Concrete query constructions (baseline vs hardened) for the real sources     #
# --------------------------------------------------------------------------- #

# product.py get_products SELECT (the hardened, parameterized form).
_GET_PRODUCTS_HARDENED = (
    "SELECT product_id, product_name, product_description, product_price, "
    "tenant_id FROM app.products WHERE tenant_id = %s"
)

# product.py create_product INSERT (the hardened, parameterized form).
_CREATE_PRODUCT_HARDENED = (
    "INSERT INTO app.products (product_id, product_name, product_description, "
    "product_price, tenant_id) VALUES (%s, %s, %s, %s, %s)"
)


def _sql_literal(value: Any) -> str:
    """Render a value the way the *baseline* interpolation did.

    The pre-change baseline wrapped string values in single quotes WITHOUT any
    escaping (the very weakness CC7 hardens), and emitted integers bare. This
    deliberately naive rendering is what makes the baseline diverge on
    quote-bearing input — exactly the behavior Req 9.5 must detect.
    """
    if isinstance(value, int):
        return str(value)
    return "'" + str(value) + "'"


def baseline_get_products(db: SeededProductDB, tenant_id: str) -> List[Row]:
    sql = (
        "SELECT product_id, product_name, product_description, product_price, "
        "tenant_id FROM app.products WHERE tenant_id = " + _sql_literal(tenant_id)
    )
    return db.execute(sql)


def hardened_get_products(db: SeededProductDB, tenant_id: str) -> List[Row]:
    return db.execute(_GET_PRODUCTS_HARDENED, (tenant_id,))


def baseline_create_product(db: SeededProductDB, product: Tuple[Any, ...]) -> List[Row]:
    cols = "product_id, product_name, product_description, product_price, tenant_id"
    rendered = ", ".join(_sql_literal(v) for v in product)
    db.execute(f"INSERT INTO app.products ({cols}) VALUES ({rendered})")
    return []


def hardened_create_product(db: SeededProductDB, product: Tuple[Any, ...]) -> List[Row]:
    db.execute(_CREATE_PRODUCT_HARDENED, tuple(product))
    return []


# --------------------------------------------------------------------------- #
# Behavior-equivalence comparator (Req 9.4 / 9.5)                              #
# --------------------------------------------------------------------------- #


@dataclass
class DivergenceReport:
    """Result of comparing a hardened query to its baseline on seeded state.

    On divergence (``diverged is True``) ``query`` identifies the offending
    query and the harness's contract is to retain the hardened (post-change)
    behavior pending maintainer review (Req 9.5).
    """

    query: str
    diverged: bool
    baseline_rows: List[Row]
    hardened_rows: List[Row]
    baseline_dropped: bool
    hardened_dropped: bool
    retained_behavior: str  # "equivalent" | "hardened"

    @property
    def detail(self) -> str:
        if not self.diverged:
            return f"{self.query}: result sets identical ({len(self.hardened_rows)} rows)"
        return (
            f"{self.query}: DIVERGENCE — baseline returned {len(self.baseline_rows)} "
            f"row(s) (table_dropped={self.baseline_dropped}); hardened returned "
            f"{len(self.hardened_rows)} row(s) (table_dropped={self.hardened_dropped}); "
            f"retaining {self.retained_behavior} behavior pending review"
        )


def compare_select(query_name: str, tenant_id: str) -> DivergenceReport:
    """Run baseline + hardened ``get_products`` against identical seeded state."""
    base_db = SeededProductDB(SEED_ROWS)
    hard_db = SeededProductDB(SEED_ROWS)
    try:
        baseline_rows = baseline_get_products(base_db, tenant_id)
    except ValueError:
        baseline_rows = []  # malformed baseline SQL == divergent behavior
    hardened_rows = hardened_get_products(hard_db, tenant_id)

    diverged = (
        baseline_rows != hardened_rows
        or base_db.table_dropped != hard_db.table_dropped
    )
    return DivergenceReport(
        query=query_name,
        diverged=diverged,
        baseline_rows=baseline_rows,
        hardened_rows=hardened_rows,
        baseline_dropped=base_db.table_dropped,
        hardened_dropped=hard_db.table_dropped,
        retained_behavior="equivalent" if not diverged else "hardened",
    )


# --------------------------------------------------------------------------- #
# Req 9.4 — hardened result set IDENTICAL to baseline for legitimate inputs    #
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize("tenant_id", list(SEEDED_TENANTS) + [ABSENT_TENANT])
def test_get_products_equivalent_for_each_tenant(tenant_id):
    """get_products: hardened result set == baseline result set, per tenant.

    Against the same seeded state, the parameterized SELECT returns a row set
    identical to the pre-change interpolated SELECT for every legitimate tenant
    id (and the absent tenant), confirming behavior equivalence (Req 9.4).
    """
    report = compare_select("product.py:get_products", tenant_id)
    assert not report.diverged, report.detail
    assert report.hardened_rows == report.baseline_rows


def test_get_products_returns_only_matching_tenant_rows():
    """Sanity on the seed: each tenant sees exactly its own rows (isolation)."""
    db = SeededProductDB(SEED_ROWS)
    rows = hardened_get_products(db, "tenant-123")
    assert {r[0] for r in rows} == {1, 2}
    assert all(r[4] == "tenant-123" for r in rows)


def test_absent_tenant_returns_empty_for_both():
    report = compare_select("product.py:get_products", ABSENT_TENANT)
    assert report.hardened_rows == []
    assert report.baseline_rows == []
    assert not report.diverged


def test_create_product_then_get_products_equivalent():
    """create_product + get_products: seeded state evolves identically.

    Insert a new (quote-free, legitimate) product via BOTH the hardened and the
    baseline INSERT into separate copies of the seeded state, then read it back
    with the hardened SELECT. The resulting table and the read-back result set
    are identical, so the hardened write/read path preserves baseline behavior
    (Req 9.4).
    """
    new_product = (7, "Flange", "A sturdy flange", 60, "tenant-123")

    hard_db = SeededProductDB(SEED_ROWS)
    hardened_create_product(hard_db, new_product)
    hardened_after = hardened_get_products(hard_db, "tenant-123")

    base_db = SeededProductDB(SEED_ROWS)
    baseline_create_product(base_db, new_product)
    baseline_after = hardened_get_products(base_db, "tenant-123")

    assert hardened_after == baseline_after
    assert {r[0] for r in hardened_after} == {1, 2, 7}


# --------------------------------------------------------------------------- #
# Req 9.5 — divergence is detected, reported, and hardened behavior retained   #
# --------------------------------------------------------------------------- #


def test_tautology_injection_diverges_and_is_reported():
    """A tautology payload makes the baseline diverge; the harness reports it.

    For ``' OR '1'='1`` the baseline interpolation becomes
    ``... WHERE tenant_id = '' OR '1'='1'`` (returns ALL rows), while the
    hardened query binds the payload as one value and returns the intended
    (empty) set. The comparator flags the divergence, identifies the query, and
    retains the hardened behavior pending review (Req 9.5).
    """
    payload = "' OR '1'='1"
    report = compare_select("product.py:get_products", payload)

    assert report.diverged is True
    assert report.query == "product.py:get_products"
    assert len(report.baseline_rows) == len(SEED_ROWS)   # baseline leaked all rows
    assert report.hardened_rows == []                    # hardened honored the value
    assert report.retained_behavior == "hardened"
    assert "DIVERGENCE" in report.detail


def test_statement_injection_drops_table_in_baseline_only():
    """Statement-injection drops the table under the baseline, not the hardened.

    ``x'; DROP TABLE app.products; --`` terminates the baseline literal and
    appends a DROP, mutating the seeded state; the hardened query keeps the
    whole payload as one bound value and the table survives. The comparator
    detects the side-effect divergence and reports it (Req 9.5).
    """
    payload = "x'; DROP TABLE app.products; --"
    report = compare_select("product.py:get_products", payload)

    assert report.diverged is True
    assert report.baseline_dropped is True
    assert report.hardened_dropped is False
    assert report.retained_behavior == "hardened"


def test_hardened_value_binding_preserves_quote_bearing_value():
    """A legitimate value containing an apostrophe is preserved by binding.

    A product whose name is ``O'Brien Tools`` round-trips intact through the
    hardened INSERT + SELECT (the bound parameter is escaped by the driver
    model), whereas naive baseline interpolation would corrupt it — the hardened
    path is behavior-correct where the baseline was not.
    """
    quoted_value = "O'Brien Tools"
    db = SeededProductDB(SEED_ROWS)
    hardened_create_product(db, (8, quoted_value, "hand tools", 30, "acme_corp"))
    rows = hardened_get_products(db, "acme_corp")

    names = {r[1] for r in rows}
    assert quoted_value in names
    assert {r[0] for r in rows} == {3, 4, 8}


# --------------------------------------------------------------------------- #
# Driver-binding model sanity (reuses task 8.7 bind_literal)                   #
# --------------------------------------------------------------------------- #


def test_bind_literal_doubles_quotes_for_seeded_values():
    """The reused driver model escapes embedded quotes (basis of equivalence)."""
    assert bind_literal("acme_corp") == "'acme_corp'"
    assert bind_literal("O'Brien") == "'O''Brien'"
    assert bind_literal(100) == "100"
