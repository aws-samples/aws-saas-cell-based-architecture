"""Property 7: Hardened queries are behavior-equivalent to the baseline.

Feature: codebase-modernization-refresh, Property 7
Validates: Requirements 9.4, 16.3

For any set of inputs (tenant ids, product values, including values containing
quotes / semicolons / SQL metacharacters), a *hardened* query — built with
driver-bound ``%s`` parameters for value positions and
``psycopg.sql.Identifier`` composition for non-parameterizable identifiers —
produces an effective SQL execution that is **semantically equivalent** to the
pre-change *baseline* (string-interpolated) query for the same inputs, *and* is
injection-safe in exactly the cases where the baseline was not.

Why an in-memory model
----------------------
``psycopg`` is not installed in the tooling venv and Property 7 must run without
a live database (design Testing Strategy, Property 7). The driver's contract is
simple and faithfully reproducible: ``cursor.execute(sql, params)`` records the
SQL *template* plus the bound ``params``, and the server substitutes each
parameter using the driver's own literal escaping. The recorded
``(sql_template, params)`` tuple is therefore the equivalence oracle, and the
*effective* statement (template with parameters bound) is what the database
actually executes.

This module models that contract with:

* :func:`bind_literal` — the text-mode literal adapter, mirroring ``psycopg``
  under ``standard_conforming_strings = on`` (modern PostgreSQL default): a
  ``str`` becomes a single-quoted literal with every embedded ``'`` doubled; an
  ``int`` becomes its bare decimal text.
* :class:`FakeCursor` — records ``(query, params)`` and computes the effective
  statement by binding ``%s`` placeholders left-to-right, exactly as the driver
  would.
* The real hardening helpers :func:`safe_identifier` / :func:`unquote_identifier`
  from :mod:`refresh_tooling.sql_hardener` for the identifier-composition path
  (``CREATE DATABASE`` etc.), so the property exercises production code.
"""
from __future__ import annotations

import re
from typing import Any, Dict, List, Optional, Tuple

from hypothesis import given, settings
from hypothesis import strategies as st

from refresh_tooling.sql_hardener import safe_identifier, unquote_identifier

# --------------------------------------------------------------------------- #
# In-memory psycopg model (parameter-binding contract)                        #
# --------------------------------------------------------------------------- #


def bind_literal(value: Any) -> str:
    """Render a Python value as a SQL literal the way the driver would.

    Models ``psycopg`` text-mode adaptation under
    ``standard_conforming_strings = on`` (the modern PostgreSQL default):

    * ``None``  -> ``NULL``
    * ``bool``  -> ``true`` / ``false``
    * ``int``   -> bare decimal text
    * ``str``   -> ``'...'`` with every embedded single quote doubled

    The single-quote doubling is the mechanism that makes bound string
    parameters injection-safe: a value can never terminate its surrounding
    literal, so it cannot introduce additional SQL tokens or statements.
    """
    if value is None:
        return "NULL"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, str):
        return "'" + value.replace("'", "''") + "'"
    raise TypeError(f"unsupported parameter type: {type(value)!r}")


def _bind_all(template: str, params: Tuple[Any, ...]) -> str:
    """Substitute each ``%s`` in ``template`` with ``bind_literal(param)``.

    ``%%`` is collapsed to a literal ``%`` (the driver's escaping rule). The
    number of placeholders must match ``len(params)``.
    """
    out: List[str] = []
    i = 0
    pi = 0
    n = len(template)
    while i < n:
        if template[i] == "%" and i + 1 < n:
            nxt = template[i + 1]
            if nxt == "s":
                if pi >= len(params):
                    raise ValueError("not enough parameters for placeholders")
                out.append(bind_literal(params[pi]))
                pi += 1
                i += 2
                continue
            if nxt == "%":
                out.append("%")
                i += 2
                continue
        out.append(template[i])
        i += 1
    if pi != len(params):
        raise ValueError("more parameters than placeholders")
    return "".join(out)


class FakeCursor:
    """Records executed statements; mirrors ``psycopg`` cursor.execute contract.

    ``execute(query, params)`` stores the recorded ``(query, params)`` oracle and
    the *effective* statement actually run against the database. When ``params``
    is ``None`` the ``query`` is treated as already-final SQL (the baseline /
    interpolated path).
    """

    def __init__(self) -> None:
        self.executed: List[Dict[str, Any]] = []

    def execute(
        self, query: str, params: Optional[Tuple[Any, ...]] = None
    ) -> str:
        effective = query if params is None else _bind_all(query, params)
        self.executed.append(
            {"query": query, "params": params, "effective": effective}
        )
        return effective


# --------------------------------------------------------------------------- #
# Equivalence oracle: normalize an effective statement                        #
# --------------------------------------------------------------------------- #


