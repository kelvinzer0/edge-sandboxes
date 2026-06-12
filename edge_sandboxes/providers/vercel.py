"""Vercel provider — Firecracker microVM edge sandboxes."""

from __future__ import annotations

import os
from typing import Any

from ..core import ExecutionResult, SandboxConfig, SandboxInstance, SandboxProvider, SandboxState
from ..exceptions import ProviderError


class VercelProvider(SandboxProvider):
    def __init__(self, token: str | None = None, project_id: str | None = None, team_id: str | None = None, **kwargs: Any):
        super().__init__(**kwargs)
        self._token = token or os.getenv("VERCEL_TOKEN", "")
        self._project_id = project_id or os.getenv("VERCEL_PROJECT_ID", "")
        self._team_id = team_id or os.getenv("VERCEL_TEAM_ID", "")
        if not all([self._token, self._project_id, self._team_id]):
            raise ProviderError("VERCEL_TOKEN, VERCEL_PROJECT_ID, VERCEL_TEAM_ID required")

    @property
    def name(self) -> str:
        return "vercel"

    async def create_sandbox(self, config: SandboxConfig) -> SandboxInstance:
        raise ProviderError("Vercel provider: not yet implemented")

    async def get_sandbox(self, sandbox_id: str) -> SandboxInstance | None:
        return None

    async def list_sandboxes(self, labels=None) -> list[SandboxInstance]:
        return []

    async def execute_command(self, sandbox_id, command, timeout=None, env_vars=None) -> ExecutionResult:
        raise ProviderError("Not implemented")

    async def destroy_sandbox(self, sandbox_id) -> bool:
        return False
