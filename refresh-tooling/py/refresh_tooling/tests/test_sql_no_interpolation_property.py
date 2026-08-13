"""Property 5: SQL value positions carry no string interpolation.

Feature: codebase-modernization-refresh, Property 5
Validates: Requirements 9.1, 9.2

For any generated Python SQL-construction snippet,
:func:`refresh_tooling.sql_hardener.has_safe_sql_values` returns ``False`` if and
only if at least one SQL *value* position uses string interpolation (f-string,
``.format()``, ``%``-formatting, or string concatenation), and returns ``True``
when every value position instead uses driver-bound parameters (``%s``
placeholders passed via ``execute(sql, params)``).

Identifier-DDL interpolations (``CREATE DATABASE`` / ``DROP DATABASE`` /
``DROP USER`` and friends) are intentionally non-parameterizable (Req 9.3) and
MUST NOT count as value-position violations: a snippet whose only interpolation
sites are identifier-DDL positions is still accepted.

The generators below build snippets from labelled fragments so the expected
acceptance is computable directly from the construction: a snippet is safe iff it
contains zero value-position interpolation fragments.
"""
from hypothesis import given, settings
from hypothesis import strategies as st

from refresh_tooling.sql_hardener import (
    find_interpolations,
    find_value_interpolations,
    has_safe_sql_values,
)

# --------------------------------------------------------------------------- #
# Vocabulary kept clear of SQL keywords so generated identifiers never alter   #
# the static checker's value/identifier classification.                       #
# --------------------------------------------------------------------------- #

_TABLES = ["products", "tenants", "orders", "items", "accounts", "catalog"]
_COLUMNS = ["id", "name", "status", "price", "sku", "owner"]
_VARS = ["product_id", "tenant_id", "value", "name_in", "arg", "param"]
_DDL = ["CREATE DATABASE", "DROP DATABASE", "DROP USER", "DROP ROLE", "CREATE SCHEMA"]

_table = st.sampled_from(_TABLES)
_column = st.sampled_from(_COLUMNS)
_var = st.sampled_from(_VARS)
_ddl = st.sampled_from(_DDL)


# --------------------------------------------------------------------------- #
# Fragment builders -> (code_line, is_value_violation)                         #
# --------------------------------------------------------------------------- #


@st.composite
def _value_fstring(draw):
    table, col, var = draw(_table), draw(_column), draw(_var)
    line = f'cursor.execute(f"SELECT * FROM {table} WHERE {col} = {{{var}}}")'
    return line, True


@st.composite
def _value_format(draw):
    table, col, var = draw(_table), draw(_column), draw(_var)
    line = f"cursor.execute(\"UPDATE {table} SET {col} = '{{}}'\".format({var}))"
    return line, True


@st.composite
def _value_percent(draw):
    table, col, var = draw(_table), draw(_column), draw(_var)
    line = f"cursor.execute(\"DELETE FROM {table} WHERE {col} = '%s'\" % {var})"
    return line, True


@st.composite
def _value_concat(draw):
    table, col, var = draw(_table), draw(_column), draw(_var)
    line = f'cursor.execute("SELECT * FROM {table} WHERE {col} = " + {var})'
    return line, True


@st.composite
def _safe_param(draw):
    table, col, var = draw(_table), draw(_column), draw(_var)
    line = f'cursor.execute("SELECT * FROM {table} WHERE {col} = %s", ({var},))'
    return line, False


@st.composite
def _safe_literal(draw):
    table, col = draw(_table), draw(_column)
    line = f'cursor.execute("SELECT {col} FROM {table} WHERE {col} = 1")'
    return line, False


@st.composite
def _identifier_ddl(draw):
    """Interpolated identifier-DDL: an interpolation, but NOT a value violation."""
    ddl, var = draw(_ddl), draw(_var)
    line = f'cursor.execute(f"{ddl} {{{var}}}")'
    return line, False


_value_fragment = st.one_of(
    _value_fstring(), _value_format(), _value_percent(), _value_concat()
)
_safe_fragment = st.one_of(_safe_param(), _safe_literal())
_any_fragment = st.one_of(_value_fragment, _safe_fragment, _identifier_ddl())


def _assemble(fragments):
    source = "\n".join(line for line, _ in fragments)
    expected_safe = not any(is_violation for _, is_violation in fragments)
    return source, expected_safe


# --------------------------------------------------------------------------- #
# Property tests                                                              #
# --------------------------------------------------------------------------- #


@settings(max_examples=200)
@given(st.lists(_any_fragment, min_size=1, max_size=6))
def test_safe_iff_no_value_interpolation(fragments):
    """has_safe_sql_values is False iff a value position uses interpolation.

    Validates: Requirements 9.1, 9.2
    """
    source, expected_safe = _assemble(fragments)
    assert has_safe_sql_values(source) is expected_safe


@settings(max_examples=200)
@given(st.lists(_value_fragment, min_size=1, max_size=6))
def test_any_value_interpolation_is_rejected(fragments):
    """A snippet with at least one interpolated value position is never safe.

    Validates: Requirements 9.1, 9.2
    """
    source, _ = _assemble(fragments)
    assert has_safe_sql_values(source) is False
    # Every reported value interpolation is a genuine value position.
    for finding in find_value_interpolations(source):
        assert finding.position_type == "value"


@settings(max_examples=200)
@given(st.lists(st.one_of(_safe_fragment, _identifier_ddl()), min_size=1, max_size=6))
def test_parameterized_and_identifier_ddl_are_safe(fragments):
    """Driver-bound values plus identifier-DDL interpolation are accepted.

    Identifier-DDL interpolations must not count as value-position violations
    (Req 9.3 carve-out), so the snippet is safe even when interpolation exists.

    Validates: Requirements 9.1, 9.2
    """
    source, _ = _assemble(fragments)
    assert has_safe_sql_values(source) is True


@settings(max_examples=200)
@given(st.lists(_identifier_ddl(), min_size=1, max_size=6))
def test_identifier_ddl_interpolation_excluded_from_value_findings(fragments):
    """Identifier-DDL interpolation is detected but excluded from value findings.

    Validates: Requirements 9.1, 9.2
    """
    source, _ = _assemble(fragments)
    # The interpolation IS seen by the general checker ...
    assert len(find_interpolations(source)) >= 1
    # ... but none of it lands in a value position, so the source is safe.
    assert find_value_interpolations(source) == []
    assert has_safe_sql_values(source) is True
