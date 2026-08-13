"""SQL Hardener: safe-identifier helper, no-interpolation static checker, and
``harden()`` report producer (CC7 / Task 8.3).

Feature: codebase-modernization-refresh

This module implements the SQL Hardener (design Component 7) behind Requirements
9.1, 9.2, and 9.3:

* **9.1 / 9.2** - SQL *value* positions must carry no string interpolation
  (no f-string, ``.format()``, ``%``-formatting, or string concatenation that
  produces a SQL value); externally supplied values must instead be passed as
  driver-bound parameters. :func:`find_value_interpolations` is the static
  checker that detects residual interpolation in value positions, and
  :func:`has_safe_sql_values` is the boolean acceptance gate (Property 5).
* **9.3** - identifiers that cannot be parameterized (the ``CREATE DATABASE`` /
  ``DROP DATABASE`` / ``DROP user`` statements in ``rds.py``) use *safe
  identifier handling*. :func:`safe_identifier` reproduces
  ``psycopg.sql.Identifier`` quoting semantics as a pure-text function so it is
  injection-safe and trivially property-testable (Property 6) without requiring
  a live ``psycopg`` install.

All functions are intentionally pure-on-text (text in, decision/record out) so
they can be exercised exhaustively by the property-based tests in tasks 8.5
(Property 5) and 8.6 (Property 6). The :func:`harden` aggregator produces the
``HardeningReport`` described by the Component 7 interface
(``{ site, positionType, technique, flaggedForReview }``).

NOTE: The actual source edits to ``rds.py`` / ``product.py`` are tasks 8.1 / 8.2.
This module is the *tooling* (safe-identifier + static checker + report), not the
source edits.
"""
from __future__ import annotations

import ast
import re
from dataclasses import dataclass, field
from typing import List, Sequence, Tuple, Union

__all__ = [
    "InterpolationFinding",
    "HardeningSite",
    "HardeningReport",
    "safe_identifier",
    "unquote_identifier",
    "is_valid_unquoted_identifier",
    "find_interpolations",
    "find_value_interpolations",
    "has_safe_sql_values",
    "harden",
]

# --------------------------------------------------------------------------- #
# SQL recognition helpers
# --------------------------------------------------------------------------- #

# A string literal is treated as "SQL-bearing" when it contains at least one of
# these keywords as a whole word (case-insensitive). Keeping the set focused
# keeps the static checker predictable for the property generators.
_SQL_KEYWORDS = (
    "select",
    "insert",
    "update",
    "delete",
    "create",
    "drop",
    "alter",
    "where",
    "values",
    "from",
    "into",
    "set",
    "join",
)
_SQL_KEYWORD_RE = re.compile(
    r"\b(?:" + "|".join(_SQL_KEYWORDS) + r")\b", re.IGNORECASE
)

# DDL statements whose interpolated slot is an *identifier* (database / role /
# user / schema / table name) rather than a bindable value. PostgreSQL forbids
# bind parameters for identifiers, so these are the safe-identifier cases that
# get flagged for maintainer review (Req 9.3).
_IDENTIFIER_DDL_RE = re.compile(
    r"\b(?:create|drop|alter)\s+(?:database|user|role|schema|tablespace)\b",
    re.IGNORECASE,
)

# Value-clause markers; their presence means the interpolation is a value
# position even if a DDL keyword also appears in the statement.
_VALUE_CLAUSE_RE = re.compile(r"\b(?:where|values|set|=)\b", re.IGNORECASE)

_VALUE = "value"
_IDENTIFIER = "identifier"


def _is_sql_text(text: str) -> bool:
    return bool(_SQL_KEYWORD_RE.search(text))


def _classify_position(sql_text: str) -> str:
    """Classify an interpolation site as a ``value`` or ``identifier`` position.

    A site is an *identifier* position when its surrounding SQL is an identifier
    DDL statement (``CREATE/DROP/ALTER DATABASE|USER|ROLE|SCHEMA``) and it has no
    value clause (``WHERE`` / ``VALUES`` / ``SET`` / ``=``). Everything else is a
    *value* position.
    """
    if _IDENTIFIER_DDL_RE.search(sql_text) and not _VALUE_CLAUSE_RE.search(sql_text):
        return _IDENTIFIER
    return _VALUE


