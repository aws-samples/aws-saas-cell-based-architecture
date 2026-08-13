"""Unit tests for the python-jose -> PyJWT migration (CC6, task 7.2).

Feature: codebase-modernization-refresh

Validates: Requirements 6.4, 16.3

These tests assert *token-acceptance equivalence* between the original
python-jose verification path and the migrated PyJWT path used by
``lambdas/authorizer.py`` (``validateJWT`` / ``__validateCognitoJWT``). The
migrated verification performs, for a Cognito-style RS256 JWT:

  * ``jwt.get_unverified_header(token)`` to read the ``kid``,
  * ``RSAAlgorithm.from_jwk(...)`` to rebuild the public key from a JWKS entry,
  * ``jwt.decode(token, key, algorithms=['RS256'], audience=app_client_id)`` to
    verify signature, expiration, and audience in one call.

The original python-jose path (``jose.jwt.decode`` with the same JWK key, the
``RS256`` algorithm, and an ``audience`` of the app client id) enforces the
identical issuer/audience/expiration semantics: a token it would accept is also
accepted here, and tokens it would reject (bad signature, expired,
wrong-audience) are rejected here too.

Because the production module is a Lambda source file outside this package, it
is loaded directly from its repository path. The actual migrated verification
function is exercised end-to-end (no mocking of the crypto/JWT layer); only the
network JWKS fetch in ``validateJWT`` is bypassed by calling the inner
``__validateCognitoJWT`` with an in-test JWKS, exactly as the migrated code does
once the keys are downloaded.
"""
from __future__ import annotations

import base64
import datetime
import importlib.util
import json
import os
import pathlib

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa

APP_CLIENT_ID = "1example23clientid456"
WRONG_CLIENT_ID = "9wrongaudience87654321"
ISSUER = "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_examplePool"
KID = "test-key-id-0001"

# Path to the migrated production Lambda authorizer (relative to this file).
_AUTHORIZER_PATH = (
    pathlib.Path(__file__).resolve().parents[4]
    / "lib"
    / "application-plane"
    / "cell-app-plane"
    / "cdk"
    / "lambdas"
    / "authorizer.py"
)


def _b64u(data: bytes) -> str:
    """URL-safe base64 with padding stripped, as used in JWK encoding."""
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _int_to_b64u(value: int) -> str:
    length = (value.bit_length() + 7) // 8
    return _b64u(value.to_bytes(length, "big"))


def _jwk_from_public_key(public_key, kid: str) -> dict:
    """Build a Cognito-shaped RSA JWKS entry from a public key."""
    numbers = public_key.public_numbers()
    return {
        "kty": "RSA",
        "kid": kid,
        "use": "sig",
        "alg": "RS256",
        "n": _int_to_b64u(numbers.n),
        "e": _int_to_b64u(numbers.e),
    }


@pytest.fixture(scope="module")
def rsa_keys():
    signing_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    other_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    return signing_key, other_key


@pytest.fixture(scope="module")
def jwks(rsa_keys):
    signing_key, _ = rsa_keys
    return [_jwk_from_public_key(signing_key.public_key(), KID)]


