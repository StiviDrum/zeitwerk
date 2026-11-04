"""Stand-in for pyspeex-noise (no Windows wheels) - dev instance only."""


class _Result:
    def __init__(self, audio: bytes) -> None:
        self.audio = audio


class AudioProcessor:
    """No-op audio processor."""

    def __init__(self, *args: object, **kwargs: object) -> None:
        """Ignore settings."""

    def Process10ms(self, audio: bytes) -> _Result:
        """Return audio unchanged."""
        return _Result(audio)
