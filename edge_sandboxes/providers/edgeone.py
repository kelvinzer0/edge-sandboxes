"""EdgeOne provider — Tencent Cloud edge sandboxes via EdgeOne Functions API."""

from __future__ import annotations

import asyncio
import logging
import os
import time
import uuid
from collections.abc import AsyncIterator
from typing import Any

from ..core import (
    ExecutionResult,
    SandboxConfig,
    SandboxInstance,
    SandboxProvider,
    SandboxState,
)
from ..exceptions import ProviderError, SandboxError, SandboxNotFoundError

logger = logging.getLogger(__name__)

try:
    import httpx

    _HAS_HTTPX = True
except ImportError:
    _HAS_HTTPX = False

import json as _json
import urllib.request as _urllib


class EdgeOneProvider(SandboxProvider):
    """Tencent EdgeOne sandbox provider.

    Interacts with EdgeOne Edge Functions as a sandbox routing layer.
    EdgeOne uses standard Web Service Worker API (similar to Cloudflare Workers).

    This provider calls a deployed EdgeOne Function that acts as the
    sandbox router, forwarding create/execute/destroy commands to
    underlying providers (E2B, Daytona, etc.).

    Environment variables:
        EDGEONE_FUNCTION_URL — URL of the deployed EdgeOne function
        EDGEONE_API_TOKEN   — Bearer token for auth
    """

    def __init__(
        self,
        function_url: str | None = None,
        api_token: str | None = None,
        timeout: float = 30.0,
        **kwargs: Any,
    ):
        super().__init__(**kwargs)
        self.function_url = (
            function_url or os.getenv("EDGEONE_FUNCTION_URL", "")
        ).rstrip("/")
        self.api_token = api_token or os.getenv("EDGEONE_API_TOKEN", "")
        self.timeout = timeout
        self._last_accessed: dict[str, float] = {}

        if not self.function_url:
            raise ProviderError("EDGEONE_FUNCTION_URL required")

    @property
    def name(self) -> str:
        return "edgeone"

    def _headers(self) -> dict[str, str]:
        h = {"Content-Type": "application/json", "User-Agent": "edge-sandboxes/0.1.0"}
        if self.api_token:
            h["Authorization"] = f"Bearer {self.api_token}"
        return h

    async def _request(self, method: str, path: str, body: dict | None = None) -> Any:
        url = f"{self.function_url}{path}"
        headers = self._headers()
        body_bytes = _json.dumps(body).encode() if body else None

        if _HAS_HTTPX:
            async with httpx.AsyncClient(timeout=httpx.Timeout(self.timeout)) as client:
                resp = await client.request(method, url, headers=headers, content=body_bytes)
        else:
            req = _urllib.Request(url, data=body_bytes, headers=headers, method=method)
            resp_raw = await asyncio.to_thread(_urllib.urlopen, req, timeout=self.timeout)
            text = resp_raw.read().decode()
            status = resp_raw.status
            if status == 404:
                raise SandboxNotFoundError(f"Not found: {path}")
            if status >= 400:
                raise SandboxError(f"EdgeOne API error ({status}): {text}")
            ct = resp_raw.headers.get("content-type", "")
            return _json.loads(text) if "json" in ct else None

        if resp.status_code == 404:
            raise SandboxNotFoundError(f"Not found: {path}")
        if resp.status_code >= 400:
            raise SandboxError(f"EdgeOne API error ({resp.status_code}): {resp.text}")
        if "json" in resp.headers.get("content-type", ""):
            return resp.json()
        return None

    async def create_sandbox(self, config: SandboxConfig) -> SandboxInstance:
        payload = {
            "provider": config.provider_config.get("provider"),
            "fallback": config.provider_config.get("fallback", []),
            "image": config.image,
            "labels": config.labels or {},
            "env_vars": config.env_vars or {},
            "timeout": config.timeout_seconds,
        }
        data = await self._request("POST", "/create", payload)

        sid = data.get("id", "")
        provider_used = data.get("_provider", "unknown")
        self._last_accessed[sid] = time.time()

        return SandboxInstance(
            id=sid,
            provider=f"edgeone/{provider_used}",
            state=SandboxState.RUNNING,
            labels=config.labels or {},
            metadata={"edgeone_function": self.function_url, "underlying_provider": provider_used},
        )

    async def get_sandbox(self, sandbox_id: str) -> SandboxInstance | None:
        # EdgeOne acts as a proxy — sandbox state is managed by underlying providers
        if sandbox_id in self._last_accessed:
            return SandboxInstance(
                id=sandbox_id,
                provider="edgeone",
                state=SandboxState.RUNNING,
            )
        return None

    async def list_sandboxes(self, labels: dict[str, str] | None = None) -> list[SandboxInstance]:
        # List from underlying providers via EdgeOne proxy
        try:
            data = await self._request("GET", "/health")
            # Return empty — actual listing depends on underlying providers
            return []
        except Exception:
            return []

    async def execute_command(
        self,
        sandbox_id: str,
        command: str,
        timeout: int | None = None,
        env_vars: dict[str, str] | None = None,
    ) -> ExecutionResult:
        self._last_accessed[sandbox_id] = time.time()

        # Determine underlying provider from metadata
        # In practice, this should be tracked from create_sandbox
        payload = {
            "command": command,
            "provider": "e2b",  # Default — should be tracked from create
            "timeout": timeout,
        }
        data = await self._request("POST", f"/{sandbox_id}/exec", payload)

        return ExecutionResult(
            exit_code=data.get("exit_code", 0),
            stdout=data.get("stdout", ""),
            stderr=data.get("stderr", ""),
            duration_ms=data.get("duration_ms"),
        )

    async def destroy_sandbox(self, sandbox_id: str) -> bool:
        try:
            await self._request("DELETE", f"/{sandbox_id}")
            self._last_accessed.pop(sandbox_id, None)
            return True
        except Exception:
            return False

    async def stream_execution(
        self,
        sandbox_id: str,
        command: str,
        timeout: int | None = None,
        env_vars: dict[str, str] | None = None,
    ) -> AsyncIterator[str]:
        result = await self.execute_command(sandbox_id, command, timeout, env_vars)
        for i in range(0, len(result.stdout), 256):
            yield result.stdout[i : i + 256]

    async def health_check(self) -> bool:
        try:
            await self._request("GET", "/health")
            return True
        except Exception:
            return False
