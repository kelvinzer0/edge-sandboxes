"""Exceptions for edge-sandboxes."""


class SandboxError(Exception):
    """Base exception for sandbox operations."""


class SandboxNotFoundError(SandboxError):
    """Sandbox not found."""


class SandboxTimeoutError(SandboxError):
    """Operation timed out."""


class SandboxAuthError(SandboxError):
    """Authentication failed."""


class ProviderError(SandboxError):
    """Provider-level error."""


class SandboxQuotaError(SandboxError):
    """Quota or capacity limit reached."""
