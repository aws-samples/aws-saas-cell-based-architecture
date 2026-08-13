"""Unit tests for the SQL Hardener (Task 8.3).

Feature: codebase-modernization-refresh

Covers the three pieces of design Component 7 / Requirements 9.1-9.3:

* :func:`safe_identifier` quoting + injection safety (Req 9.3)
* the no-interpolation static checker (Req 9.1 / 9.2)
* the ``harden()`` report producer ({ site, positionType, technique,
  flaggedForReview })

The property-based tests for these (Properties 5 and 6) live in tasks 8.5/8.6.
"""
import pytest

from refresh_tooling.sql_hardener import (
    HardeningReport,
    HardeningSite,
    find_interpolations,
    find_value_interpolations,
    harden,
    has_safe_sql_values,
    is_valid_unquoted_identifier,
    safe_identifier,
    unquote_identifier,
)


# --- safe_identifier: quoting ----------------------------------------------


@pytest.mark.parametrize(
    "name,expected",
    [
        ("tenant_42", '"tenant_42"'),
        ("Mixed_Case", '"Mixed_Case"'),
        ('a"b', '"a""b"'),                       # embedded quote doubled
        ('"; DROP TABLE users; --', '"""; DROP TABLE users; --"'),
        ("with space", '"with space"'),
        ("select", '"select"'),                  # keyword stays delimited
    ],
)
def test_safe_identifier_quotes(name, expected):
    assert safe_identifier(name) == expected


def test_safe_identifier_qualified():
    assert safe_identifier("schema", "table") == '"schema"."table"'


@pytest.mark.parametrize("bad", ["", "a\x00b"])
def test_safe_identifier_rejects_invalid(bad):
    with pytest.raises(ValueError):
        safe_identifier(bad)


def test_safe_identifier_rejects_non_str():
    with pytest.raises(TypeError):
        safe_identifier(123)  # type: ignore[arg-type]


def test_safe_identifier_blocks_statement_termination():
    # A classic injection payload cannot escape the quotes: the only unescaped
    # double quotes are the delimiters at each end.
    payload = 'x"; DROP DATABASE prod; --'
    quoted = safe_identifier(payload)
    assert quoted.startswith('"') and quoted.endswith('"')
    # Inner double quotes are all doubled (even count of quotes in the body).
    body = quoted[1:-1]
    assert body.count('"') % 2 == 0


# --- safe_identifier: round trip (Property 6 round-trip clause) -------------


@pytest.mark.parametrize(
    "name", ["tenant", 'a"b', '"x"', "; --", "weird\tname", "select"]
)
def test_identifier_round_trips(name):
    assert is_valid_unquoted_identifier(name)
    assert unquote_identifier(safe_identifier(name)) == name


# --- static checker: detects interpolated value positions -------------------


@pytest.mark.parametrize(
    "source",
    [
        'q = f"SELECT * FROM products WHERE id = {pid}"',
        'q = "SELECT * FROM products WHERE id = {}".format(pid)',
        'q = "UPDATE products SET name = %s WHERE id = " % pid',
        'q = "SELECT * FROM products WHERE id = " + pid',
        'q = "DELETE FROM products WHERE id = " + str(pid) + ";"',
    ],
)
def test_checker_flags_value_interpolation(source):
    findings = find_value_interpolations(source)
    assert len(findings) >= 1
    assert has_safe_sql_values(source) is False


@pytest.mark.parametrize(
    "source",
    [
        'cur.execute("SELECT * FROM products WHERE id = %s", (pid,))',
        'cur.execute("INSERT INTO products (name) VALUES (%s)", [name])',
        'q = "SELECT * FROM products"',                       # static, no interpolation
        'q = "SELECT name " "FROM products"',                 # literal concatenation
        'msg = f"loaded {n} rows"',                           # f-string but not SQL
    ],
)
def test_checker_accepts_safe_value_sql(source):
    assert find_value_interpolations(source) == []
    assert has_safe_sql_values(source) is True


def test_checker_classifies_identifier_ddl_as_identifier_position():
    source = 'cur.execute(f"CREATE DATABASE {tenant_id}")'
    all_findings = find_interpolations(source)
    assert len(all_findings) == 1
    assert all_findings[0].position_type == "identifier"
    # Identifier-DDL interpolation is NOT a value-position violation.
    assert find_value_interpolations(source) == []
    assert has_safe_sql_values(source) is True


def test_checker_handles_expression_fragment_fallback():
    # A bare fragment that is not a complete statement still gets scanned.
    fragment = '"SELECT * FROM products WHERE id = " + pid'
    assert has_safe_sql_values(fragment) is False


# --- harden() report producer ----------------------------------------------


def test_harden_reports_value_and_identifier_sites():
    rds = (
        "rds.py",
        'cur.execute(f"CREATE DATABASE {tenant_id}")\n'
        'cur.execute("SELECT * FROM t WHERE id = " + pid)\n',
    )
    report = harden([rds])
    assert isinstance(report, HardeningReport)

    by_type = {s.position_type: s for s in report.sites}
    assert set(by_type) == {"identifier", "value"}

    identifier_site = by_type["identifier"]
    assert identifier_site.technique == "safe-identifier"
    assert identifier_site.flagged_for_review is True
    assert identifier_site.site.startswith("rds.py:")

    value_site = by_type["value"]
    assert value_site.technique == "bound-parameter"
    assert value_site.flagged_for_review is False

    # A residual value interpolation blocks acceptance.
    assert report.accepted is False
    assert len(report.value_interpolations) == 1
    assert len(report.flagged_for_review) == 1


def test_harden_accepts_fully_parameterized_source():
    hardened = (
        "product.py",
        'cur.execute("SELECT * FROM products WHERE id = %s", (pid,))\n'
        'cur.execute(\n'
        '    sql.SQL("CREATE DATABASE {}").format(sql.Identifier(tenant_id))\n'
        ')\n',
    )
    report = harden([hardened])
    # No raw value interpolation remains -> accepted.
    assert report.accepted is True
    assert report.value_interpolations == ()


def test_harden_accepts_single_string_input():
    report = harden('q = "SELECT 1"')
    assert report.accepted is True
    assert report.sites == ()
