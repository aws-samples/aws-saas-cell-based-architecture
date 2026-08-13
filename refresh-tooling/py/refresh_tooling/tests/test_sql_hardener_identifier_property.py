"""Property 6: Safe identifier handling is injection-safe.

Feature: codebase-modernization-refresh, Property 6: Safe identifier handling
is injection-safe.

Validates: Requirements 9.3

For *any* string used as a non-parameterizable SQL identifier (including strings
containing double quotes, semicolons, SQL comments, SQL keywords, and
whitespace), :func:`safe_identifier` produces a single correctly
quoted/escaped identifier that:

  (a) is delimited by an outer pair of double quotes;
  (b) escapes every embedded double quote by doubling it, so no payload can
      terminate the identifier early or introduce additional statements; and
  (c) round-trips back to the original value via :func:`unquote_identifier`.

The generators below combine arbitrary unicode text with a curated bank of
adversarial injection payloads, and the test runs a minimum of 100 iterations.
"""
from hypothesis import given, settings
from hypothesis import strategies as st

from refresh_tooling.sql_hardener import (
    is_valid_unquoted_identifier,
    safe_identifier,
    unquote_identifier,
)

# --------------------------------------------------------------------------- #
# Generators                                                                  #
# --------------------------------------------------------------------------- #

# Curated adversarial fragments: embedded double quotes, statement
# terminators, SQL comments, SQL keywords, and whitespace. A safe identifier
# must neutralise all of these.
_PAYLOAD_FRAGMENTS = [
    '"',
    '""',
    '";',
    '"; DROP TABLE users; --',
    '"; DROP DATABASE prod; --',
    "'; DELETE FROM products; --",
    "; SELECT 1",
    "-- comment",
    "/* block comment */",
    "tenant\"; CREATE ROLE evil; --",
    "DROP DATABASE",
    "SELECT",
    "OR 1=1",
    "\\",
    "back\\slash",
    "new\nline",
    "tab\tchar",
    "carriage\rreturn",
    "  leading and trailing  ",
    "中文标识",
    "emoji😈name",
    "tenant_42",
    "Mixed_Case",
]

_payload = st.sampled_from(_PAYLOAD_FRAGMENTS)

# Arbitrary text excluding the NUL byte (psycopg rejects NUL in identifiers, and
# safe_identifier mirrors that), constrained to be non-empty so it is a valid
# identifier value.
_arbitrary_text = st.text(
    alphabet=st.characters(blacklist_characters="\x00"),
    min_size=1,
    max_size=40,
)


@st.composite
def _identifier_value(draw):
    """A non-empty identifier value mixing arbitrary text and adversarial bits."""
    pieces = draw(
        st.lists(st.one_of(_payload, _arbitrary_text), min_size=1, max_size=4)
    )
    value = "".join(pieces)
    # Guard against the (rare) all-empty join; keep it a valid identifier value.
    return value if value != "" else draw(_payload)


def _scan_delimited(quoted: str) -> int:
    """Return the index of the closing delimiter of the leading quoted token.

    Walks a PostgreSQL-style double-quoted identifier from index 0, treating a
    doubled ``""`` as one escaped quote and a lone ``"`` as the terminator.
    Returns the index of the terminating quote, or -1 if the token is unclosed.

    Used to prove injection safety: if the only terminator is the final
    character, no embedded payload was able to close the identifier early.
    """
    assert quoted[0] == '"'
    i = 1
    n = len(quoted)
    while i < n:
        if quoted[i] == '"':
            if i + 1 < n and quoted[i + 1] == '"':
                i += 2  # escaped quote, consume both
                continue
            return i  # lone quote -> terminator
        i += 1
    return -1


# --------------------------------------------------------------------------- #
# Property test                                                               #
# --------------------------------------------------------------------------- #


@settings(max_examples=200)
@given(_identifier_value())
def test_safe_identifier_is_injection_safe(value):
    """safe_identifier output is delimited, escapes quotes, and round-trips."""
    quoted = safe_identifier(value)

    # (a) delimited by an outer pair of double quotes.
    assert len(quoted) >= 2
    assert quoted[0] == '"'
    assert quoted[-1] == '"'

    # (b) every embedded double quote is doubled, so the identifier cannot be
    # terminated before its final character. The delimited-token scan must
    # consume the entire string and stop exactly at the last quote -- no payload
    # can break out to inject a second statement.
    terminator = _scan_delimited(quoted)
    assert terminator == len(quoted) - 1

    # Equivalently: the inner body contains only doubled quotes (even count).
    body = quoted[1:-1]
    assert body.count('"') % 2 == 0

    # (c) round-trips back to the original value.
    assert is_valid_unquoted_identifier(value)
    assert unquote_identifier(quoted) == value
