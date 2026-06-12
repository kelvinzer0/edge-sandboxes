"""Cloudflare provider — HTTP-based, works from edge or server."""

from __future__ import annotations

import asyncio
import base64
import logging
import os
import re
import shlex
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

# Fallback: use stdlib urllib if httpx not available (edge compat)
import json as _json
import urllib.request as _urllib

_ENV_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


class CloudflareProvider(SandboxProvider):
    """Interact with a Cloudflare Sandbox Worker via HTTP.

    This provider is fully edge-compatible — it only needs HTTP fetch,
    no heavy SDK dependencies.
    """

    def __init__(
        self,
        *,
        base_url: str | None = None,
        api_token: str | None = None,
        account_id: str | None = None,
        timeout: float = 30.0,
        **kwargs: Any,
    ):
        super().__init__(**kwargs)
        self.base_url = (base_url or os.getenv("CLOUDFLARE_SANDBOX_BASE_URL", "")).rstrip("/")
        self.api_token = api_token or os.getenv("CLOUDFLARE_API_TOKEN", "")
        self.account_id = account_id or os.getenv("CLOUDFLARE_ACCOUNT_ID")
        self.timeout = timeout
        self._last_accessed: dict[str, float] = {}

        if not self.base_url:
            raise ProviderError("CLOUDFLARE_SANDBOX_BASE_URL required")

    @property
    def name(self) -> str:
        return "cloudflare"

    async def create_sandbox(self, config: SandboxConfig) -> SandboxInstance:
        session_id = self._determine_session_id(config)
        payload = {
            "id": session_id,
            "env": config.env_vars or {},
            "cwd": config.working_dir or "/workspace",
            "isolation": True,
        }
        await self._post("/api/session/create", payload)
        self._touch(session_id)

        return SandboxInstance(
            id=session_id,
            provider=self.name,
            state=SandboxState.RUNNING,
            labels=config.labels or {},
        )

    async def get_sandbox(self, sandbox_id: str) -> SandboxInstance | None:
        sessions = await self.list_sandboxes()
        for s in sessions:
            if s.id == sandbox_id:
                return s
        return None

    async def list_sandboxes(self, labels: dict[str, str] | None = None) -> list[SandboxInstance]:
        data = await self._get("/api/session/list")
        sessions = data.get("sessions", [])
        results = []
        for sid in sessions:
            sbx = SandboxInstance(
                id=sid,
                provider=self.name,
                state=SandboxState.RUNNING,
                labels={"session": sid},
            )
            if labels and not all(sbx.labels.get(k) == v for k, v in labels.items()):
                continue
            results.append(sbx)
        return results

    async def execute_command(
        self,
        sandbox_id: str,
        command: str,
        timeout: int | None = None,
        env_vars: dict[str, str] | None = None,
    ) -> ExecutionResult:
        self._touch(sandbox_id)
        cmd = self._apply_env(command, env_vars)
        data = await self._post("/api/execute", {"id": sandbox_id, "command": cmd})
        return ExecutionResult(
            exit_code=data.get("exitCode", data.get("exit_code", 0)),
            stdout=data.get("stdout", ""),
            stderr=data.get("stderr", ""),
        )

    async def destroy_sandbox(self, sandbox_id: str) -> bool:
        try:
            await self._delete(f"/api/process/kill-all?session={sandbox_id}")
        except SandboxNotFoundError:
            return False
        self._last_accessed.pop(sandbox_id, None)
        return True

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
            await self._get("/api/ping")
            return True
        except Exception:
            return False

    # ── HTTP helpers (edge-compatible: httpx or stdlib) ──────────────────

    def _headers(self) -> dict[str, str]:
        h = {"Content-Type": "application/json", "User-Agent": "edge-sandboxes/0.1.0"}
        if self.api_token:
            h["Authorization"] = f"Bearer {self.api_token}"
        if self.account_id:
            h["CF-Account-ID"] = self.account_id
        return h

    async def _request(self, method: str, path: str, body: dict | None = None) -> Any:
        url = f"{self.base_url}{path}"
        headers = self._headers()
        body_bytes = _json.dumps(body).encode() if body else None

        if _HAS_HTTPX:
            async with httpx.AsyncClient(timeout=httpx.Timeout(self.timeout)) as client:
                resp = await client.request(method, url, headers=headers, content=body_bytes)
        else:
            # Stdlib fallback — blocking but works everywhere
            req = _urllib.Request(url, data=body_bytes, headers=headers, method=method)
            resp_raw = await asyncio.to_thread(_urllib.urlopen, req, timeout=self.timeout)
            status = resp_raw.status
            text = resp_raw.read().decode()
            if status == 404:
                raise SandboxNotFoundError(f"Not found: {path}")
            if status >= 400:
                raise SandboxError(f"API error ({status}): {text}")
            ct = resp_raw.headers.get("content-type", "")
            return _json.loads(text) if "json" in ct else None

        if resp.status_code == 404:
            raise SandboxNotFoundError(f"Not found: {path}")
        if resp.status_code >= 400:
            raise SandboxError(f"API error ({resp.status_code}): {resp.text}")
        if "json" in resp.headers.get("content-type", ""):
            return resp.json()
        return None

    async def _get(self, path: str) -> Any:
        return await self._request("GET", path)

    async def _post(self, path: str, body: dict) -> Any:
        return await self._request("POST", path, body)

    async def _delete(self, path: str) -> Any:
        return await self._request("DELETE", path)

    # ── Helpers ──────────────────────────────────────────────────────────

    def _touch(self, sid: str) -> None:
        self._last_accessed[sid] = time.time()

    def _determine_session_id(self, config: SandboxConfig) -> str:
        if config.labels:
            for key in ("session", "cloudflare", "name"):
                val = config.labels.get(key)
                if val:
                    return val.replace(" ", "-").strip()
        return f"cf-sbx-{uuid.uuid4().hex[:12]}"

    @staticmethod
    def _apply_env(command: str, env_vars: dict[str, str] | None) -> str:
        if not env_vars:
            return command
        exports = " && ".join(
            f"export {_ENV_RE.match(k) and k or ''}={shlex.quote(str(v))}"
            for k, v in env_vars.items()
        )
        return f"{exports} && {command}"
