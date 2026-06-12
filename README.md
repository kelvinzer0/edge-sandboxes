# edge-sandboxes

**Edge-native universal sandbox router with automatic fallback.**

Write once, run anywhere — from Cloudflare Workers to your laptop.

**edge-sandboxes** — edge-first universal sandbox router.

## Why?

Most Python sandbox libraries are **server-only**. They need a full Python runtime with asyncio. You can't use them from:

- Cloudflare Workers (V8 isolates, no Python)
- Edge functions
- Lightweight serverless where a full Python process is overkill

**edge-sandboxes** solves this with a dual architecture:

1. **Python library** — clean async API, zero required dependencies
2. **Edge Worker** — one unified TypeScript worker, deploy to Cloudflare or EdgeOne

Both share the same provider abstraction, circuit breaker pattern, and fallback chain logic.

## Supported Edge Platforms

| Platform | Runtime | Status |
|----------|---------|--------|
| **Cloudflare Workers** | V8 isolates | ✅ Ready |
| **Tencent EdgeOne** | Edge Functions (3200+ nodes) | ✅ Ready |
| **Deno Deploy** | V8 isolates | Planned |
| **Vercel Edge** | V8 isolates | Planned |

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                   Your Application                   │
│                                                     │
│   Python (any runtime)    │    JS/TS (any runtime)  │
│   ┌─────────────────┐    │    ┌──────────────────┐  │
│   │ edge-sandboxes  │    │    │ fetch() to edge  │  │
│   │ (pip package)   │    │    │ Worker endpoint  │  │
│   └────────┬────────┘    │    └────────┬─────────┘  │
└────────────┼─────────────┼─────────────┼────────────┘
             │             │             │
             ▼             ▼             ▼
┌─────────────────────────────────────────────────────┐
│       Edge Router (CF Worker / EdgeOne Function)    │
│                                                     │
│  ┌─────────┐  ┌─────────┐  ┌─────────┐             │
│  │ Circuit │  │ Fallback│  │ Health  │             │
│  │ Breaker │  │  Chain  │  │  Check  │             │
│  └────┬────┘  └────┬────┘  └────┬────┘             │
│       └────────────┼────────────┘                   │
│                    ▼                                │
│  ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐       │
│  │  E2B   │ │Daytona │ │ Modal  │ │ EdgeOne│       │
│  │(API)   │ │(API)   │ │(API)   │ │(Proxy) │       │
│  └────────┘ └────────┘ └────────┘ └────────┘       │
└─────────────────────────────────────────────────────┘
```

## Quick Start

### Python Library

```bash
pip install edge-sandboxes

# Install only the providers you need
pip install edge-sandboxes[e2b]
pip install edge-sandboxes[daytona]
pip install edge-sandboxes[all]
```

```python
import asyncio
from edge_sandboxes import EdgeSandbox

async def main():
    # Auto-detect provider from env vars
    async with EdgeSandbox.create() as sbx:
        result = await sbx.execute("python -c 'print(42)'")
        print(result.stdout)  # "42"

    # Explicit provider with fallback chain
    async with EdgeSandbox.create(
        provider="e2b",
        fallback=["daytona", "cloudflare"],
    ) as sbx:
        result = await sbx.execute("node -e 'console.log(1337)'")
        print(result.stdout)

    # One-shot convenience
    from edge_sandboxes import run
    result = await run("echo hello world")
    print(result.stdout)

asyncio.run(main())
```

### Edge Worker (Cloudflare / EdgeOne)

One unified worker, deploy to either platform:

```bash
cd edge-worker

# Cloudflare Workers
npx wrangler secret put API_TOKEN
npx wrangler secret put E2B_API_KEY
npx wrangler deploy

# EdgeOne — copy src/core.ts + src/edgeone.ts to your Pages project
# /edge-functions/api/sandbox/[[default]].js
# Set env vars in EdgeOne dashboard
```

```bash
# Create a sandbox
curl -X POST https://your-worker.workers.dev/api/sandbox/create \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "provider": "e2b",
    "fallback": ["daytona"],
    "image": "python:3.12-slim",
    "labels": {"project": "ml-training"}
  }'

# Execute a command
curl -X POST https://your-worker.workers.dev/api/sandbox/sbx-123/exec \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"command": "python train.py", "provider": "e2b"}'

