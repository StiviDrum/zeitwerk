"""Minimal fcntl stand-in so HA's test harness imports on native Windows.

Only used by scripts/test on Windows (via PYTHONPATH). CI runs on Linux with the
real module. File locking is a no-op here.
"""

LOCK_SH = 1
LOCK_EX = 2
LOCK_NB = 4
LOCK_UN = 8
F_GETFL = 3
F_SETFL = 4


def flock(fd, operation):
    return None


def lockf(fd, cmd, len=0, start=0, whence=0):
    return None


def fcntl(fd, cmd, arg=0):
    return 0
