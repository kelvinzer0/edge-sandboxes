"""Hopx provider — cloud sandboxes."""

from __future__ import annotations

import os
from typing import Any

from ..core import ExecutionResult, SandboxConfig, SandboxInstance, SandboxProvider, SandboxState
from ..exceptions import ProviderError


class HopxProvider(SandboxProvider):
    def __init__(self, api_key: str | None = None, **kwargs: Any):
        super().__init__(**kwargs)
        self._api_key = api_key or os.getenv("HOPX_API_KEY", "")
        if not self._api_key:
            raise ProviderError("HOPX_API_KEY required")

    @property
    def name(self) -> str:
        return "hopx"

    async def create_sandbox(self, config: SandboxConfig) -> SandboxInstance:
        raise ProviderError("Hopx provider: not yet implemented")

    async def get_sandbox(self, sandbox_id: str) -> SandboxInstance | None:
        return None

    async def list_sandboxes(self, labels=None) -> list[SandboxInstance]:
        return []

    async def execute_command(self, sandbox_id, command, timeout=None, env_vars=None) -> ExecutionResult:
        raise ProviderError("Not implemented")

    async def destroy_sandbox(self, sandbox_id) -> bool:
        return False