# Check provider health
curl https://your-worker.workers.dev/api/health
```

### From JavaScript/TypeScript (via Cloudflare Worker)

```typescript
const API = "https://your-worker.workers.dev";
const TOKEN = "your-api-token";

// Create sandbox with fallback
const sbx = await fetch(`${API}/api/sandbox/create`, {
  method: "POST",
  headers: {
    "Authorization": `Bearer ${TOKEN}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    provider: "e2b",
    fallback: ["daytona"],
    image: "python:3.12-slim",
  }),
}).then(r => r.json());

console.log(`Sandbox ${sbx.id} created via ${sbx._provider}`);

// Execute
const result = await fetch(`${API}/api/sandbox/${sbx.id}/exec`, {
  method: "POST",
  headers: {
    "Authorization": `Bearer ${TOKEN}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    command: "python -c 'print(42)'",
    provider: sbx._provider,
  }),
}).then(r => r.json());

console.log(result.stdout); // "42"
```

## Provider Priority (Auto-detect)

When no provider is specified, the library auto-detects from environment variables:

| Priority | Provider | Env Var(s) |
|----------|----------|------------|
| 1 | Daytona | `DAYTONA_API_KEY` |
| 2 | E2B | `E2B_API_KEY` |
| 3 | Sprites | `SPRITES_TOKEN` |
| 4 | Hopx | `HOPX_API_KEY` |
| 5 | Modal | `MODAL_TOKEN_ID` |
| 6 | Cloudflare | `CLOUDFLARE_SANDBOX_BASE_URL` + `CLOUDFLARE_API_TOKEN` |
| 7 | EdgeOne | `EDGEONE_FUNCTION_URL` (+ optional `EDGEONE_API_TOKEN`) |

## Fallback Chains

The killer feature. If a provider fails, the next one in the chain is tried automatically:

```python
# Python
async with EdgeSandbox.create(
    provider="e2b",           # Try E2B first
    fallback=["daytona", "modal"],  # If E2B fails, try Daytona, then Modal
) as sbx:
    ...
```

```json
// Cloudflare Worker API
{
  "provider": "e2b",
  "fallback": ["daytona", "modal"],
  "image": "python:3.12"
}
```

Circuit breakers track provider health. If a provider fails 5 times, it's marked unhealthy for 60 seconds before retrying.

## Multi-Account Round-Robin

Use multiple API keys per provider with automatic round-robin distribution. Useful for bypassing rate limits and distributing load across accounts.

### Environment Variables (comma-separated)

```bash
export E2B_API_KEY="key-account-1,key-account-2,key-account-3"
export DAYTONA_API_KEY="daytona-key-1,daytona-key-2"
```

Auto-detected on first use — no code changes needed.

### Manual Configuration

```python
from edge_sandboxes import EdgeSandbox

# List of keys
EdgeSandbox.configure(
    e2b_api_key=["key-1", "key-2", "key-3"],
    default_provider="e2b",
)

# Or comma-separated string
EdgeSandbox.configure(
    e2b_api_key="key-1,key-2,key-3",
    default_provider="e2b",
)
```

### Direct Usage

```python
from edge_sandboxes import MultiAccountProvider
from edge_sandboxes.providers.e2b import E2BProvider

provider = MultiAccountProvider(
    provider_class=E2BProvider,
    accounts=[
        {"api_key": "key-1", "account_id": "team-a"},
        {"api_key": "key-2", "account_id": "team-b"},
        {"api_key": "key-3", "account_id": "team-c"},
    ],
)

# Round-robin: each create_sandbox call picks the next healthy account
instance = await provider.create_sandbox(config)  # → account-0
instance = await provider.create_sandbox(config)  # → account-1
instance = await provider.create_sandbox(config)  # → account-2
instance = await provider.create_sandbox(config)  # → account-0 (wraps)
```

Each account has its own circuit breaker — if one account hits rate limits, it's temporarily skipped while others continue.

## Features

| Feature | Status |
|---------|--------|
| Python library | ✅ |
| Edge/CF Worker | ✅ |
| Zero deps | ✅ (optional httpx) |
| Fallback chains | ✅ |
| Circuit breakers | ✅ |
| Health-aware routing | ✅ |
| Multi-account round-robin | ✅ |
| CLI | Planned |
| Connection pooling | Planned |

## License

MIT
