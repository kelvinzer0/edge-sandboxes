"""Core abstractions — zero-dependency, edge-compatible."""

from __future__ import annotations

import asyncio
import logging
import os
import time
from abc import ABC, abstractmethod
from collections.abc import AsyncIterator
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from enum import Enum
from typing import Any

from .exceptions import ProviderError, SandboxError, SandboxNotFoundError
from .resilience import CircuitBreaker, RetryConfig, RetryHandler

logger = logging.getLogger(__name__)


# ─── Data Models ────────────────────────────────────────────────────────────


class SandboxState(Enum):
    CREATING = "creating"
    RUNNING = "running"
    STOPPED = "stopped"
    ERROR = "error"


@dataclass
class SandboxConfig:
    """Configuration for creating a sandbox."""

    image: str | None = None
    language: str | None = None
    memory_mb: int | None = None
    cpu_cores: float | None = None
    timeout_seconds: int | None = 120
    env_vars: dict[str, str] = field(default_factory=dict)
    labels: dict[str, str] = field(default_factory=dict)
    provider_config: dict[str, Any] = field(default_factory=dict)
    setup_commands: list[str] = field(default_factory=list)
    working_dir: str | None = None


@dataclass
class ExecutionResult:
    """Result of executing a command in a sandbox."""

    exit_code: int
    stdout: str
    stderr: str
    duration_ms: int | None = None
    truncated: bool = False
    timed_out: bool = False

    @property
    def success(self) -> bool:
        return self.exit_code == 0 and not self.timed_out


@dataclass
class SandboxInstance:
    """Representation of a sandbox instance."""

    id: str
    provider: str
    state: SandboxState
    labels: dict[str, str] = field(default_factory=dict)
    created_at: datetime | None = None
    metadata: dict[str, Any] = field(default_factory=dict)


# ─── Provider Interface ─────────────────────────────────────────────────────


class SandboxProvider(ABC):
    """Abstract base class for sandbox providers.

    Design principle: all I/O goes through HTTP, so providers work
    from any runtime — CPython, Pyodide, Cloudflare Workers (via fetch shim),
    or embedded interpreters.
    """

    def __init__(self, **config: Any):
        self.config = config

    @property
    @abstractmethod
    def name(self) -> str:
        ...

    @abstractmethod
    async def create_sandbox(self, config: SandboxConfig) -> SandboxInstance:
        ...

    @abstractmethod
    async def get_sandbox(self, sandbox_id: str) -> SandboxInstance | None:
        ...

    @abstractmethod
    async def list_sandboxes(self, labels: dict[str, str] | None = None) -> list[SandboxInstance]:
        ...

    @abstractmethod
    async def execute_command(
        self,
        sandbox_id: str,
        command: str,
        timeout: int | None = None,
        env_vars: dict[str, str] | None = None,
    ) -> ExecutionResult:
        ...

    @abstractmethod
    async def destroy_sandbox(self, sandbox_id: str) -> bool:
        ...

    # ── Optional with defaults ────────────────────────────────────────────

    async def find_sandbox(self, labels: dict[str, str]) -> SandboxInstance | None:
        sandboxes = await self.list_sandboxes(labels=labels)
        running = [s for s in sandboxes if s.state == SandboxState.RUNNING]
        return running[0] if running else None

    async def upload_file(self, sandbox_id: str, local_path: str, remote_path: str) -> bool:
        raise NotImplementedError(f"{self.name} does not support file uploads")

    async def download_file(self, sandbox_id: str, remote_path: str, local_path: str) -> bool:
        raise NotImplementedError(f"{self.name} does not support file downloads")

    async def health_check(self) -> bool:
        try:
            await self.list_sandboxes()
            return True
        except Exception:
            return False


# ─── Sandbox Router (the core differentiator) ───────────────────────────────


