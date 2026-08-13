"""Python execution smoke tests under Python 3.13 (Task 11.3).

Feature: codebase-modernization-refresh

Validates: Requirements 4.5, 4.6, 6.5

These tests confirm that the migrated/hardened Python sources import without
exception and that a representative entry point executes to completion under
the Python 3.13 runtime. They verify that the runtime upgrade, the
``python-jose`` -> ``PyJWT`` migration, and the ``psycopg`` SQL hardening did
not break import or basic execution.

Because the sources require environment variables and AWS/DB resources, the
modules are loaded via ``importlib`` with the required environment set and the
external dependencies (boto3 clients, ``psycopg.connect`` /
``psycopg.sql``, the JWKS network fetch, and the Flask request) mocked so the
entry points can be invoked deterministically offline. Real ``PyJWT`` +
``cryptography`` and a real Flask test client are used so the migrated auth
path and the Flask routes are genuinely exercised.

On any failure, each test reports the failing source file so Requirement 4.6 /
6.5 ("report which source failed") is satisfied. A failure surfaces as an
``ImportError``/``SyntaxError`` (the runtime/migration broke import) or an
unexpected runtime error in the entry point -- never silently.
"""

from __future__ import annotations

import importlib.util
import json
import sys
import types
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

import pytest

# Real PyJWT + cryptography are installed in the .venv (task 7.5) and are used
# to genuinely exercise the migrated authorizer path.
import jwt
from jwt.algorithms import RSAAlgorithm
from cryptography.hazmat.primitives.asymmetric import rsa


# --------------------------------------------------------------------------- #
# Source locations under test (resolved relative to the repository root).
# --------------------------------------------------------------------------- #
REPO_ROOT = Path(__file__).resolve().parents[4]

AUTHORIZER_PY = (
    REPO_ROOT
    / "lib/application-plane/cell-app-plane/cdk/lambdas/authorizer.py"
)
CONTROL_PLANE_AUTHORIZER_PY = (
    REPO_ROOT
    / "lib/saas-management/cell-management-system/src/lambdas/Authorizer/controlPlaneAuthorizer.py"
)
RDS_PY = (
    REPO_ROOT
    / "lib/application-plane/cell-app-plane/cdk/lambdas/rds.py"
)
PRODUCT_PY = (
    REPO_ROOT
    / "lib/application-plane/cell-app-plane/src/product.py"
)
PRODUCT_SRC_DIR = PRODUCT_PY.parent


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #
def _load_module_from_path(source: Path, module_name: str) -> types.ModuleType:
    """Import a module from an explicit file path.

    Any import-time failure (ImportError / SyntaxError / module-level
    execution error) is re-raised as a pytest failure that names the failing
    source, satisfying the "report the failing source" requirement.
    """
    if not source.is_file():
        pytest.fail(f"[{source}] source file not found")

    spec = importlib.util.spec_from_file_location(module_name, source)
    if spec is None or spec.loader is None:
        pytest.fail(f"[{source}] could not create import spec")

    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    try:
        spec.loader.exec_module(module)
    except (ImportError, SyntaxError) as exc:  # pragma: no cover - failure path
        pytest.fail(
            f"[{source}] failed to IMPORT under Python "
            f"{sys.version_info.major}.{sys.version_info.minor}: "
            f"{type(exc).__name__}: {exc}"
        )
    except Exception as exc:  # pragma: no cover - failure path
        pytest.fail(
            f"[{source}] raised an unexpected error at module load: "
            f"{type(exc).__name__}: {exc}"
        )
    return module


def _make_rsa_jwt(claims: dict, kid: str = "test-kid"):
    """Generate an RSA keypair, sign a token, and return (token, jwk_with_kid).

    The returned JWK mirrors what a Cognito ``jwks.json`` endpoint serves and
    is used to drive the authorizer's real PyJWT verification path end to end.
    """
    private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    token = jwt.encode(
        claims, private_key, algorithm="RS256", headers={"kid": kid}
    )
    jwk = json.loads(RSAAlgorithm.to_jwk(private_key.public_key()))
    jwk["kid"] = kid
    return token, jwk


