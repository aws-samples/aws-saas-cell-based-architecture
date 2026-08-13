"""Requirements.txt schema check (Task 11.6).

Feature: codebase-modernization-refresh

This is the file-level schema check (Requirement 6.1) that asserts every
requirement line in the actual repository ``requirements.txt`` files is
exact-pinned with ``==`` (no ranges, wildcards, or open-ended specifiers;
blank lines and comments are ignored).

It is distinct from the property test (Task 7.4), which exercises the
validator over generated inputs. Here we run the canonical validator
(``refresh_tooling.dep_hygiene`` / ``refresh_tooling.is_exact_pinned``)
against the real on-disk files.
"""
from pathlib import Path

import pytest

from refresh_tooling import (
    is_exact_pinned,
    iter_requirement_lines,
    validate_python_dep_hygiene_paths,
)

# refresh-tooling/py/refresh_tooling/tests/ -> repo root is 4 levels up.
REPO_ROOT = Path(__file__).resolve().parents[4]

# Every requirements.txt in the repository that must be exact-pinned.
REQUIREMENTS_FILES = [
    REPO_ROOT
    / "lib/application-plane/cell-app-plane/cdk/lambdas/requirements.txt",
    REPO_ROOT
    / "lib/application-plane/cell-app-plane/src/resources/requirements.txt",
    REPO_ROOT
    / "lib/saas-management/cell-management-system/src/lambdas/Authorizer/requirements.txt",
]


@pytest.mark.parametrize("path", REQUIREMENTS_FILES, ids=lambda p: str(p.name))
def test_requirements_file_exists(path: Path):
    assert path.exists(), f"expected requirements file is missing: {path}"


@pytest.mark.parametrize("path", REQUIREMENTS_FILES, ids=lambda p: str(p.name))
def test_every_line_is_exact_pinned(path: Path):
    """Every real requirement line in each file is an exact ``==`` pin.

    Validates: Requirement 6.1
    """
    text = path.read_text(encoding="utf-8")

    # Per-line assertion so a failure pinpoints the offending line.
    for line in iter_requirement_lines(text, source=str(path)):
        assert line.is_pinned, (
            f"{path}:{line.line_number} is not exact-pinned with '==': "
            f"{line.content!r}"
        )

    # File-level guard mirroring the canonical helper.
    assert is_exact_pinned(text) is True, path


def test_all_requirements_files_exact_pinned_via_validator():
    """Aggregate schema check across all files via the canonical validator.

    Validates: Requirement 6.1
    """
    report = validate_python_dep_hygiene_paths(REQUIREMENTS_FILES, [])
    assert report.exact_pinned is True, [u.content for u in report.unpinned]
