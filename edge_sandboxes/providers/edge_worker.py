"""Edge Worker provider — thin HTTP client for deployed edge workers."""

from __future__ import annotations

import asyncio
import logging
import os
import time
import uuid
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


class EdgeWorkerProvider(SandboxProvider):
    """Thin HTTP client that delegates to a deployed edge worker.

    The edge worker (Cloudflare / EdgeOne) handles provider selection,
    fallback chains, and circuit breakers. This provider just forwards
    requests over HTTP.

    Environment variables:
        EDGE_WORKER_URL  — URL of the deployed edge worker
        EDGE_WORKER_TOKEN — Bearer token for auth (optional)

    Usage:
        # Auto-detect from env
        provider = EdgeWorkerProvider()

        # Manual
        provider = EdgeWorkerProvider(
            worker_url="https://my-worker.workers.dev",
            api_token="secret",
        )
    """

    def __init__(
        self,
        worker_url: str | None = None,
        api_token: str | None = None,
        timeout: float = 30.0,
        **kwargs: Any,
    ):
        super().__init__(**kwargs)
        self.worker_url = (
            worker_url or os.getenv("EDGE_WORKER_URL", "")
        ).rstrip("/")
        self.api_token = api_token or os.getenv("EDGE_WORKER_TOKEN", "")
        self.timeout = timeout

        if not self.worker_url:
            raise ProviderError("EDGE_WORKER_URL required")

    @property
    def name(self) -> str:
        return "edge-worker"

    async def create_sandbox(self, config: SandboxConfig) -> SandboxInstance:
        payload: dict[str, Any] = {
            "image": config.image,
            "labels": config.labels or {},
            "env_vars": config.env_vars or {},
            "timeout": config.timeout_seconds,
        }
        if config.provider_config.get("provider"):
            payload["provider"] = config.provider_config["provider"]
        if config.provider_config.get("fallback"):
            payload["fallback"] = config.provider_config["fallback"]

        data = await self._post("/api/sandbox/create", payload)

        return SandboxInstance(
            id=data.get("id", ""),
            provider=data.get("_provider", "edge-worker"),
            state=SandboxState.RUNNING,
            labels=config.labels or {},
            metadata={
                "edge_worker": self.worker_url,
                "underlying_provider": data.get("_provider"),
            },
        )

    async def get_sandbox(self, sandbox_id: str) -> SandboxInstance | None:
        # Edge worker is stateless — sandbox state is managed by underlying providers
        # Return a basic instance if we know the ID
        return SandboxInstance(
            id=sandbox_id,
            provider="edge-worker",
            state=SandboxState.RUNNING,
        )

    async def list_sandboxes(self, labels: dict[str, str] | None = None) -> list[SandboxInstance]:
        # Edge worker doesn't expose list endpoint — underlying providers manage state
        return []

    async def execute_command(
        self,
        sandbox_id: str,
        command: str,
        timeout: int | None = None,
        env_vars: dict[str, str] | None = None,
    ) -> ExecutionResult:
        payload: dict[str, Any] = {"command": command}
        if timeout:
            payload["timeout"] = timeout

        data = await self._post(f"/api/sandbox/{sandbox_id}/exec", payload)

        return ExecutionResult(
            exit_code=data.get("exit_code", 0),
            stdout=data.get("stdout", ""),
            stderr=data.get("stderr", ""),
            duration_ms=data.get("duration_ms"),
        )

    async def destroy_sandbox(self, sandbox_id: str) -> bool:
        try:
            await self._delete(f"/api/sandbox/{sandbox_id}")
            return True
        except Exception:
            return False

    async def health_check(self) -> bool:
        try:
            await self._get("/api/sandbox/health")
            return True
        except Exception:
            return False

    # ── HTTP helpers ───────────────────────────────────────────────────

    def _headers(self) -> dict[str, str]:
        h = {"Content-Type": "application/json", "User-Agent": "edge-sandboxes/0.1.0"}
        if self.api_token:
            h["Authorization"] = f"Bearer {self.api_token}"
        return h

    async def _request(self, method: str, path: str, body: dict | None = None) -> Any:
        url = f"{self.worker_url}{path}"
        headers = self._headers()
        body_bytes = _json.dumps(body).encode() if body else None

        if _HAS_HTTPX:
            async with httpx.AsyncClient(timeout=httpx.Timeout(self.timeout)) as client:
                resp = await client.request(method, url, headers=headers, content=body_bytes)
        else:
            req = _urllib.Request(url, data=body_bytes, headers=headers, method=method)
            resp_raw = await asyncio.to_thread(_urllib.urlopen, req, timeout=self.timeout)
            status = resp_raw.status
            text = resp_raw.read().decode()
            if status == 404:
                raise SandboxNotFoundError(f"Not found: {path}")
            if status >= 400:
                raise SandboxError(f"Edge Worker API error ({status}): {text}")
            ct = resp_raw.headers.get("content-type", "")
            return _json.loads(text) if "json" in ct else None

        if resp.status_code == 404:
            raise SandboxNotFoundError(f"Not found: {path}")
        if resp.status_code >= 400:
            raise SandboxError(f"Edge Worker API error ({resp.status_code}): {resp.text}")
        if "json" in resp.headers.get("content-type", ""):
            return resp.json()
        return None

    async def _get(self, path: str) -> Any:
        return await self._request("GET", path)

    async def _post(self, path: str, body: dict) -> Any:
        return await self._request("POST", path, body)

    async def _delete(self, path: str) -> Any:
        return await self._request("DELETE", path)
