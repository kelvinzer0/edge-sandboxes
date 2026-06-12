"""Daytona provider — Docker-based persistent sandboxes."""

from __future__ import annotations

import logging
import os
import time
from datetime import datetime, timezone
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


class DaytonaProvider(SandboxProvider):
    """Daytona sandbox provider via REST API."""

    def __init__(self, api_key: str | None = None, base_url: str | None = None, **kwargs: Any):
        super().__init__(**kwargs)
        self.api_key = api_key or os.getenv("DAYTONA_API_KEY", "")
        self.base_url = (base_url or os.getenv("DAYTONA_API_URL", "https://app.daytona.io/api")).rstrip("/")
        if not self.api_key:
            raise ProviderError("DAYTONA_API_KEY required")
        self._sandboxes: dict[str, dict[str, Any]] = {}

    @property
    def name(self) -> str:
        return "daytona"

    def _headers(self) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }

    async def _request(self, method: str, path: str, body: dict | None = None) -> Any:
        import json as _json
        import urllib.request as _urllib
        import asyncio

        url = f"{self.base_url}{path}"
        headers = self._headers()
        body_bytes = _json.dumps(body).encode() if body else None

        if _HAS_HTTPX:
            async with httpx.AsyncClient(timeout=httpx.Timeout(30)) as client:
                resp = await client.request(method, url, headers=headers, content=body_bytes)
                if resp.status_code >= 400:
                    raise SandboxError(f"Daytona API error ({resp.status_code}): {resp.text}")
                return resp.json() if resp.text else None
        else:
            req = _urllib.Request(url, data=body_bytes, headers=headers, method=method)
            resp = await asyncio.to_thread(_urllib.urlopen, req, timeout=30)
            text = resp.read().decode()
            return _json.loads(text) if text else None

    async def create_sandbox(self, config: SandboxConfig) -> SandboxInstance:
        payload = {
            "image": config.image or "daytonaio/ai-test:0.2.3",
            "envVars": config.env_vars,
            "labels": config.labels,
        }
        data = await self._request("POST", "/sandboxes", payload)
        sid = data.get("id", "")
        meta = {"data": data, "labels": config.labels or {}, "created_at": datetime.now(timezone.utc)}
        self._sandboxes[sid] = meta
        return SandboxInstance(
            id=sid, provider=self.name, state=SandboxState.RUNNING,
            labels=config.labels or {}, created_at=meta["created_at"],
        )

    async def get_sandbox(self, sandbox_id: str) -> SandboxInstance | None:
        try:
            data = await self._request("GET", f"/sandboxes/{sandbox_id}")
            return SandboxInstance(
                id=sandbox_id, provider=self.name, state=SandboxState.RUNNING,
                labels=data.get("labels", {}),
            )
        except Exception:
            return None

    async def list_sandboxes(self, labels: dict[str, str] | None = None) -> list[SandboxInstance]:
        data = await self._request("GET", "/sandboxes")
        items = data if isinstance(data, list) else data.get("items", [])
        results = []
        for item in items:
            if labels and not all(item.get("labels", {}).get(k) == v for k, v in labels.items()):
                continue
            results.append(SandboxInstance(
                id=item["id"], provider=self.name, state=SandboxState.RUNNING,
                labels=item.get("labels", {}),
            ))
        return results

    async def execute_command(
        self, sandbox_id: str, command: str, timeout: int | None = None,
        env_vars: dict[str, str] | None = None,
    ) -> ExecutionResult:
        start = time.time()
        payload = {"command": command}
        if env_vars:
            payload["envVars"] = env_vars
        data = await self._request("POST", f"/sandboxes/{sandbox_id}/exec", payload)
        return ExecutionResult(
            exit_code=data.get("exitCode", 0),
            stdout=data.get("stdout", ""),
            stderr=data.get("stderr", ""),
            duration_ms=int((time.time() - start) * 1000),
        )

    async def destroy_sandbox(self, sandbox_id: str) -> bool:
        try:
            await self._request("DELETE", f"/sandboxes/{sandbox_id}")
            self._sandboxes.pop(sandbox_id, None)
            return True
        except Exception:
            return False