class SandboxRouter:
    """Multi-provider router with fallback chains, circuit breakers, and
    health-aware routing.

    This is the "brain" — it decides which provider to use based on:
    1. Explicit provider request
    2. Fallback chain
    3. Health status (circuit breaker)
    4. Cost/latency hints (optional)
    """

    def __init__(self, default_provider: str | None = None):
        self.providers: dict[str, SandboxProvider] = {}
        self.default_provider = default_provider
        self._circuit_breakers: dict[str, CircuitBreaker] = {}
        self._health_cache: dict[str, tuple[bool, float]] = {}
        self._health_ttl = 30.0  # seconds

    def register_provider(
        self,
        name: str,
        provider: SandboxProvider,
        circuit_breaker: CircuitBreaker | None = None,
    ) -> None:
        self.providers[name] = provider
        self._circuit_breakers[name] = circuit_breaker or CircuitBreaker(
            failure_threshold=3,
            recovery_timeout=60.0,
        )
        if not self.default_provider:
            self.default_provider = name
        logger.info(f"Registered provider: {name}")

    def get_provider(self, name: str | None = None) -> SandboxProvider:
        name = name or self.default_provider
        if not name:
            raise ProviderError("No provider specified and no default set")
        if name not in self.providers:
            raise ProviderError(f"Provider '{name}' not registered")
        return self.providers[name]

    def _is_healthy(self, name: str) -> bool:
        cached = self._health_cache.get(name)
        if cached and time.time() - cached[1] < self._health_ttl:
            return cached[0]
        cb = self._circuit_breakers.get(name)
        return cb is None or not cb.is_open()

    def _record_success(self, name: str) -> None:
        cb = self._circuit_breakers.get(name)
        if cb:
            cb.record_success()
        self._health_cache[name] = (True, time.time())

    def _record_failure(self, name: str) -> None:
        cb = self._circuit_breakers.get(name)
        if cb:
            cb.record_failure()
        self._health_cache[name] = (False, time.time())

    def _resolve_chain(
        self,
        provider: str | None,
        fallback: list[str] | None,
    ) -> list[str]:
        """Build ordered list of providers to try."""
        chain: list[str] = []
        if provider:
            chain.append(provider)
        if fallback:
            chain.extend(fallback)
        if not chain:
            chain = [self.default_provider]  # type: ignore
        # Filter to registered + healthy
        return [p for p in chain if p in self.providers and self._is_healthy(p)]

    async def create_sandbox(
        self,
        config: SandboxConfig,
        provider: str | None = None,
        fallback: list[str] | None = None,
    ) -> tuple[SandboxInstance, str]:
        """Create sandbox with automatic failover.

        Returns:
            (sandbox_instance, provider_name_used)
        """
        chain = self._resolve_chain(provider, fallback)
        if not chain:
            raise ProviderError("No healthy providers available")

        last_error: Exception | None = None
        for p_name in chain:
            try:
                p = self.providers[p_name]
                sandbox = await p.create_sandbox(config)
                self._record_success(p_name)
                logger.info(f"Created sandbox {sandbox.id} via {p_name}")
                return sandbox, p_name
            except Exception as e:
                self._record_failure(p_name)
                logger.warning(f"Provider {p_name} failed: {e}")
                last_error = e
                continue

        raise ProviderError(f"All providers failed. Last error: {last_error}")

    async def execute_command(
        self,
        sandbox_id: str,
        command: str,
        provider: str,
        timeout: int | None = None,
        env_vars: dict[str, str] | None = None,
    ) -> ExecutionResult:
        p = self.get_provider(provider)
        return await p.execute_command(sandbox_id, command, timeout, env_vars)

    async def destroy_sandbox(self, sandbox_id: str, provider: str) -> bool:
        p = self.get_provider(provider)
        return await p.destroy_sandbox(sandbox_id)

    async def health_check(self, provider: str | None = None) -> dict[str, bool]:
        targets = [provider] if provider else list(self.providers.keys())
        results: dict[str, bool] = {}
        for name in targets:
            try:
                p = self.providers[name]
                healthy = await p.health_check()
                results[name] = healthy
                if healthy:
                    self._record_success(name)
                else:
                    self._record_failure(name)
            except Exception:
                results[name] = False
                self._record_failure(name)
        return results


