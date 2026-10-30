import os
import socket

import pytest

_REAL_CONNECT = socket.socket.connect
_LOCAL = {"127.0.0.1", "::1", "localhost", "testserver"}


@pytest.fixture(autouse=True)
def no_internet(monkeypatch):
    """Any attempt to reach a non-local address fails the test, so nothing here can call Google or spend the API key.
    Local connections (the scratch pgvector database) are still allowed."""

    def guarded(self, address, *a, **k):
        host = address[0] if isinstance(address, tuple) else str(address)
        if host not in _LOCAL and not host.startswith("/"):
            raise RuntimeError(f"network access blocked in tests: {host}")
        return _REAL_CONNECT(self, address, *a, **k)

    monkeypatch.setattr(socket.socket, "connect", guarded)


@pytest.fixture
def contracts_dir():
    here = os.path.dirname(__file__)
    return os.environ.get("CONTRACTS_DIR") or os.path.abspath(os.path.join(here, "..", "..", "..", "contracts"))
