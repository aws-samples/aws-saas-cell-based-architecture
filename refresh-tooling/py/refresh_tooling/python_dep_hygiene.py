"""Python dependency hygiene validator (CC6).

Feature: codebase-modernization-refresh

Implements the validator behind Property 4: a refreshed Python dependency set
is considered *hygienic* if and only if

  * every requirement in every ``requirements.txt`` body uses an exact ``==``
    pin with no range or wildcard specifier (Req 6.1), and
  * no post-migration source body retains an import of the replaced package
    ``python-jose`` / ``jose`` (Req 6.4).

The functions here are intentionally pure (text in, decision out) so they can be
exercised exhaustively by property-based tests and reused by the file-level
schema check in the verification suite.

NOTE: This module is owned by task 7.3 (Implement the Python dependency hygiene
validator). It is provided here with the canonical exported names so the
Property 4 test (task 7.4) can be validated; task 7.3 may refine the internals
as long as the public interface (``is_exact_pinned``, ``count_jose_imports``,
``validate_requirements``, ``validate_python_dep_hygiene``) is preserved.
"""
from __future__ import annotations

import re
from typing import Iterable

__all__ = [
    "is_requirement_line",
    "is_exact_pinned",
    "count_jose_imports",
    "validate_requirements",
    "validate_python_dep_hygiene",
]

# Range / inequality / arbitrary-equality operators that disqualify an exact pin.
_RANGE_OPERATORS = (">=", "<=", "~=", "!=", ">", "<")

# Matches an ``import jose`` / ``import jose.x`` / ``from jose[.x] import ...``
# statement at the start of a (whitespace-stripped) line. The trailing boundary
# (``.``, whitespace, or end-of-line) prevents false matches on names such as
# ``josephus`` or ``jose_utils``.
_JOSE_IMPORT_RE = re.compile(
    r"^\s*(?:import\s+jose(?:\.\w+)*(?:\s|$|,)|from\s+jose(?:\.\w+)*\s+import\b)"
)


def _strip_comment(line: str) -> str:
    """Return the requirement portion of a line with any trailing comment removed."""
    return line.split("#", 1)[0].strip()


def is_requirement_line(line: str) -> bool:
    """True when ``line`` declares a package requirement (not blank/comment/option)."""
    spec = _strip_comment(line)
    if not spec:
        return False
    # pip option lines (e.g. ``-r base.txt``, ``--hash=...``) are not package pins.
    if spec.startswith("-"):
        return False
    return True


def is_exact_pinned(line: str) -> bool:
    """True iff a single requirement ``line`` uses an exact ``==`` pin.

    A line is exact-pinned when it contains exactly one ``==`` operator, carries a
    concrete version (no ``*`` wildcard), and contains no range/inequality or
    arbitrary-equality (``===``) operators and no multi-specifier comma.
    """
    spec = _strip_comment(line)
    if not spec:
        return False
    # Strip the bracketed extras section (e.g. ``psycopg[binary,pool]``) before
    # analysing operators, since extras legitimately contain commas.
    spec = re.sub(r"\[[^\]]*\]", "", spec)
    if "===" in spec:  # PEP 440 arbitrary equality is not an exact pin
        return False
    if any(op in spec for op in _RANGE_OPERATORS):
        return False
    if "," in spec:  # multiple specifiers => not a single exact pin
        return False
    if "*" in spec:  # wildcard version
        return False
    if spec.count("==") != 1:
        return False
    name, _, version = spec.partition("==")
    return bool(name.strip()) and bool(version.strip())


def count_jose_imports(source: str) -> int:
    """Count import statements referencing the replaced ``jose`` package in ``source``."""
    return sum(1 for line in source.splitlines() if _JOSE_IMPORT_RE.match(line))


def validate_requirements(content: str) -> bool:
    """True iff every requirement line in a ``requirements.txt`` body is exact-pinned."""
    return all(
        is_exact_pinned(line)
        for line in content.splitlines()
        if is_requirement_line(line)
    )


def validate_python_dep_hygiene(
    requirements_contents: Iterable[str],
    source_bodies: Iterable[str],
) -> bool:
    """Aggregate hygiene check.

    Accepts iff every requirement across all ``requirements.txt`` bodies is exact
    ``==`` pinned AND the total count of residual ``jose`` imports across all
    source bodies is zero.
    """
    all_pinned = all(validate_requirements(c) for c in requirements_contents)
    residual_jose = sum(count_jose_imports(s) for s in source_bodies)
    return all_pinned and residual_jose == 0