# ─── High-Level EdgeSandbox ─────────────────────────────────────────────────


class _AsyncCtx:
    """Supports both `await` and `async with`."""

    def __init__(self, coro):
        self._coro = coro
        self._sandbox: EdgeSandbox | None = None

    def __await__(self):
        return self._coro.__await__()

    async def __aenter__(self) -> EdgeSandbox:
        self._sandbox = await self._coro
        return self._sandbox

    async def __aexit__(self, *args) -> None:
        if self._sandbox:
            await self._sandbox.destroy()


class EdgeSandbox:
    """High-level interface — the primary API surface.

    Usage:
        # Auto-detect provider
        sbx = await EdgeSandbox.create()

        # Explicit with fallback
        async with EdgeSandbox.create(
            provider="e2b",
            fallback=["daytona", "modal"],
        ) as sbx:
            result = await sbx.execute("python script.py")
    """

    _router: SandboxRouter | None = None
    _auto_configured = False

    def __init__(self, instance: SandboxInstance, provider_name: str):
        self._instance = instance
        self._provider_name = provider_name
        self.id = instance.id
        self.state = instance.state
        self.labels = instance.labels

    @classmethod
    def _ensure_router(cls) -> SandboxRouter:
        if cls._router is None:
            cls._router = SandboxRouter()
        if not cls._auto_configured:
            cls._auto_configure()
            cls._auto_configured = True
        return cls._router

    @classmethod
    def _auto_configure(cls) -> None:
        """Auto-register providers from env vars.

        Priority order:
        1. Daytona  (DAYTONA_API_KEY)
        2. E2B      (E2B_API_KEY)
        3. Sprites  (SPRITES_TOKEN)
        4. Hopx     (HOPX_API_KEY)
        5. Modal    (MODAL_TOKEN_ID)
        6. Cloudflare (CLOUDFLARE_SANDBOX_BASE_URL + CLOUDFLARE_API_TOKEN)
        """
        from .providers import get_provider_class

        router = cls._router
        assert router is not None

        registry: list[tuple[str, str, list[str]]] = [
            ("daytona", "daytona", ["DAYTONA_API_KEY"]),
            ("e2b", "e2b", ["E2B_API_KEY"]),
            ("sprites", "sprites", ["SPRITES_TOKEN"]),
            ("hopx", "hopx", ["HOPX_API_KEY"]),
            ("modal", "modal", ["MODAL_TOKEN_ID"]),
            ("cloudflare", "cloudflare", ["CLOUDFLARE_SANDBOX_BASE_URL", "CLOUDFLARE_API_TOKEN"]),
            ("edgeone", "edgeone", ["EDGEONE_FUNCTION_URL"]),
        ]

        for provider_name, class_key, required_envs in registry:
            if all(os.getenv(v) for v in required_envs):
                try:
                    cls_type = get_provider_class(class_key)
                    if cls_type:
                        router.register_provider(provider_name, cls_type())
                        logger.info(f"Auto-registered provider: {provider_name}")
                except Exception as e:
                    logger.debug(f"Failed to register {provider_name}: {e}")

    @classmethod
    def configure(cls, *, default_provider: str | None = None, **provider_configs) -> None:
        """Manually configure providers.

        Example:
            EdgeSandbox.configure(
                e2b_api_key="...",
                default_provider="e2b",
            )
        """
        from .providers import get_provider_class

        router = cls._ensure_router()

        mapping = {
            "e2b_api_key": ("e2b", "api_key"),
            "daytona_api_key": ("daytona", "api_key"),
            "modal_token_id": ("modal", "token_id"),
            "hopx_api_key": ("hopx", "api_key"),
            "sprites_token": ("sprites", "token"),
        }

        for config_key, (prov_name, param_name) in mapping.items():
            val = provider_configs.get(config_key)
            if val:
                cls_type = get_provider_class(prov_name)
                if cls_type:
                    router.register_provider(prov_name, cls_type(**{param_name: val}))

        cf_cfg = provider_configs.get("cloudflare_config")
        if cf_cfg:
            cls_type = get_provider_class("cloudflare")
            if cls_type:
                router.register_provider("cloudflare", cls_type(**cf_cfg))

        if default_provider:
            router.default_provider = default_provider

    @classmethod
    async def _create_impl(
        cls,
        provider: str | None = None,
        fallback: list[str] | None = None,
        labels: dict[str, str] | None = None,
        env_vars: dict[str, str] | None = None,
        timeout: int = 300,
        image: str | None = None,
        **kwargs: Any,
    ) -> EdgeSandbox:
        router = cls._ensure_router()
        config = SandboxConfig(
            labels=labels or {},
            env_vars=env_vars or {},
            timeout_seconds=timeout,
            image=image,
            **kwargs,
        )
        instance, used_provider = await router.create_sandbox(
            config=config, provider=provider, fallback=fallback,
        )
        return cls(instance, used_provider)

    @classmethod
    def create(cls, *, provider=None, fallback=None, **kwargs) -> _AsyncCtx:
        """Create sandbox — supports both `await` and `async with`."""
        return _AsyncCtx(cls._create_impl(provider=provider, fallback=fallback, **kwargs))

    @classmethod
    async def find(cls, labels: dict[str, str], provider: str | None = None) -> EdgeSandbox | None:
        router = cls._ensure_router()
        targets = [provider] if provider else list(router.providers.keys())
        for pname in targets:
            try:
                p = router.get_provider(pname)
                inst = await p.find_sandbox(labels)
                if inst:
                    return cls(inst, pname)
            except Exception:
                continue
        return None

    async def execute(
        self,
        command: str,
        env_vars: dict[str, str] | None = None,
        timeout: int | None = None,
    ) -> ExecutionResult:
        router = self._ensure_router()
        return await router.execute_command(
            self.id, command, self._provider_name, timeout, env_vars,
        )

    async def execute_many(
        self,
        commands: list[str],
        stop_on_error: bool = True,
        **kwargs: Any,
    ) -> list[ExecutionResult]:
        results = []
        for cmd in commands:
            r = await self.execute(cmd, **kwargs)
            results.append(r)
            if stop_on_error and not r.success:
                break
        return results

    async def stream(self, command: str, **kwargs: Any) -> AsyncIterator[str]:
        result = await self.execute(command, **kwargs)
        chunk_size = 256
        for i in range(0, len(result.stdout), chunk_size):
            yield result.stdout[i : i + chunk_size]

    async def destroy(self) -> bool:
        router = self._ensure_router()
        return await router.destroy_sandbox(self.id, self._provider_name)

    async def __aenter__(self) -> EdgeSandbox:
        return self

    async def __aexit__(self, *args) -> None:
        await self.destroy()

    def __repr__(self) -> str:
        return f"<EdgeSandbox id={self.id} provider={self._provider_name}>"


# ─── Convenience Functions ──────────────────────────────────────────────────


async def run(command: str, *, provider: str | None = None, **kwargs: Any) -> ExecutionResult:
    """One-shot: create sandbox → execute → destroy."""
    async with EdgeSandbox.create(provider=provider, **kwargs) as sbx:
        return await sbx.execute(command)


async def run_many(
    commands: list[str],
    *,
    provider: str | None = None,
    **kwargs: Any,
) -> list[ExecutionResult]:
    """One-shot: create sandbox → execute multiple → destroy."""
    async with EdgeSandbox.create(provider=provider, **kwargs) as sbx:
        return await sbx.execute_many(commands)
