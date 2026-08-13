"""Python dependency hygiene validator (CC6 / Task 7.3).

Feature: codebase-modernization-refresh

This module implements the Python-dependency-hygiene checks for Requirements
6.1 and 6.4 of the codebase-modernization-refresh spec:

* **6.1** - every package in a ``requirements.txt`` is pinned to an explicit
  single version using ``==`` with no range or open-ended specifiers.
* **6.4** - the replaced ``python-jose`` package leaves zero residual ``jose``
  import references in the Python sources.

The public API is intentionally pure-on-text so it is trivially testable:

* :func:`is_exact_pinned` - ``requirements.txt`` content -> ``bool``
* :func:`count_jose_imports` - Python source content -> ``int``
* :func:`validate_python_dep_hygiene` - aggregate -> :class:`DepHygieneReport`

Thin file-reading convenience wrappers (:func:`validate_python_dep_hygiene_paths`)
are provided for use against the on-disk repository, but they delegate to the
pure text functions above.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable, List, Sequence, Tuple, Union

__all__ = [
    "RequirementLine",
    "DepHygieneReport",
    "is_exact_pinned",
    "iter_requirement_lines",
    "unpinned_requirement_lines",
    "count_jose_imports",
    "validate_python_dep_hygiene",
    "validate_python_dep_hygiene_paths",
]

# A requirement core looks like ``name[extra1,extra2]==1.2.3`` once surrounding
# whitespace, comments, environment markers and trailing options are removed.
# Acceptance requires EXACTLY one ``==`` operator and a concrete version that
# contains no wildcard (``*``) and no second specifier (``,``).
_PIN_RE = re.compile(
    r"""
    ^
    [A-Za-z0-9][A-Za-z0-9._-]*          # distribution name
    (?:\[[A-Za-z0-9._,-]+\])?           # optional extras, e.g. [binary,pool]
    ==                                  # the one and only exact-pin operator
    [A-Za-z0-9][A-Za-z0-9._+!-]*        # a concrete version (no '*' , no ',')
    $
    """,
    re.VERBOSE,
)

# Operators / characters that make a specifier non-exact (ranges, wildcards,
# compatible-release, exclusions, multiple specifiers).
_NON_EXACT_MARKERS = ("<", ">", "~", "!", "*")

# Residual replaced-package import detectors. The import (module) name for
# ``python-jose`` is ``jose``; PyJWT's module name is ``jwt`` and must NOT match.
_IMPORT_JOSE_RE = re.compile(r"^\s*import\s+jose(?:\s*$|[\s.,]|\s+as\s+)")
_FROM_JOSE_RE = re.compile(r"^\s*from\s+jose(?:\.|\s)")


@dataclass(frozen=True)
class RequirementLine:
    """A single non-blank, non-comment requirement line and its pin status."""

    source: str          # label/path identifying which file the line came from
    line_number: int     # 1-based physical line number within the source
    content: str         # the original (stripped) line content
    is_pinned: bool      # True iff the line is an exact ``==`` pin


@dataclass(frozen=True)
class DepHygieneReport:
    """Aggregate result of the Python dependency hygiene validation.

    ``accepted`` is True iff every requirement across all inspected files is an
    exact ``==`` pin AND the total count of residual ``jose`` imports is zero.
    """

    exact_pinned: bool
    jose_import_count: int
    unpinned: Tuple[RequirementLine, ...] = field(default_factory=tuple)
    jose_imports: Tuple[Tuple[str, int, str], ...] = field(default_factory=tuple)

    @property
    def accepted(self) -> bool:
        return self.exact_pinned and self.jose_import_count == 0


def _strip_comment(line: str) -> str:
    """Remove a ``#`` comment from a line and surrounding whitespace."""
    hash_index = line.find("#")
    if hash_index != -1:
        line = line[:hash_index]
    return line.strip()


def _requirement_core(line: str) -> str:
    """Reduce a requirement line to its ``name[extras]==version`` core.

    Strips environment markers (``; python_version < '3.8'``), trailing pip
    options (``--hash=...``), and all internal whitespace so the result can be
    matched against :data:`_PIN_RE`.
    """
    # Drop an environment marker, if present.
    core = line.split(";", 1)[0]
    # Drop trailing options such as ``--hash=...`` (always whitespace-delimited).
    core = re.split(r"\s--", core, maxsplit=1)[0]
    # Versions and names never contain internal whitespace; pip tolerates spaces
    # around the operator, so collapse all whitespace to normalise.
    core = re.sub(r"\s+", "", core)
    return core