def _scan_statements(sql: str) -> Tuple[List[str], List[str]]:
    """Split ``sql`` into top-level statements and extract string literals.

    Single-quoted literals (with ``''`` escaping) are consumed atomically, so a
    ``;`` *inside* a literal does not split statements. Each literal is replaced
    by a ``?`` marker in the returned skeleton text and its unquoted value is
    collected in order.
    """
    statements: List[str] = []
    str_values: List[str] = []
    cur: List[str] = []
    i = 0
    n = len(sql)
    while i < n:
        c = sql[i]
        if c == "'":
            j = i + 1
            buf: List[str] = []
            while j < n:
                if sql[j] == "'":
                    if j + 1 < n and sql[j + 1] == "'":
                        buf.append("'")
                        j += 2
                        continue
                    j += 1
                    break
                buf.append(sql[j])
                j += 1
            str_values.append("".join(buf))
            cur.append("?")
            i = j
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
    return [s for s in statements if s.strip()], str_values


def normalize(sql: str) -> Dict[str, Any]:
    """Reduce an effective SQL string to a comparable semantic fingerprint.

    Returns the number of top-level statements, a whitespace/integer-normalized
    skeleton (string literals -> ``?``, integers -> ``#``), the ordered list of
    bound string values, and the ordered list of integer values. Two effective
    statements are semantically equivalent iff their fingerprints are equal.
    """
    statements, str_values = _scan_statements(sql)
    skeleton = ";".join(statements)
    int_values = [int(tok) for tok in re.findall(r"\d+", skeleton)]
    skeleton_norm = re.sub(r"\s+", " ", re.sub(r"\d+", "#", skeleton)).strip().lower()
    return {
        "n_statements": len(statements),
        "skeleton": skeleton_norm,
        "str_values": str_values,
        "int_values": int_values,
    }


# --------------------------------------------------------------------------- #
# Query models: baseline (interpolated) vs hardened (bound / composed)        #
# --------------------------------------------------------------------------- #

# product.py-style value query: a tenant string + a numeric product id.
_VALUE_QUERY_HARDENED = (
    "SELECT * FROM products WHERE tenant_id = %s AND product_id = %s"
)


def render_value_baseline(tenant: str, product_id: int) -> str:
    """The pre-change, injectable construction (manual quoting + concatenation)."""
    return (
        "SELECT * FROM products WHERE tenant_id = '"
        + tenant
        + "' AND product_id = "
        + str(product_id)
    )


def render_value_hardened(cur: FakeCursor, tenant: str, product_id: int) -> str:
    """The hardened construction: driver-bound ``%s`` parameters."""
    return cur.execute(_VALUE_QUERY_HARDENED, (tenant, product_id))


def _resolve_create_database(stmt: str) -> str:
    """Resolve the target object name of a ``CREATE DATABASE <ident>`` statement.

    Mirrors PostgreSQL identifier resolution: a quoted identifier keeps its exact
    (case-sensitive) value; an unquoted identifier is folded to lower case.
    """
    prefix = "CREATE DATABASE "
    assert stmt.startswith(prefix)
    ident = stmt[len(prefix):].strip()
    if ident.startswith('"'):
        return unquote_identifier(ident)
    return ident.lower()


def _count_top_level_semicolons(sql: str) -> int:
    """Count ``;`` characters that are NOT inside a double-quoted identifier."""
    count = 0
    i = 0
    n = len(sql)
    while i < n:
        c = sql[i]
        if c == '"':
            j = i + 1
            while j < n:
                if sql[j] == '"':
                    if j + 1 < n and sql[j + 1] == '"':
                        j += 2
                        continue
                    j += 1
                    break
                j += 1
            i = j
            continue
        if c == ";":
            count += 1
        i += 1
    return count


# --------------------------------------------------------------------------- #
# Generators                                                                  #
# --------------------------------------------------------------------------- #

# "Safe" tenant values: anything printable EXCEPT the single quote. With no
# embedded quote, the driver's quote-doubling is a no-op, so the bound literal is
# byte-identical to the baseline's manually-quoted literal.
_safe_tenant = st.text(
    alphabet=st.characters(min_codepoint=32, max_codepoint=126, exclude_characters="'"),
    min_size=1,
    max_size=24,
)

# Arbitrary tenant values, INCLUDING quotes, semicolons, and SQL fragments.
_any_tenant = st.text(min_size=0, max_size=24)

# Injection payloads guaranteed to contain at least one single quote.
_injection_tenant = st.builds(
    lambda head, tail: head + "'" + tail,
    st.text(
        alphabet=st.characters(min_codepoint=32, max_codepoint=126),
        max_size=8,
    ),
    st.sampled_from(
        [
            "; DROP TABLE products; --",
            " OR '1'='1",
            "); DELETE FROM products; --",
            " UNION SELECT password FROM users --",
            "",
        ]
    ),
)