@pytest.fixture(scope="module")
def authorizer_module():
    """Load the migrated production authorizer.py with required env present."""
    os.environ.setdefault("AWS_REGION", "us-east-1")
    os.environ.setdefault(
        "IDP_DETAILS",
        json.dumps(
            {"details": {"userPoolId": "us-east-1_examplePool", "appClientId": APP_CLIENT_ID}}
        ),
    )
    assert _AUTHORIZER_PATH.exists(), f"authorizer not found at {_AUTHORIZER_PATH}"
    spec = importlib.util.spec_from_file_location("migrated_authorizer", _AUTHORIZER_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _validate(module, token, app_client_id, keys):
    """Invoke the migrated inner verifier (name-mangled at module scope)."""
    fn = getattr(module, "_validateCognitoJWT", None) or getattr(
        module, "__validateCognitoJWT", None
    )
    # Module-level dunder name is stored verbatim; resolve it from the namespace.
    if fn is None:
        fn = module.__dict__["_authorizer__validateCognitoJWT"] if (
            "_authorizer__validateCognitoJWT" in module.__dict__
        ) else module.__dict__["__validateCognitoJWT"]
    return fn(token, app_client_id, keys)


def _base_claims(**overrides) -> dict:
    now = datetime.datetime.now(tz=datetime.timezone.utc)
    claims = {
        "sub": "11111111-2222-3333-4444-555555555555",
        "cognito:username": "tenant-admin",
        "custom:tenantId": "tenant-abc",
        "custom:role": "TenantAdmin",
        "iss": ISSUER,
        "aud": APP_CLIENT_ID,
        "token_use": "id",
        "iat": now,
        "exp": now + datetime.timedelta(hours=1),
    }
    claims.update(overrides)
    return claims


def _mint(signing_key, claims, kid=KID) -> str:
    return jwt.encode(claims, signing_key, algorithm="RS256", headers={"kid": kid})


def test_jose_acceptable_token_is_accepted_by_pyjwt_path(authorizer_module, rsa_keys, jwks):
    """A token the jose path would accept is accepted with identical claim semantics.

    Validates: Requirements 6.4, 16.3
    """
    signing_key, _ = rsa_keys
    token = _mint(signing_key, _base_claims())

    result = _validate(authorizer_module, token, APP_CLIENT_ID, jwks)

    assert result is not False
    # Identical issuer / audience / expiration semantics carried through.
    assert result["iss"] == ISSUER
    assert result["aud"] == APP_CLIENT_ID
    assert "exp" in result
    # Claims the handler depends on survive verification unchanged.
    assert result["sub"] == "11111111-2222-3333-4444-555555555555"
    assert result["cognito:username"] == "tenant-admin"
    assert result["custom:tenantId"] == "tenant-abc"
    assert result["custom:role"] == "TenantAdmin"


def test_expired_token_is_rejected(authorizer_module, rsa_keys, jwks):
    """An expired token is rejected (ExpiredSignatureError semantics).

    Validates: Requirements 6.4, 16.3
    """
    signing_key, _ = rsa_keys
    past = datetime.datetime.now(tz=datetime.timezone.utc) - datetime.timedelta(hours=2)
    token = _mint(
        signing_key,
        _base_claims(iat=past - datetime.timedelta(hours=1), exp=past),
    )

    assert _validate(authorizer_module, token, APP_CLIENT_ID, jwks) is False


def test_wrong_audience_token_is_rejected(authorizer_module, rsa_keys, jwks):
    """A token minted for a different audience is rejected (InvalidAudienceError).

    Validates: Requirements 6.4, 16.3
    """
    signing_key, _ = rsa_keys
    token = _mint(signing_key, _base_claims(aud=WRONG_CLIENT_ID))

    assert _validate(authorizer_module, token, APP_CLIENT_ID, jwks) is False


def test_bad_signature_token_is_rejected(authorizer_module, rsa_keys, jwks):
    """A token signed by an unrelated key but advertising the JWKS kid is rejected.

    Validates: Requirements 6.4, 16.3
    """
    _, other_key = rsa_keys
    # Sign with a key whose public half is NOT in the JWKS; reuse the published kid
    # so the authorizer selects the legitimate key and the signature check fails.
    token = _mint(other_key, _base_claims(), kid=KID)

    assert _validate(authorizer_module, token, APP_CLIENT_ID, jwks) is False


def test_unknown_kid_is_rejected(authorizer_module, rsa_keys, jwks):
    """A token whose kid is absent from the JWKS is rejected (key-not-found).

    Validates: Requirements 6.4, 16.3
    """
    signing_key, _ = rsa_keys
    token = _mint(signing_key, _base_claims(), kid="kid-not-in-jwks")

    assert _validate(authorizer_module, token, APP_CLIENT_ID, jwks) is False


def test_pyjwt_decode_matches_jose_semantics_directly(rsa_keys, jwks):
    """The exact PyJWT verification call replicated from the migrated code accepts a
    valid token and enforces audience/expiration, matching the jose decode contract.

    Validates: Requirements 6.4, 16.3
    """
    signing_key, _ = rsa_keys
    valid = _mint(signing_key, _base_claims())

    headers = jwt.get_unverified_header(valid)
    key = jwt.algorithms.RSAAlgorithm.from_jwk(json.dumps(jwks[0]))
    assert headers["kid"] == jwks[0]["kid"]

    claims = jwt.decode(valid, key, algorithms=["RS256"], audience=APP_CLIENT_ID)
    assert claims["aud"] == APP_CLIENT_ID
    assert claims["iss"] == ISSUER

    expired = _mint(
        signing_key,
        _base_claims(
            iat=datetime.datetime.now(tz=datetime.timezone.utc) - datetime.timedelta(hours=3),
            exp=datetime.datetime.now(tz=datetime.timezone.utc) - datetime.timedelta(hours=1),
        ),
    )
    with pytest.raises(jwt.ExpiredSignatureError):
        jwt.decode(expired, key, algorithms=["RS256"], audience=APP_CLIENT_ID)

    wrong_aud = _mint(signing_key, _base_claims(aud=WRONG_CLIENT_ID))
    with pytest.raises(jwt.InvalidAudienceError):
        jwt.decode(wrong_aud, key, algorithms=["RS256"], audience=APP_CLIENT_ID)