# --------------------------------------------------------------------------- #
# Data models
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class InterpolationFinding:
    """A single detected string-interpolation site in SQL construction text."""

    source: str          # label/path identifying the analysed source
    line: int            # 1-based line number of the construction
    technique: str       # "f-string" | "str.format" | "percent-format" | "concatenation"
    position_type: str   # "value" | "identifier"
    snippet: str         # the offending expression text (best effort)


@dataclass(frozen=True)
class HardeningSite:
    """A Component-7 hardening record: ``{ site, positionType, technique, flaggedForReview }``.

    ``technique`` is the *remediation* applied at the site:

    * ``"bound-parameter"`` for value positions (Req 9.1 / 9.2)
    * ``"safe-identifier"`` for non-parameterizable identifier positions, which
      are additionally ``flagged_for_review`` (Req 9.3).
    """

    site: str            # e.g. "rds.py:42"
    position_type: str   # "value" | "identifier"
    technique: str       # "bound-parameter" | "safe-identifier"
    flagged_for_review: bool


@dataclass(frozen=True)
class HardeningReport:
    """Aggregate output of :func:`harden`.

    ``accepted`` is True iff zero string-interpolated *value* positions remain
    (Req 9.1 / 9.2). Identifier positions handled via safe-identifier are
    recorded and ``flagged_for_review`` but do not block acceptance.
    """

    sites: Tuple[HardeningSite, ...] = field(default_factory=tuple)
    value_interpolations: Tuple[InterpolationFinding, ...] = field(default_factory=tuple)

    @property
    def accepted(self) -> bool:
        return len(self.value_interpolations) == 0

    @property
    def flagged_for_review(self) -> Tuple[HardeningSite, ...]:
        return tuple(s for s in self.sites if s.flagged_for_review)


# --------------------------------------------------------------------------- #
# Safe identifier handling (Req 9.3 / Property 6)
# --------------------------------------------------------------------------- #


def safe_identifier(name: str, *more: str) -> str:
    """Quote a SQL identifier the way ``psycopg.sql.Identifier`` does.

    Each identifier component is wrapped in double quotes with every embedded
    double quote doubled, then joined with ``.`` for qualified names. Because the
    whole value is delimited and escaped, embedded quotes, semicolons,
    whitespace, comments, and SQL keywords cannot terminate the surrounding
    statement or introduce additional statements (injection-safe, Req 9.3).

    Args:
        name: the (first) identifier component.
        *more: optional additional components for a qualified identifier
            (e.g. ``safe_identifier("schema", "table")`` -> ``"schema"."table"``).

    Returns:
        The correctly quoted/escaped identifier string.

    Raises:
        TypeError: if any component is not a ``str``.
        ValueError: if any component is empty or contains a NUL byte (matching
            ``psycopg`` which rejects NUL in identifiers).

    Validates: Requirement 9.3
    """
    parts = (name, *more)
    quoted: List[str] = []
    for part in parts:
        if not isinstance(part, str):
            raise TypeError(f"identifier component must be str, got {type(part)!r}")
        if part == "":
            raise ValueError("identifier component must not be empty")
        if "\x00" in part:
            raise ValueError("identifier component must not contain a NUL byte")
        quoted.append('"' + part.replace('"', '""') + '"')
    return ".".join(quoted)


def unquote_identifier(quoted: str) -> str:
    """Inverse of :func:`safe_identifier` for a single (non-qualified) component.

    Strips the outer double quotes and collapses doubled inner quotes back to a
    single quote, recovering the original identifier value. Used by the
    round-trip clause of Property 6.

    Raises:
        ValueError: if ``quoted`` is not a single double-quoted identifier.
    """
    if len(quoted) < 2 or quoted[0] != '"' or quoted[-1] != '"':
        raise ValueError("not a quoted identifier")
    inner = quoted[1:-1]
    # Every literal double quote in the original was doubled by safe_identifier,
    # so collapsing doubled quotes recovers the original value exactly.
    return inner.replace('""', '"')


def is_valid_unquoted_identifier(name: str) -> bool:
    """True iff ``name`` is a value that round-trips through quote/unquote.

    Any non-empty string without a NUL byte is a valid identifier under safe
    quoting, since quoting escapes every other character. This helper exists so
    Property 6 can assert the round-trip clause over arbitrary inputs.
    """
    return isinstance(name, str) and name != "" and "\x00" not in name


# --------------------------------------------------------------------------- #
# No-interpolation static checker (Req 9.1 / 9.2 / Property 5)
# --------------------------------------------------------------------------- #


