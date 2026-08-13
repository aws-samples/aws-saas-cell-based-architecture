"""Property 4: Python dependency hygiene (exact pins, no residual replaced imports).

Feature: codebase-modernization-refresh, Property 4
Validates: Requirements 6.1, 6.4

For any generated ``requirements.txt`` content and any set of post-migration
source bodies, the validator accepts if and only if every requirement uses an
exact ``==`` specifier (no range or wildcard) AND the count of residual
``python-jose`` / ``jose`` imports is zero.
"""
from hypothesis import given, settings
from hypothesis import strategies as st

from refresh_tooling.python_dep_hygiene import (
    count_jose_imports,
    validate_python_dep_hygiene,
    validate_requirements,
)

# --------------------------------------------------------------------------- #
# Generators for requirement entries                                          #
# --------------------------------------------------------------------------- #

_PACKAGE_NAMES = ["flask", "boto3", "psycopg", "PyJWT", "requests", "urllib3", "click"]
_EXTRAS = ["", "[binary,pool]", "[crypto]", "[cryptography]"]

_version = st.from_regex(r"[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}", fullmatch=True)
_package = st.sampled_from(_PACKAGE_NAMES)
_extras = st.sampled_from(_EXTRAS)


@st.composite
def _exact_entry(draw):
    name = draw(_package) + draw(_extras)
    return {"text": f"{name}=={draw(_version)}", "is_requirement": True, "exact": True}


@st.composite
def _ranged_entry(draw):
    name = draw(_package) + draw(_extras)
    ver = draw(_version)
    ver2 = draw(_version)
    style = draw(st.sampled_from(["ge", "gt", "compat", "ne", "range", "wildcard", "bare"]))
    if style == "ge":
        text = f"{name}>={ver}"
    elif style == "gt":
        text = f"{name}>{ver}"
    elif style == "compat":
        text = f"{name}~={ver}"
    elif style == "ne":
        text = f"{name}!={ver}"
    elif style == "range":
        text = f"{name}>={ver},<{ver2}"
    elif style == "wildcard":
        major = ver.split(".")[0]
        text = f"{name}=={major}.*"
    else:  # bare, no specifier at all
        text = name
    return {"text": text, "is_requirement": True, "exact": False}


@st.composite
def _comment_entry(draw):
    body = draw(
        st.text(
            alphabet=st.characters(min_codepoint=32, max_codepoint=126),
            max_size=20,
        )
    )
    return {"text": f"# {body}", "is_requirement": False, "exact": True}


_blank_entry = st.just({"text": "", "is_requirement": False, "exact": True})

_requirement_entry = st.one_of(
    _exact_entry(),
    _ranged_entry(),
    _comment_entry(),
    _blank_entry,
)


def _build_requirements(entries):
    content = "\n".join(e["text"] for e in entries)
    expected_pinned = all(e["exact"] for e in entries if e["is_requirement"])
    return content, expected_pinned


# --------------------------------------------------------------------------- #
# Generators for source bodies (with / without jose imports)                  #
# --------------------------------------------------------------------------- #

_JOSE_IMPORT_LINES = [
    "import jose",
    "import jose.utils",
    "from jose import jwt",
    "from jose.backends import RSAKey",
    "from jose.exceptions import JWTError",
]

# Lines that mention jose-like tokens but must NOT be counted as imports.
_NON_JOSE_LINES = [
    "import os",
    "import jwt",
    "from jwt import decode, get_unverified_header",
    "from josephus import sequence",  # different package, not jose
    "x = 1  # import jose mentioned in a comment",
    "# import jose",
    "token = jose_helper()",
    "def handler(event, context):",
]


@st.composite
def _source_body(draw):
    n_jose = draw(st.integers(min_value=0, max_value=4))
    jose_lines = draw(
        st.lists(st.sampled_from(_JOSE_IMPORT_LINES), min_size=n_jose, max_size=n_jose)
    )
    other_lines = draw(st.lists(st.sampled_from(_NON_JOSE_LINES), max_size=6))
    interleave = draw(st.permutations(jose_lines + other_lines))
    return {"text": "\n".join(interleave), "jose_count": len(jose_lines)}


# --------------------------------------------------------------------------- #
# Property tests                                                              #
# --------------------------------------------------------------------------- #


@settings(max_examples=200)
@given(st.lists(_requirement_entry, max_size=10))
def test_requirements_accepted_iff_all_exact_pinned(entries):
    """validate_requirements accepts iff every requirement line is an exact == pin."""
    content, expected = _build_requirements(entries)
    assert validate_requirements(content) == expected


@settings(max_examples=200)
@given(_source_body())
def test_jose_import_count_matches_generated(body):
    """count_jose_imports counts exactly the generated jose import statements."""
    assert count_jose_imports(body["text"]) == body["jose_count"]


@settings(max_examples=200)
@given(
    st.lists(st.lists(_requirement_entry, max_size=8), min_size=1, max_size=3),
    st.lists(_source_body(), max_size=4),
)
def test_aggregate_hygiene_accepts_iff_pinned_and_no_residual_jose(req_blocks, bodies):
    """Aggregate check passes iff all requirements exact-pinned AND zero jose imports."""
    built = [_build_requirements(b) for b in req_blocks]
    requirements_contents = [content for content, _ in built]
    all_pinned = all(expected for _, expected in built)

    source_bodies = [b["text"] for b in bodies]
    total_jose = sum(b["jose_count"] for b in bodies)

    expected = all_pinned and total_jose == 0
    assert (
        validate_python_dep_hygiene(requirements_contents, source_bodies) == expected
    )