class _FakeUrlopen:
    """Context-manager stand-in for ``urllib.request.urlopen`` returning JWKS."""

    def __init__(self, payload: bytes):
        self._payload = payload

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def read(self):
        return self._payload


def _install_aws_db_mocks(monkeypatch):
    """Register hermetic mocks for boto3 / psycopg / botocore in sys.modules.

    Returns the (boto3_mock, psycopg_mock) so individual tests can configure
    return values. Removed automatically by monkeypatch teardown.
    """
    boto3_mock = mock.MagicMock(name="boto3")
    psycopg_mock = mock.MagicMock(name="psycopg")
    # ``from psycopg import sql`` must resolve to a usable attribute.
    psycopg_mock.sql = mock.MagicMock(name="psycopg.sql")

    botocore_mod = types.ModuleType("botocore")
    botocore_exc = types.ModuleType("botocore.exceptions")

    class _ClientError(Exception):
        pass

    class _NoCredentialsError(Exception):
        pass

    class _PartialCredentialsError(Exception):
        pass

    botocore_exc.ClientError = _ClientError
    botocore_exc.NoCredentialsError = _NoCredentialsError
    botocore_exc.PartialCredentialsError = _PartialCredentialsError
    botocore_mod.exceptions = botocore_exc

    monkeypatch.setitem(sys.modules, "boto3", boto3_mock)
    monkeypatch.setitem(sys.modules, "psycopg", psycopg_mock)
    monkeypatch.setitem(sys.modules, "botocore", botocore_mod)
    monkeypatch.setitem(sys.modules, "botocore.exceptions", botocore_exc)
    return boto3_mock, psycopg_mock


# --------------------------------------------------------------------------- #
# authorizer.py  (PyJWT migration + Python 3.13 runtime)  Req 4.5/4.6/6.5
# --------------------------------------------------------------------------- #
def test_authorizer_imports_and_handler_executes(monkeypatch):
    source = AUTHORIZER_PY
    region = "us-east-1"
    user_pool_id = "us-east-1_pool"
    app_client_id = "app-client-123"

    monkeypatch.setenv("AWS_REGION", region)
    monkeypatch.setenv(
        "IDP_DETAILS",
        json.dumps(
            {"details": {"userPoolId": user_pool_id, "appClientId": app_client_id}}
        ),
    )

    module = _load_module_from_path(source, "smoke_authorizer")

    now = datetime.now(tz=timezone.utc)
    claims = {
        "sub": "principal-1",
        "cognito:username": "alice",
        "custom:tenantId": "tenant-a",
        "custom:role": "admin",
        "aud": app_client_id,
        "iss": f"https://cognito-idp.{region}.amazonaws.com/{user_pool_id}",
        "exp": now + timedelta(hours=1),
        "iat": now,
    }
    token, jwk = _make_rsa_jwt(claims)
    jwks_payload = json.dumps({"keys": [jwk]}).encode("utf-8")

    event = {
        "authorizationToken": f"Bearer {token}",
        "methodArn": (
            "arn:aws:execute-api:us-east-1:123456789012:abcdef123/"
            "prod/GET/products"
        ),
    }

    try:
        with mock.patch(
            "urllib.request.urlopen", return_value=_FakeUrlopen(jwks_payload)
        ):
            result = module.handler(event, None)
    except Exception as exc:  # pragma: no cover - failure path
        pytest.fail(
            f"[{source}] entry point handler() failed to execute: "
            f"{type(exc).__name__}: {exc}"
        )

    assert result["principalId"] == "principal-1"
    assert result["context"]["userName"] == "alice"
    assert result["context"]["tenantId"] == "tenant-a"
    assert result["context"]["userRole"] == "admin"
    assert result["policyDocument"]["Statement"], "expected an IAM policy statement"


