"""SQL-side checkers and source-edit helpers for the codebase-modernization-refresh.

Feature: codebase-modernization-refresh
"""

from refresh_tooling.dep_hygiene import (
    DepHygieneReport,
    RequirementLine,
    count_jose_imports,
    is_exact_pinned,
    iter_requirement_lines,
    unpinned_requirement_lines,
    validate_python_dep_hygiene,
    validate_python_dep_hygiene_paths,
)
from refresh_tooling.sql_hardener import (
    HardeningReport,
    HardeningSite,
    InterpolationFinding,
    find_interpolations,
    find_value_interpolations,
    harden,
    has_safe_sql_values,
    is_valid_unquoted_identifier,
    safe_identifier,
    unquote_identifier,
)

__all__ = [
    "__version__",
    # dep_hygiene
    "DepHygieneReport",
    "RequirementLine",
    "count_jose_imports",
    "is_exact_pinned",
    "iter_requirement_lines",
    "unpinned_requirement_lines",
    "validate_python_dep_hygiene",
    "validate_python_dep_hygiene_paths",
    # sql_hardener
    "HardeningReport",
    "HardeningSite",
    "InterpolationFinding",
    "find_interpolations",
    "find_value_interpolations",
    "harden",
    "has_safe_sql_values",
    "is_valid_unquoted_identifier",
    "safe_identifier",
    "unquote_identifier",
]

__version__ = "0.1.0"
