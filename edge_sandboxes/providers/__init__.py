"""Provider registry — lazy imports to avoid pulling in heavy SDKs."""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from ..core import SandboxProvider

_PROVIDER_MAP: dict[str, str] = {
    "e2b": ".providers.e2b",
    "daytona": ".providers.daytona",
    "modal": ".providers.modal",
    "cloudflare": ".providers.cloudflare",
    "edgeone": ".providers.edgeone",
    "sprites": ".providers.sprites",
    "hopx": ".providers.hopx",
    "vercel": ".providers.vercel",
}


def get_provider_class(name: str) -> type[SandboxProvider] | None:
    """Lazy-import a provider class by name."""
    module_path = _PROVIDER_MAP.get(name)
    if not module_path:
        return None

    import importlib

    try:
        mod = importlib.import_module(module_path, package="edge_sandboxes")
        # Convention: each module exports `<Name>Provider`
        class_name = {
            "e2b": "E2BProvider",
            "daytona": "DaytonaProvider",
            "modal": "ModalProvider",
            "cloudflare": "CloudflareProvider",
            "edgeone": "EdgeOneProvider",
            "sprites": "SpritesProvider",
            "hopx": "HopxProvider",
            "vercel": "VercelProvider",
        }[name]
        return getattr(mod, class_name, None)
    except ImportError:
        return None


def list_available() -> list[str]:
    """List provider names that can be imported (SDK installed)."""
    available = []
    for name in _PROVIDER_MAP:
        if get_provider_class(name) is not None:
            available.append(name)
    return available