def test_control_plane_authorizer_imports_and_handler_executes(monkeypatch):
    source = CONTROL_PLANE_AUTHORIZER_PY
    region = "us-east-1"
    user_pool_id = "us-east-1_cppool"
    app_client_id = "cp-app-client"

    monkeypatch.setenv("AWS_REGION", region)
    monkeypatch.setenv(
        "IDP_DETAILS",
        json.dumps(
            {"details": {"userPoolId": user_pool_id, "appClientId": app_client_id}}
        ),
    )

    module = _load_module_from_path(source, "smoke_control_plane_authorizer")

    now = datetime.now(tz=timezone.utc)
    claims = {
        "sub": "cp-principal",
        "cognito:username": "operator",
        "aud": app_client_id,
        "exp": now + timedelta(hours=1),
        "iat": now,
    }
    token, jwk = _make_rsa_jwt(claims)
    jwks_payload = json.dumps({"keys": [jwk]}).encode("utf-8")

    event = {
        "authorizationToken": f"Bearer {token}",
        "methodArn": (
            "arn:aws:execute-api:us-east-1:123456789012:zzz999/"
            "prod/POST/cells"
        ),
    }

    try:
        with mock.patch(
            "urllib.request.urlopen", return_value=_FakeUrlopen(jwks_payload)
        ):
            result = module.handler(event, None)
    except Exception as exc:  # pragma: no cover - failure path
        pytest.fail(
            f"[{source}] entry point handler() failed to execute: "
            f"{type(exc).__name__}: {exc}"
        )

    assert result["principalId"] == "cp-principal"
    assert result["context"]["userName"] == "operator"
    assert result["policyDocument"]["Statement"], "expected an IAM policy statement"


# --------------------------------------------------------------------------- #
# rds.py  (psycopg hardening + Python 3.13 runtime)  Req 4.5/4.6/6.5
# --------------------------------------------------------------------------- #
def test_rds_imports_and_handler_executes(monkeypatch):
    source = RDS_PY
    boto3_mock, psycopg_mock = _install_aws_db_mocks(monkeypatch)
    monkeypatch.setenv("AWS_REGION", "us-east-1")
    monkeypatch.setenv("DB_CRED_SECRET_NAME", "db-admin-secret")

    module = _load_module_from_path(source, "smoke_rds")

    secret_string = json.dumps(
        {
            "password": "pw",
            "username": "admin",
            "host": "db.local",
            "port": 5432,
        }
    )
    module.secrets_manager.get_secret_value.return_value = {
        "SecretString": secret_string
    }

    # PROVISION path exercises the hardened psycopg.sql.Identifier composition
    # and the tenant-provisioning.sql read + run_provisioning_script.
    provision_event = {
        "tenantState": "PROVISION",
        "tenantId": "tenant_x",
        "tenantSecretName": "tenant-x-secret",
    }
    try:
        provision_result = module.handler(provision_event, None)
    except Exception as exc:  # pragma: no cover - failure path
        pytest.fail(
            f"[{source}] entry point handler() PROVISION path failed: "
            f"{type(exc).__name__}: {exc}"
        )
    assert provision_result["status"] == "OK"
    assert module.psycopg.connect.called, "expected psycopg.connect to be invoked"

    # DE-PROVISION path exercises the DROP DATABASE / DROP USER identifier
    # composition.
    deprovision_event = {
        "tenantState": "DE-PROVISION",
        "tenantId": "tenant_x",
        "tenantSecretName": "tenant-x-secret",
    }
    try:
        deprovision_result = module.handler(deprovision_event, None)
    except Exception as exc:  # pragma: no cover - failure path
        pytest.fail(
            f"[{source}] entry point handler() DE-PROVISION path failed: "
            f"{type(exc).__name__}: {exc}"
        )
    assert deprovision_result["status"] == "OK"

    # Invalid state exercises the module's defined graceful error branch.
    invalid_result = module.handler(
        {"tenantState": "BOGUS", "tenantId": "t", "tenantSecretName": "s"}, None
    )
    assert invalid_result["status"] == "ERROR"


