"""Stand-in for pymicro-vad (no Windows wheels) - dev instance only.

Lets assist_pipeline import so the frontend's service list loads. Voice
features do not work in the native Windows dev instance.
"""


class MicroVad:
    """No-op voice activity detector."""

    def Process10ms(self, audio: bytes) -> float:
        """Report silence."""
        return 0.0
