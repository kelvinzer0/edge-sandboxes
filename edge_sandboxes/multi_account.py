"""Multi-account provider with round-robin routing per provider."""

from __future__ import annotations

import asyncio
import itertools
import logging
from typing import Any

from .core import (
    ExecutionResult,
    SandboxConfig,
    SandboxInstance,
    SandboxProvider,
    SandboxState,
)
from .exceptions import ProviderError
from .resilience import CircuitBreaker

logger = logging.getLogger(__name__)


class _AccountEntry:
    __slots__ = ("provider", "circuit_breaker", "healthy", "account_id")

    def __init__(
        self,
        provider: SandboxProvider,
        circuit_breaker: CircuitBreaker | None = None,
        account_id: str | None = None,
    ):
        self.provider = provider
        self.circuit_breaker = circuit_breaker or CircuitBreaker(
            failure_threshold=3,
            recovery_timeout=60.0,
        )
        self.healthy = True
        self.account_id = account_id


class MultiAccountProvider(SandboxProvider):
    """Wraps a single provider type with multiple account configs.

    Distributes requests across accounts using round-robin scheduling,
    with per-account circuit breakers for independent health tracking.

    Usage:
        # From env vars: E2B_API_KEY=key1,key2,key3
        provider = MultiAccountProvider.from_env(
            provider_class=E2BProvider,
            env_var="E2B_API_KEY",
            param_name="api_key",
        )

        # Manual
        provider = MultiAccountProvider(
            provider_class=E2BProvider,
            accounts=[
                {"api_key": "key1"},
                {"api_key": "key2"},
                {"api_key": "key3"},
            ],
        )
    """

    def __init__(
        self,
        provider_class: type[SandboxProvider],
        accounts: list[dict[str, Any]],
        name_override: str | None = None,
    ):
        if not accounts:
            raise ProviderError("MultiAccountProvider requires at least one account")

        self._provider_class = provider_class
        self._name = name_override or provider_class.__name__.replace("Provider", "").lower()
        self._entries: list[_AccountEntry] = []
        self._lock = asyncio.Lock()

        for i, acct_config in enumerate(accounts):
            try:
                provider = provider_class(**acct_config)
                entry = _AccountEntry(
                    provider=provider,
                    account_id=acct_config.get("account_id", str(i)),
                )
                self._entries.append(entry)
                logger.debug(f"Registered account {i} for {self._name}")
            except Exception as e:
                logger.warning(f"Failed to create account {i} for {self._name}: {e}")

        if not self._entries:
            raise ProviderError(f"All accounts failed to initialize for {self._name}")

        self._round_robin = itertools.cycle(range(len(self._entries)))
        logger.info(f"MultiAccountProvider '{self._name}' ready with {len(self._entries)} accounts")

    @classmethod
    def from_env(
        cls,
        provider_class: type[SandboxProvider],
        env_var: str,
        param_name: str,
        separator: str = ",",
        name_override: str | None = None,
    ) -> MultiAccountProvider:
        """Create from a comma-separated env var of API keys."""
        import os

        raw = os.getenv(env_var, "")
        if not raw:
            raise ProviderError(f"{env_var} not set")

        keys = [k.strip() for k in raw.split(separator) if k.strip()]
        if not keys:
            raise ProviderError(f"{env_var} is empty after parsing")

        if len(keys) == 1:
            # Single key — return a regular provider wrapped in multi-account
            accounts = [{param_name: keys[0]}]
        else:
            accounts = [{param_name: k, "account_id": str(i)} for i, k in enumerate(keys)]

        return cls(
            provider_class=provider_class,
            accounts=accounts,
            name_override=name_override,
        )

    @property
    def name(self) -> str:
        return self._name

    @property
    def account_count(self) -> int:
        return len(self._entries)

    def _next_healthy(self, exclude: set[int] | None = None) -> _AccountEntry | None:
        """Pick next healthy account via round-robin."""
        exclude = exclude or set()
        total = len(self._entries)
        for _ in range(total):
            idx = next(self._round_robin)
            entry = self._entries[idx]
            if idx in exclude:
                continue
            if self._is_healthy(entry):
                return entry
        return None

    def _is_healthy(self, entry: _AccountEntry) -> bool:
        if not entry.healthy:
            if entry.circuit_breaker.is_open():
                return False
            # Circuit breaker closed again — mark healthy
            entry.healthy = True
        return not entry.circuit_breaker.is_open()

    def _record_success(self, entry: _AccountEntry) -> None:
        entry.healthy = True
        entry.circuit_breaker.record_success()

    def _record_failure(self, entry: _AccountEntry) -> None:
        entry.circuit_breaker.record_failure()
        if entry.circuit_breaker.is_open():
            entry.healthy = False
            logger.warning(
                f"Account {entry.account_id} of {self._name} circuit breaker OPEN"
            )

    async def create_sandbox(self, config: SandboxConfig) -> SandboxInstance:
        tried: set[int] = set()
        total = len(self._entries)
        last_error: Exception | None = None

        while len(tried) < total:
            entry = self._next_healthy(exclude=tried)
            if entry is None:
                break

            idx = self._entries.index(entry)
            tried.add(idx)

            try:
                instance = await entry.provider.create_sandbox(config)
                self._record_success(entry)
                logger.info(
                    f"Created sandbox {instance.id} via {self._name}[{entry.account_id}]"
                )
                return instance
            except Exception as e:
                self._record_failure(entry)
                logger.warning(
                    f"Account {entry.account_id} of {self._name} failed: {e}"
                )
                last_error = e

        raise ProviderError(
            f"All {total} accounts of {self._name} failed. Last error: {last_error}"
        )

    async def get_sandbox(self, sandbox_id: str) -> SandboxInstance | None:
        for entry in self._entries:
            try:
                result = await entry.provider.get_sandbox(sandbox_id)
                if result:
                    return result
            except Exception:
                continue
        return None

    async def list_sandboxes(self, labels: dict[str, str] | None = None) -> list[SandboxInstance]:
        all_sandboxes: list[SandboxInstance] = []
        for entry in self._entries:
            try:
                sandboxes = await entry.provider.list_sandboxes(labels)
                all_sandboxes.extend(sandboxes)
            except Exception:
                continue
        return all_sandboxes

    async def execute_command(
        self,
        sandbox_id: str,
        command: str,
        timeout: int | None = None,
        env_vars: dict[str, str] | None = None,
    ) -> ExecutionResult:
        # For execute, try to find which account owns the sandbox
        for entry in self._entries:
            try:
                result = await entry.provider.execute_command(
                    sandbox_id, command, timeout, env_vars
                )
                self._record_success(entry)
                return result
            except Exception:
                continue

        # Fallback: try each account with round-robin
        tried: set[int] = set()
        total = len(self._entries)
        last_error: Exception | None = None

        while len(tried) < total:
            entry = self._next_healthy(exclude=tried)
            if entry is None:
                break

            idx = self._entries.index(entry)
            tried.add(idx)

            try:
                result = await entry.provider.execute_command(
                    sandbox_id, command, timeout, env_vars
                )
                self._record_success(entry)
                return result
            except Exception as e:
                self._record_failure(entry)
                last_error = e

        raise ProviderError(
            f"Execute failed on all accounts of {self._name}. Last: {last_error}"
        )

    async def destroy_sandbox(self, sandbox_id: str) -> bool:
        for entry in self._entries:
            try:
                result = await entry.provider.destroy_sandbox(sandbox_id)
                if result:
                    return True
            except Exception:
                continue
        return False

    async def health_check(self) -> bool:
        any_healthy = False
        for entry in self._entries:
            try:
                healthy = await entry.provider.health_check()
                if healthy:
                    self._record_success(entry)
                    any_healthy = True
                else:
                    self._record_failure(entry)
            except Exception:
                self._record_failure(entry)
        return any_healthy
