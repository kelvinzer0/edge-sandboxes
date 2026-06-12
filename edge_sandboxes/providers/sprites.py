"""Sprites provider — Fly.io persistent sandboxes."""

from __future__ import annotations

import logging
import os
from typing import Any

from ..core import ExecutionResult, SandboxConfig, SandboxInstance, SandboxProvider, SandboxState
from ..exceptions import ProviderError

logger = logging.getLogger(__name__)


class SpritesProvider(SandboxProvider):
    def __init__(self, token: str | None = None, **kwargs: Any):
        super().__init__(**kwargs)
        self._token = token or os.getenv("SPRITES_TOKEN", "")

    @property
    def name(self) -> str:
        return "sprites"

    async def create_sandbox(self, config: SandboxConfig) -> SandboxInstance:
        # Sprites uses CLI (`sprite`) or HTTP API
        raise ProviderError("Sprites provider: install sprite CLI or set SPRITES_TOKEN")

    async def get_sandbox(self, sandbox_id: str) -> SandboxInstance | None:
        return None

    async def list_sandboxes(self, labels=None) -> list[SandboxInstance]:
        return []

    async def execute_command(self, sandbox_id, command, timeout=None, env_vars=None) -> ExecutionResult:
        raise ProviderError("Not implemented")

    async def destroy_sandbox(self, sandbox_id) -> bool:
        return False