def _literal_text(node: ast.AST) -> str:
    """Return the concatenated string-literal text reachable from ``node``.

    Handles plain string constants, implicit/explicit concatenation, and the
    literal segments of an f-string (``JoinedStr``). Non-string content yields
    an empty contribution.
    """
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    if isinstance(node, ast.JoinedStr):
        return "".join(
            v.value
            for v in node.values
            if isinstance(v, ast.Constant) and isinstance(v.value, str)
        )
    if isinstance(node, ast.BinOp) and isinstance(node.op, (ast.Add, ast.Mod)):
        return _literal_text(node.left) + _literal_text(node.right)
    return ""


class _InterpolationVisitor(ast.NodeVisitor):
    """Collect SQL string-interpolation sites from an AST."""

    def __init__(self, source: str) -> None:
        self.source = source
        self.findings: List[InterpolationFinding] = []

    def _add(self, node: ast.AST, technique: str, sql_text: str) -> None:
        snippet = self._snippet(node)
        self.findings.append(
            InterpolationFinding(
                source=self.source,
                line=getattr(node, "lineno", 0),
                technique=technique,
                position_type=_classify_position(sql_text),
                snippet=snippet,
            )
        )

    @staticmethod
    def _snippet(node: ast.AST) -> str:
        try:
            return ast.unparse(node)
        except Exception:  # pragma: no cover - older/edge AST nodes
            return ""

    # f-strings: any formatted value embedded in SQL-bearing literal text.
    def visit_JoinedStr(self, node: ast.JoinedStr) -> None:
        has_value = any(isinstance(v, ast.FormattedValue) for v in node.values)
        text = _literal_text(node)
        if has_value and _is_sql_text(text):
            self._add(node, "f-string", text)
        self.generic_visit(node)

    def visit_Call(self, node: ast.Call) -> None:
        # str.format(): receiver is a SQL-bearing string literal.
        func = node.func
        if isinstance(func, ast.Attribute) and func.attr == "format":
            text = _literal_text(func.value)
            if _is_sql_text(text):
                self._add(node, "str.format", text)
        self.generic_visit(node)

    def visit_BinOp(self, node: ast.BinOp) -> None:
        if isinstance(node.op, ast.Mod):
            # `% ` operator applied to a SQL string => percent-formatting.
            # (Note: `%s` placeholders *inside* a string are NOT this node.)
            left_text = _literal_text(node.left)
            if _is_sql_text(left_text):
                self._add(node, "percent-format", left_text)
        elif isinstance(node.op, ast.Add):
            # Concatenation: a SQL string literal joined with a non-literal.
            left_text = _literal_text(node.left)
            right_text = _literal_text(node.right)
            combined = left_text + right_text
            left_is_str = self._is_str_literal(node.left)
            right_is_str = self._is_str_literal(node.right)
            if _is_sql_text(combined) and not (left_is_str and right_is_str):
                self._add(node, "concatenation", combined)
        self.generic_visit(node)

    @staticmethod
    def _is_str_literal(node: ast.AST) -> bool:
        if isinstance(node, ast.Constant) and isinstance(node.value, str):
            return True
        if isinstance(node, ast.JoinedStr):
            # An f-string with no formatted values is effectively a literal.
            return not any(isinstance(v, ast.FormattedValue) for v in node.values)
        if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
            return _InterpolationVisitor._is_str_literal(
                node.left
            ) and _InterpolationVisitor._is_str_literal(node.right)
        return False


# Line-scan fallback patterns, used only when the source is not parseable as a
# complete Python module (e.g. a bare expression fragment from a generator).
_FSTRING_RE = re.compile(r"""(?i)\bf(['"]).*?\{.*?\}.*?\1""")
_FORMAT_RE = re.compile(r"""(?i)(['"]).*?\1\s*\.\s*format\s*\(""")
_PERCENT_RE = re.compile(r"""(?i)(['"]).*?\1\s*%\s*[^\s]""")
_CONCAT_RE = re.compile(r"""(?i)(['"]).*?\1\s*\+|\+\s*(['"]).*?(['"])""")


def _scan_lines(source: str, label: str) -> List[InterpolationFinding]:
    findings: List[InterpolationFinding] = []
    for index, raw in enumerate(source.splitlines(), start=1):
        line = raw.split("#", 1)[0]
        if not _is_sql_text(line):
            continue
        position = _classify_position(line)
        for pattern, technique in (
            (_FSTRING_RE, "f-string"),
            (_FORMAT_RE, "str.format"),
            (_PERCENT_RE, "percent-format"),
            (_CONCAT_RE, "concatenation"),
        ):
            if pattern.search(line):
                findings.append(
                    InterpolationFinding(
                        source=label,
                        line=index,
                        technique=technique,
                        position_type=position,
                        snippet=line.strip(),
                    )
                )
    return findings


