"""Example: Multi-provider sandbox with automatic fallback."""

import asyncio
from edge_sandboxes import EdgeSandbox, run


async def basic_example():
    """Simplest usage — auto-detect provider."""
    print("=== Basic Example ===")

    # One-shot execution
    result = await run("echo 'Hello from sandbox!'")
    print(f"Output: {result.stdout.strip()}")
    print(f"Exit code: {result.exit_code}")


async def fallback_example():
    """Provider with fallback chain."""
    print("\n=== Fallback Example ===")

    async with EdgeSandbox.create(
        provider="e2b",
        fallback=["daytona", "cloudflare"],
        labels={"project": "demo", "env": "test"},
    ) as sbx:
        print(f"Sandbox {sbx.id} created via {sbx._provider_name}")

        # Execute commands
        r1 = await sbx.execute("python3 --version")
        print(f"Python: {r1.stdout.strip()}")

        r2 = await sbx.execute("node --version")
        print(f"Node: {r2.stdout.strip()}")

        # Multi-command
        results = await sbx.execute_many([
            "pip install requests -q",
            "python3 -c 'import requests; print(requests.__version__)'",
        ])
        print(f"Requests version: {results[-1].stdout.strip()}")


async def labels_example():
    """Find and reuse sandboxes by labels."""
    print("\n=== Labels Example ===")

    # Create with labels
    sbx1 = await EdgeSandbox.create(
        labels={"session": "my-session", "user": "alice"},
    )
    print(f"Created sandbox: {sbx1.id}")

    # Find by labels
    sbx2 = await EdgeSandbox.find({"session": "my-session"})
    if sbx2:
        print(f"Found existing: {sbx2.id}")
        assert sbx1.id == sbx2.id

    await sbx1.destroy()


async def config_example():
    """Manual provider configuration."""
    print("\n=== Config Example ===")

    EdgeSandbox.configure(
        e2b_api_key="your-key-here",
        default_provider="e2b",
    )

    async with EdgeSandbox.create() as sbx:
        result = await sbx.execute("echo configured!")
        print(result.stdout.strip())


async def main():
    await basic_example()
    # Uncomment to run with real API keys:
    # await fallback_example()
    # await labels_example()
    # await config_example()


if __name__ == "__main__":
    asyncio.run(main())