def iter_requirement_lines(
    requirements_text: str, *, source: str = "requirements.txt"
) -> List[RequirementLine]:
    """Parse ``requirements.txt`` content into classified requirement lines.

    Blank lines and comment-only lines are ignored. Option/include lines
    (starting with ``-``, e.g. ``-r base.txt`` or ``-e .``) are treated as
    requirements that are *not* exact pins, because they introduce unpinned
    dependencies.
    """
    results: List[RequirementLine] = []
    for index, raw in enumerate(requirements_text.splitlines(), start=1):
        stripped = _strip_comment(raw)
        if not stripped:
            continue
        if stripped.startswith("-"):
            # pip option / include line: never an exact pin.
            results.append(RequirementLine(source, index, stripped, False))
            continue
        core = _requirement_core(stripped)
        pinned = bool(_PIN_RE.match(core)) and not any(
            marker in core for marker in _NON_EXACT_MARKERS
        )
        results.append(RequirementLine(source, index, stripped, pinned))
    return results


def unpinned_requirement_lines(
    requirements_text: str, *, source: str = "requirements.txt"
) -> List[RequirementLine]:
    """Return only the requirement lines that are not exact ``==`` pins."""
    return [
        line
        for line in iter_requirement_lines(requirements_text, source=source)
        if not line.is_pinned
    ]


def is_exact_pinned(requirements_text: str) -> bool:
    """Return True iff every requirement line uses an exact ``==`` pin.

    Blank lines and comments are ignored. A file with no requirement lines is
    vacuously pinned (returns True).

    Validates: Requirement 6.1
    """
    return all(line.is_pinned for line in iter_requirement_lines(requirements_text))


def count_jose_imports(source_text: str) -> int:
    """Count residual ``python-jose`` imports in Python source content.

    Matches ``import jose`` / ``import jose.<sub>`` / ``import jose as ...`` and
    ``from jose import ...`` / ``from jose.<sub> import ...``. PyJWT's ``jwt``
    module is deliberately not matched. ``#`` comment text is ignored.

    Validates: Requirement 6.4
    """
    count = 0
    for raw in source_text.splitlines():
        line = _strip_comment(raw)
        if not line:
            continue
        if _IMPORT_JOSE_RE.match(line) or _FROM_JOSE_RE.match(line):
            count += 1
    return count


def _jose_import_locations(
    source_text: str, *, source: str
) -> List[Tuple[str, int, str]]:
    locations: List[Tuple[str, int, str]] = []
    for index, raw in enumerate(source_text.splitlines(), start=1):
        line = _strip_comment(raw)
        if not line:
            continue
        if _IMPORT_JOSE_RE.match(line) or _FROM_JOSE_RE.match(line):
            locations.append((source, index, line))
    return locations


def validate_python_dep_hygiene(
    requirements_texts: Union[str, Sequence[Tuple[str, str]], Sequence[str]],
    source_texts: Union[str, Sequence[Tuple[str, str]], Sequence[str]] = (),
) -> DepHygieneReport:
    """Aggregate the dependency-hygiene checks over text inputs.

    Args:
        requirements_texts: One or more ``requirements.txt`` contents. Accepts a
            single string, a sequence of strings, or a sequence of
            ``(label, content)`` tuples (label used in the report).
        source_texts: Zero or more Python source contents in the same shapes.

    Returns:
        A :class:`DepHygieneReport`. ``accepted`` is True iff every requirement
        is exact-pinned AND there are zero residual ``jose`` imports.

    Validates: Requirements 6.1, 6.4
    """
    requirements = _normalize_inputs(requirements_texts, default_label="requirements.txt")
    sources = _normalize_inputs(source_texts, default_label="source.py")

    unpinned: List[RequirementLine] = []
    for label, text in requirements:
        unpinned.extend(unpinned_requirement_lines(text, source=label))

    jose_imports: List[Tuple[str, int, str]] = []
    for label, text in sources:
        jose_imports.extend(_jose_import_locations(text, source=label))

    return DepHygieneReport(
        exact_pinned=not unpinned,
        jose_import_count=len(jose_imports),
        unpinned=tuple(unpinned),
        jose_imports=tuple(jose_imports),
    )


def validate_python_dep_hygiene_paths(
    requirements_paths: Iterable[Union[str, Path]],
    source_paths: Iterable[Union[str, Path]] = (),
) -> DepHygieneReport:
    """File-reading convenience wrapper around :func:`validate_python_dep_hygiene`.

    Reads each path as UTF-8 text and delegates to the pure text validator. The
    path string is used as the report label for each input.
    """
    requirements = [
        (str(p), Path(p).read_text(encoding="utf-8")) for p in requirements_paths
    ]
    sources = [
        (str(p), Path(p).read_text(encoding="utf-8")) for p in source_paths
    ]
    return validate_python_dep_hygiene(requirements, sources)


def _normalize_inputs(
    value: Union[str, Sequence[Tuple[str, str]], Sequence[str]],
    *,
    default_label: str,
) -> List[Tuple[str, str]]:
    """Coerce the flexible input shapes into ``[(label, content), ...]``."""
    if isinstance(value, str):
        return [(default_label, value)]
    normalized: List[Tuple[str, str]] = []
    for i, item in enumerate(value):
        if isinstance(item, str):
            normalized.append((f"{default_label}[{i}]", item))
        else:
            label, content = item
            normalized.append((label, content))
    return normalized
