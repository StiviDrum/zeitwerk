"""Minimal resource stand-in for native Windows test runs (see fcntl.py)."""

RLIMIT_NOFILE = 7
RLIM_INFINITY = -1


def getrlimit(res):
    return (4096, 4096)


def setrlimit(res, limits):
    return None
