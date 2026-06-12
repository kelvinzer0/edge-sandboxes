"""E2B provider — Firecracker microVM sandboxes."""

from __future__ import annotations

import asyncio
import logging
import os
import time
from collections.abc import AsyncIterator
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
    from e2b import AsyncSandbox as E2BSandbox

    _AVAILABLE = True
except ImportError:
    _AVAILABLE = False


class E2BProvider(SandboxProvider):
    """E2B sandbox provider using the official SDK."""

    def __init__(self, api_key: str | None = None, **config: Any):
        super().__init__(**config)
        if not _AVAILABLE:
            raise ProviderError("E2B SDK not installed — pip install e2b")
        self.api_key = api_key or os.getenv("E2B_API_KEY")
        if not self.api_key:
            raise ProviderError("E2B_API_KEY not set")
        self.default_template = config.get("template", "base")
        self.timeout = config.get("timeout", 60)
        self._sandboxes: dict[str, dict[str, Any]] = {}
        self._lock = asyncio.Lock()

    @property
    def name(self) -> str:
        return "e2b"

    async def create_sandbox(self, config: SandboxConfig) -> SandboxInstance:
        template = config.image or config.provider_config.get("template") or self.default_template
        timeout = config.timeout_seconds or self.timeout

        try:
            sbx = await E2BSandbox.create(
                template=template,
                envs=config.env_vars,
                api_key=self.api_key,
                timeout=timeout,
            )
        except RuntimeError as e:
            if "Event loop is closed" in str(e):
                self._reset_transport()
                sbx = await E2BSandbox.create(
                    template=template,
                    envs=config.env_vars,
                    api_key=self.api_key,
                    timeout=timeout,
                )
            raise

        meta = {
            "e2b_sandbox": sbx,
            "labels": config.labels or {},
            "created_at": datetime.now(timezone.utc),
            "last_accessed": time.time(),
        }
        async with self._lock:
            self._sandboxes[sbx.sandbox_id] = meta

        # Setup commands
        for cmd in config.setup_commands:
            await self.execute_command(sbx.sandbox_id, cmd)

        return SandboxInstance(
            id=sbx.sandbox_id,
            provider=self.name,
            state=SandboxState.RUNNING,
            labels=config.labels or {},
            created_at=meta["created_at"],
        )

    async def get_sandbox(self, sandbox_id: str) -> SandboxInstance | None:
        meta = self._sandboxes.get(sandbox_id)
        if meta:
            meta["last_accessed"] = time.time()
            return SandboxInstance(
                id=sandbox_id,
                provider=self.name,
                state=SandboxState.RUNNING,
                labels=meta.get("labels", {}),
                created_at=meta.get("created_at"),
            )
        return None

    async def list_sandboxes(self, labels: dict[str, str] | None = None) -> list[SandboxInstance]:
        results = []
        for sid, meta in self._sandboxes.items():
            if labels and not all(meta["labels"].get(k) == v for k, v in labels.items()):
                continue
            results.append(SandboxInstance(
                id=sid,
                provider=self.name,
                state=SandboxState.RUNNING,
                labels=meta["labels"],
                created_at=meta.get("created_at"),
            ))
        return results

    async def execute_command(
        self,
        sandbox_id: str,
        command: str,
        timeout: int | None = None,
        env_vars: dict[str, str] | None = None,
    ) -> ExecutionResult:
        meta = self._sandboxes.get(sandbox_id)
        if not meta:
            raise SandboxNotFoundError(f"Sandbox {sandbox_id} not found")

        sbx = meta["e2b_sandbox"]
        meta["last_accessed"] = time.time()
        effective_timeout = timeout or self.timeout
        start = time.time()

        try:
            result = await sbx.commands.run(command, envs=env_vars, timeout=effective_timeout)
            return ExecutionResult(
                exit_code=result.exit_code,
                stdout=result.stdout,
                stderr=result.stderr,
                duration_ms=int((time.time() - start) * 1000),
            )
        except Exception as e:
            if hasattr(e, "exit_code"):
                return ExecutionResult(
                    exit_code=e.exit_code,
                    stdout=getattr(e, "stdout", ""),
                    stderr=getattr(e, "stderr", str(e)),
                    duration_ms=int((time.time() - start) * 1000),
                )
            raise SandboxError(f"Execution failed: {e}") from e

    async def destroy_sandbox(self, sandbox_id: str) -> bool:
        meta = self._sandboxes.get(sandbox_id)
        if not meta:
            return False
        try:
            await meta["e2b_sandbox"].kill()
        except Exception as e:
            logger.warning(f"Kill failed for {sandbox_id}: {e}")
        async with self._lock:
            self._sandboxes.pop(sandbox_id, None)
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

    async def upload_file(self, sandbox_id: str, local_path: str, remote_path: str) -> bool:
        meta = self._sandboxes.get(sandbox_id)
        if not meta:
            raise SandboxNotFoundError(f"Sandbox {sandbox_id} not found")
        with open(local_path, "rb") as f:
            content = f.read()
        await meta["e2b_sandbox"].files.write(remote_path, content)
        return True

    async def download_file(self, sandbox_id: str, remote_path: str, local_path: str) -> bool:
        meta = self._sandboxes.get(sandbox_id)
        if not meta:
            raise SandboxNotFoundError(f"Sandbox {sandbox_id} not found")
        content = await meta["e2b_sandbox"].files.read(remote_path)
        with open(local_path, "wb") as f:
            f.write(content if isinstance(content, bytes) else content.encode())
        return True

    @staticmethod
    def _reset_transport() -> None:
        try:
            from e2b.api import client_async as c
            cls = getattr(c, "AsyncTransportWithLogger", None)
            if cls:
                cls.singleton = None
        except Exception:
            pass
