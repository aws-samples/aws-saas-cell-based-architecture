"""Unit tests for the Python dependency hygiene validator (Task 7.3).

Feature: codebase-modernization-refresh

Covers Requirements 6.1 (exact `==` pins) and 6.4 (zero residual `jose`
imports). The property-based test for these properties lives in Task 7.4.
"""
from pathlib import Path

import pytest

from refresh_tooling.dep_hygiene import (
    count_jose_imports,
    is_exact_pinned,
    unpinned_requirement_lines,
    validate_python_dep_hygiene,
    validate_python_dep_hygiene_paths,
)

REPO_ROOT = Path(__file__).resolve().parents[4]
REAL_REQUIREMENTS = [
    REPO_ROOT
    / "lib/application-plane/cell-app-plane/cdk/lambdas/requirements.txt",
    REPO_ROOT
    / "lib/application-plane/cell-app-plane/src/resources/requirements.txt",
    REPO_ROOT
    / "lib/saas-management/cell-management-system/src/lambdas/Authorizer/requirements.txt",
]


# --- is_exact_pinned: acceptance -------------------------------------------


@pytest.mark.parametrize(
    "text",
    [
        "flask==3.1.3",
        "psycopg[binary,pool]==3.3.4",
        "PyJWT[crypto]==2.13.0",
        "boto3==1.43.34",
        "flask==3.1.3\nboto3==1.43.34\n",
        "",  # vacuously pinned
        "\n   \n",  # only blanks
        "# a comment only\n",
        "flask==3.1.3  # inline comment\n",
        "flask == 3.1.3",  # spaces around operator tolerated
        "package==1.0.0 ; python_version >= '3.8'",  # env marker ignored
    ],
)
def test_is_exact_pinned_accepts(text):
    assert is_exact_pinned(text) is True


# --- is_exact_pinned: rejection --------------------------------------------


@pytest.mark.parametrize(
    "text",
    [
        "flask",  # no version at all
        "flask>=3.0.0",
        "flask<=3.2.0",
        "flask>3.0",
        "flask<4",
        "flask~=3.1.0",  # compatible release
        "flask!=3.0.0",
        "flask==3.1.*",  # wildcard
        "flask>=3.0,<4.0",  # range with two specifiers
        "flask==3.0,!=3.0.1",  # multiple specifiers
        "-r base.txt",  # include line, unpinned
        "-e .",  # editable install, unpinned
        "git+https://example.com/pkg.git",  # VCS, unpinned
        "flask==3.1.3\nboto3>=1.0",  # one good, one bad
    ],
)
def test_is_exact_pinned_rejects(text):
    assert is_exact_pinned(text) is False


def test_unpinned_lines_reports_offenders():
    text = "flask==3.1.3\nboto3>=1.0\npsycopg[binary]==3.3.4\nrequests~=2.0\n"
    offenders = unpinned_requirement_lines(text, source="r.txt")
    assert [o.content for o in offenders] == ["boto3>=1.0", "requests~=2.0"]
    assert [o.line_number for o in offenders] == [2, 4]


# --- count_jose_imports ----------------------------------------------------


@pytest.mark.parametrize(
    "text,expected",
    [
        ("import jose", 1),
        ("import jose.jwt", 1),
        ("import jose as j", 1),
        ("from jose import jwt", 1),
        ("from jose.backends import RSAKey", 1),
        ("from jose import jwt\nimport jose.utils", 2),
        ("import jwt", 0),  # PyJWT module must not match
        ("from jwt import decode", 0),
        ("import joseph", 0),  # not the jose module
        ("from josephus import x", 0),
        ("# import jose", 0),  # commented out
        ("verbose = True", 0),  # substring 'jose'? no -> ensure no false hit
        ("", 0),
        ("from jose import jwt  # legacy", 1),
    ],
)
def test_count_jose_imports(text, expected):
    assert count_jose_imports(text) == expected


# --- aggregate report ------------------------------------------------------


def test_validate_accepts_when_pinned_and_no_jose():
    report = validate_python_dep_hygiene(
        requirements_texts=["flask==3.1.3\nPyJWT[crypto]==2.13.0\n"],
        source_texts=["import jwt\nfrom jwt import decode\n"],
    )
    assert report.exact_pinned is True
    assert report.jose_import_count == 0
    assert report.accepted is True


def test_validate_rejects_on_unpinned_requirement():
    report = validate_python_dep_hygiene(
        requirements_texts=["flask>=3.0\n"],
        source_texts=["import jwt\n"],
    )
    assert report.exact_pinned is False
    assert report.accepted is False
    assert report.unpinned[0].content == "flask>=3.0"


def test_validate_rejects_on_residual_jose_import():
    report = validate_python_dep_hygiene(
        requirements_texts=["PyJWT[crypto]==2.13.0\n"],
        source_texts=["from jose import jwt\n"],
    )
    assert report.exact_pinned is True
    assert report.jose_import_count == 1
    assert report.accepted is False


def test_validate_accepts_tuple_labeled_inputs():
    report = validate_python_dep_hygiene(
        requirements_texts=[("r.txt", "flask==3.1.3\n")],
        source_texts=[("a.py", "import jwt\n")],
    )
    assert report.accepted is True


# --- against the real migrated repository files ----------------------------


def test_real_requirements_files_are_exact_pinned():
    for path in REAL_REQUIREMENTS:
        assert path.exists(), f"missing fixture: {path}"
        assert is_exact_pinned(path.read_text(encoding="utf-8")) is True, path


def test_real_repository_accepts_hygiene():
    # No residual jose imports were found in the migrated sources (Task 7.2),
    # so passing an empty source set keeps this a focused requirements check
    # while still exercising the aggregate accept path.
    report = validate_python_dep_hygiene_paths(REAL_REQUIREMENTS, [])
    assert report.exact_pinned is True
    assert report.jose_import_count == 0
    assert report.accepted is True
