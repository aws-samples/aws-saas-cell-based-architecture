"""Scaffold smoke test: confirms the pytest + hypothesis toolchain is wired up.

Feature: codebase-modernization-refresh
"""
from hypothesis import given, settings
from hypothesis import strategies as st

import refresh_tooling


def test_package_importable():
    assert refresh_tooling.__version__ == "0.1.0"


@settings(max_examples=100)
@given(st.text(), st.text())
def test_hypothesis_runs(a, b):
    # A trivial invariant exercised across >=100 generated inputs to prove the
    # property-testing harness executes.
    assert (a == b) == (b == a)