_product_id = st.integers(min_value=0, max_value=10**9)

# Safe SQL identifier names (already lower case, no special characters).
_safe_identifier_name = st.from_regex(r"[a-z_][a-z0-9_]{0,20}", fullmatch=True)

# Arbitrary identifier names, including quotes/semicolons/keywords.
_any_identifier_name = st.text(min_size=1, max_size=24).filter(
    lambda s: "\x00" not in s
)


# --------------------------------------------------------------------------- #
# Property 7 — value positions                                                #
# --------------------------------------------------------------------------- #


@settings(max_examples=200)
@given(_safe_tenant, _product_id)
def test_hardened_value_query_byte_equivalent_for_safe_inputs(tenant, product_id):
    """For quote-free inputs the hardened query executes byte-identical SQL.

    This is the strongest form of behavior equivalence: when the baseline was
    well-defined (no injection), the hardened bound-parameter path reproduces the
    exact same effective statement (Req 9.4, 16.3).
    """
    cur = FakeCursor()
    baseline = render_value_baseline(tenant, product_id)
    hardened = render_value_hardened(cur, tenant, product_id)

    assert hardened == baseline
    assert normalize(hardened) == normalize(baseline)

    # The recorded (template, params) tuple is the equivalence oracle.
    record = cur.executed[-1]
    assert record["query"] == _VALUE_QUERY_HARDENED
    assert record["params"] == (tenant, product_id)


@settings(max_examples=200)
@given(_any_tenant, _product_id)
def test_hardened_value_query_binds_intended_values_for_any_input(tenant, product_id):
    """For arbitrary inputs the database sees exactly the intended values.

    The hardened effective statement is always a single statement whose bound
    values equal the supplied inputs, regardless of special characters — i.e. the
    semantics the baseline *intended* are preserved exactly (Req 9.4, 16.3).
    """
    cur = FakeCursor()
    effective = render_value_hardened(cur, tenant, product_id)
    norm = normalize(effective)

    assert norm["n_statements"] == 1
    assert norm["str_values"] == [tenant]
    assert product_id in norm["int_values"]
    assert norm["skeleton"] == (
        "select * from products where tenant_id = ? and product_id = #"
    )


@settings(max_examples=200)
@given(_injection_tenant, _product_id)
def test_hardened_value_query_is_injection_safe_where_baseline_is_not(
    tenant, product_id
):
    """The hardened path neutralizes injection that the baseline admits.

    For a quote-bearing payload the baseline produces a *different* effective
    statement (the value escapes its literal), while the hardened path keeps the
    payload as one bound value inside a single statement. This demonstrates the
    hardened query is behavior-equivalent to the baseline's *intent* and
    injection-safe exactly where the baseline was not (Req 9.4, 16.3).
    """
    cur = FakeCursor()
    baseline = render_value_baseline(tenant, product_id)
    hardened = render_value_hardened(cur, tenant, product_id)

    h = normalize(hardened)
    # Hardened: one statement, payload preserved verbatim as a single value.
    assert h["n_statements"] == 1
    assert h["str_values"] == [tenant]

    # Baseline: the unescaped quote made it diverge from the intended statement.
    assert baseline != hardened
    b = normalize(baseline)
    assert (b["n_statements"] != h["n_statements"]) or (b["str_values"] != [tenant])


# --------------------------------------------------------------------------- #
# Property 7 — non-parameterizable identifier positions                       #
# --------------------------------------------------------------------------- #


@settings(max_examples=200)
@given(_safe_identifier_name)
def test_hardened_identifier_ddl_equivalent_to_baseline_for_safe_names(name):
    """``CREATE DATABASE`` via safe-identifier targets the same object.

    For an already-lowercase valid identifier, the unquoted baseline and the
    quoted hardened form resolve to the identical database object, so the DDL is
    behavior-equivalent (Req 9.4, 16.3).
    """
    baseline = "CREATE DATABASE " + name
    hardened = "CREATE DATABASE " + safe_identifier(name)

    assert unquote_identifier(safe_identifier(name)) == name
    assert _resolve_create_database(hardened) == _resolve_create_database(baseline)
    assert _count_top_level_semicolons(hardened) == 0


@settings(max_examples=200)
@given(_any_identifier_name)
def test_hardened_identifier_composition_is_injection_safe(name):
    """Safe-identifier composition preserves the intended name with no breakout.

    For arbitrary identifier text (including quotes and semicolons), the composed
    identifier round-trips to the original name and introduces no top-level
    statement separator — injection-safe where bare interpolation would not be
    (Req 9.4, 16.3).
    """
    hardened = "CREATE DATABASE " + safe_identifier(name)

    assert _resolve_create_database(hardened) == name
    assert _count_top_level_semicolons(hardened) == 0
