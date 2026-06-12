"""
edge-sandboxes — Edge-native universal sandbox router.

Write once, run anywhere. Provider-agnostic sandbox execution
with automatic fallback, circuit breakers, and edge deployment support.

Providers: E2B, Daytona, Modal, Cloudflare, Fly.io Sprites, Hopx, Vercel
"""

__version__ = "0.1.0"

from .core import (
    EdgeSandbox,
    ExecutionResult,
    SandboxConfig,
    SandboxProvider,
    SandboxRouter,
    run,
    run_many,
)
from .exceptions import (
    ProviderError,
    SandboxAuthError,
    SandboxError,
    SandboxNotFoundError,
    SandboxTimeoutError,
)
from .multi_account import MultiAccountProvider
from .resilience import CircuitBreaker, RetryConfig

__all__ = [
    # High-level
    "EdgeSandbox",
    "run",
    "run_many",
    # Core
    "SandboxProvider",
    "SandboxRouter",
    "SandboxConfig",
    "ExecutionResult",
    # Multi-account
    "MultiAccountProvider",
    # Resilience
    "CircuitBreaker",
    "RetryConfig",
    # Exceptions
    "SandboxError",
    "SandboxNotFoundError",
    "SandboxTimeoutError",
    "SandboxAuthError",
    "ProviderError",
]
