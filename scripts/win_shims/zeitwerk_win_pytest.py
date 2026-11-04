"""Pytest plugin for native Windows test runs only (loaded by scripts/test).

asyncio on Windows needs a loopback socketpair for its event loop, which
pytest-socket blocks. Socket blocking stays active in CI (Linux).
"""

import pytest_socket


def _noop(*args, **kwargs):
    return None


pytest_socket.disable_socket = _noop
pytest_socket.socket_allow_hosts = _noop