def find_interpolations(
    source: str, *, source_name: str = "source.py"
) -> List[InterpolationFinding]:
    """Return every SQL string-interpolation site in ``source``.

    Detects f-strings, ``str.format()``, ``%``-formatting, and string
    concatenation that produce SQL text. Parsing is AST-based for accuracy; if
    ``source`` is not a parseable Python module a conservative line-scan
    fallback is used so the checker still works on expression fragments.

    Validates: Requirements 9.1, 9.2
    """
    try:
        tree = ast.parse(source)
    except SyntaxError:
        return _scan_lines(source, source_name)
    visitor = _InterpolationVisitor(source_name)
    visitor.visit(tree)
    return visitor.findings


def find_value_interpolations(
    source: str, *, source_name: str = "source.py"
) -> List[InterpolationFinding]:
    """Return only the interpolation sites that occupy SQL *value* positions.

    Identifier-DDL positions (handled via :func:`safe_identifier`) are excluded,
    since they are intentionally non-parameterizable (Req 9.3). The remaining
    findings are exactly the value-position interpolations that Req 9.1 / 9.2
    require to be zero.

    Validates: Requirements 9.1, 9.2
    """
    return [
        f
        for f in find_interpolations(source, source_name=source_name)
        if f.position_type == _VALUE
    ]


def has_safe_sql_values(source: str) -> bool:
    """True iff ``source`` has zero string-interpolated SQL value positions.

    This is the boolean acceptance gate for Property 5: externally supplied
    values must appear only as driver-bound parameters, never as interpolated
    SQL text.

    Validates: Requirements 9.1, 9.2
    """
    return len(find_value_interpolations(source)) == 0


# --------------------------------------------------------------------------- #
# harden() report producer (Component 7 interface)
# --------------------------------------------------------------------------- #


def harden(
    sources: Union[str, Sequence[Tuple[str, str]], Sequence[str]],
) -> HardeningReport:
    """Produce a :class:`HardeningReport` for one or more SQL-construction sources.

    For each detected interpolation site:

    * **value position** -> a :class:`HardeningSite` recommending the
      ``bound-parameter`` technique (``flagged_for_review=False``). These also
      populate :attr:`HardeningReport.value_interpolations`, so the report's
      ``accepted`` is False until the value interpolations are removed (tasks
      8.1 / 8.2).
    * **identifier position** -> a :class:`HardeningSite` recording the
      ``safe-identifier`` technique with ``flagged_for_review=True`` (Req 9.3).

    Args:
        sources: a single source string, a sequence of strings, or a sequence of
            ``(label, content)`` tuples (label used as the ``site`` prefix).

    Returns:
        A :class:`HardeningReport`. ``accepted`` is True iff zero value-position
        interpolations remain.

    Validates: Requirements 9.1, 9.2, 9.3
    """
    labelled = _normalize_sources(sources)

    sites: List[HardeningSite] = []
    value_findings: List[InterpolationFinding] = []
    for label, text in labelled:
        for finding in find_interpolations(text, source_name=label):
            site_ref = f"{label}:{finding.line}"
            if finding.position_type == _IDENTIFIER:
                sites.append(
                    HardeningSite(
                        site=site_ref,
                        position_type=_IDENTIFIER,
                        technique="safe-identifier",
                        flagged_for_review=True,
                    )
                )
            else:
                value_findings.append(finding)
                sites.append(
                    HardeningSite(
                        site=site_ref,
                        position_type=_VALUE,
                        technique="bound-parameter",
                        flagged_for_review=False,
                    )
                )

    return HardeningReport(
        sites=tuple(sites),
        value_interpolations=tuple(value_findings),
    )


def _normalize_sources(
    value: Union[str, Sequence[Tuple[str, str]], Sequence[str]],
) -> List[Tuple[str, str]]:
    """Coerce flexible source inputs into ``[(label, content), ...]``."""
    if isinstance(value, str):
        return [("source.py", value)]
    normalized: List[Tuple[str, str]] = []
    for i, item in enumerate(value):
        if isinstance(item, str):
            normalized.append((f"source.py[{i}]", item))
        else:
            label, content = item
            normalized.append((label, content))
    return normalized
