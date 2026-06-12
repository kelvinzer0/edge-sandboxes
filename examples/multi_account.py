"""Example: Multi-account round-robin with multiple API keys per provider."""

import asyncio
from edge_sandboxes import EdgeSandbox, MultiAccountProvider
from edge_sandboxes.providers.e2b import E2BProvider


class MockProvider:
    """Fake provider for demonstration — no SDK needed."""

    def __init__(self, api_key=None, account_id=None):
        self.api_key = api_key
        self.account_id = account_id

    @property
    def name(self):
        return "mock"

    async def health_check(self):
        return True


async def multi_account_env_example():
    """Auto-detect from comma-separated env var.

    Set: E2B_API_KEY=key1,key2,key3
    """
    print("=== Multi-Account (Env) ===")

    async with EdgeSandbox.create(provider="e2b") as sbx:
        print(f"Sandbox {sbx.id} created via {sbx._provider_name}")
        result = await sbx.execute("echo 'Hello from multi-account!'")
        print(result.stdout.strip())


async def multi_account_manual_example():
    """Manually configure multiple accounts."""
    print("=== Multi-Account (Manual) ===")

    EdgeSandbox.configure(
        e2b_api_key=["key-account-1", "key-account-2", "key-account-3"],
        default_provider="e2b",
    )

    async with EdgeSandbox.create() as sbx:
        result = await sbx.execute("echo manual multi-account!")
        print(result.stdout.strip())


async def multi_account_direct_example():
    """Direct MultiAccountProvider usage."""
    print("=== Multi-Account (Direct) ===")

    provider = MultiAccountProvider(
        provider_class=MockProvider,
        accounts=[
            {"api_key": "key-1", "account_id": "team-a"},
            {"api_key": "key-2", "account_id": "team-b"},
            {"api_key": "key-3", "account_id": "team-c"},
        ],
        name_override="mock",
    )
    print(f"Provider '{provider.name}' has {provider.account_count} accounts")


async def multi_account_from_env_example():
    """Create from comma-separated env var directly."""
    print("=== Multi-Account (from_env) ===")

    import os
    os.environ["MOCK_API_KEY"] = "key-1,key-2,key-3"

    provider = MultiAccountProvider.from_env(
        provider_class=MockProvider,
        env_var="MOCK_API_KEY",
        param_name="api_key",
        name_override="mock",
    )
    print(f"Provider '{provider.name}' loaded {provider.account_count} accounts from env")

    del os.environ["MOCK_API_KEY"]


async def main():
    await multi_account_direct_example()
    await multi_account_from_env_example()
    # Uncomment to run with real API keys:
    # await multi_account_env_example()
    # await multi_account_manual_example()


if __name__ == "__main__":
    asyncio.run(main())