# --------------------------------------------------------------------------- #
# product.py  (Flask + psycopg hardening + Python 3.13 runtime)  Req 4.5/4.6/6.5
# --------------------------------------------------------------------------- #
def test_product_imports_and_routes_execute(monkeypatch):
    source = PRODUCT_PY
    boto3_mock, psycopg_mock = _install_aws_db_mocks(monkeypatch)
    monkeypatch.setenv("AWS_REGION", "us-east-1")

    # product.py does `from models.product_models import Product`.
    monkeypatch.syspath_prepend(str(PRODUCT_SRC_DIR))

    module = _load_module_from_path(source, "smoke_product")

    # Configure the (mocked) secrets manager + psycopg connection used by the
    # /product routes.
    module.secrets_manager.get_secret_value.return_value = {
        "SecretString": json.dumps(
            {
                "password": "pw",
                "username": "tenant_user",
                "host": "db.local",
                "port": 5432,
            }
        )
    }
    fake_connection = mock.MagicMock(name="connection")
    fake_cursor = mock.MagicMock(name="cursor")
    fake_cursor.fetchall.return_value = []
    fake_connection.execute.return_value = fake_cursor
    module.psycopg.connect.return_value = fake_connection

    try:
        client = module.app.test_client()
    except Exception as exc:  # pragma: no cover - failure path
        pytest.fail(
            f"[{source}] could not create Flask test client: "
            f"{type(exc).__name__}: {exc}"
        )

    # Unauthenticated entry points.
    try:
        home = client.get("/")
        health = client.get("/health")
    except Exception as exc:  # pragma: no cover - failure path
        pytest.fail(
            f"[{source}] simple routes failed to execute: "
            f"{type(exc).__name__}: {exc}"
        )
    assert home.status_code == 200
    assert health.status_code == 200
    assert health.get_json()["status"] == "UP"

    # /product GET exercises get_tenant_id (jwt.decode unverified) +
    # tenant_connection (mocked psycopg) end to end.
    token = jwt.encode(
        {"custom:tenantId": "tenant-a"}, "x" * 32, algorithm="HS256"
    )
    try:
        listing = client.get(
            "/product", headers={"Authorization": f"Bearer {token}"}
        )
    except Exception as exc:  # pragma: no cover - failure path
        pytest.fail(
            f"[{source}] /product GET entry point failed: "
            f"{type(exc).__name__}: {exc}"
        )
    assert listing.status_code == 200
    assert listing.get_json() == []
    assert module.psycopg.connect.called, "expected tenant DB connection attempt"


def test_rds_handler_propagates_provisioning_error(monkeypatch):
    """A provisioning failure must PROPAGATE (raise), not be swallowed.

    Regression guard: previously the handler caught every exception and
    returned a normal ``{"status": "ERROR"}`` response, so the invoking Step
    Functions task succeeded and a failed tenant provisioning was marked
    "available" (e.g. a CREATE ROLE failure went unnoticed). The handler must
    now re-raise so the state machine surfaces the failure.
    """
    source = RDS_PY
    _boto3_mock, _psycopg_mock = _install_aws_db_mocks(monkeypatch)
    monkeypatch.setenv("AWS_REGION", "us-east-1")
    monkeypatch.setenv("DB_CRED_SECRET_NAME", "db-admin-secret")

    module = _load_module_from_path(source, "smoke_rds_error")
    module.secrets_manager.get_secret_value.return_value = {
        "SecretString": json.dumps(
            {"password": "pw", "username": "admin", "host": "db.local", "port": 5432}
        )
    }
    # Simulate a provisioning failure at the DB layer.
    module.psycopg.connect.side_effect = RuntimeError("boom: provisioning failed")

    with pytest.raises(Exception):  # noqa: PT011 - any propagation is acceptable
        module.handler(
            {
                "tenantState": "PROVISION",
                "tenantId": "tenant_x",
                "tenantSecretName": "tenant-x-secret",
            },
            None,
        )
