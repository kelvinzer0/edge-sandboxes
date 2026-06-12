# edge-sandboxes

**Edge-native universal sandbox router with automatic fallback.**

Deploy once to Cloudflare Workers or EdgeOne, manage all sandbox providers from one place.

## Why?

Most sandbox libraries are **provider-specific**. You need a different SDK for E2B, Daytona, Modal, etc. And if one provider goes down, you're stuck.

**edge-sandboxes** solves this:

1. **One edge worker** — deploy to Cloudflare or EdgeOne
2. **All providers** — E2B, Daytona, Modal, Cloudflare, EdgeOne in one place
3. **Automatic fallback** — if E2B fails, try Daytona, then Modal...
4. **Circuit breakers** — unhealthy providers are temporarily skipped

## Supported Providers

| Provider | Env Var(s) | Status |
|----------|------------|--------|
| E2B | `E2B_API_KEY` | ✅ |
| Daytona | `DAYTONA_API_KEY` | ✅ |
| Modal | `MODAL_TOKEN_ID` | ✅ |
| Cloudflare Sandbox | `CLOUDFLARE_SANDBOX_BASE_URL` + `CLOUDFLARE_API_TOKEN` | ✅ |
| EdgeOne | `EDGEONE_FUNCTION_URL` | ✅ |

## Architecture

```
┌─────────────────────────────────────────────────────┐
│               Your Application                      │
│                                                     │
│   curl / fetch / any HTTP client                    │
└──────────────────────┬──────────────────────────────┘
                       │ HTTP
                       ▼
┌─────────────────────────────────────────────────────┐
│            Edge Worker (CF / EdgeOne)               │
│                                                     │
│  ┌─────────┐  ┌─────────┐  ┌─────────┐             │
│  │ Circuit │  │ Fallback│  │ Health  │             │
│  │ Breaker │  │  Chain  │  │  Check  │             │
│  └────┬────┘  └────┬────┘  └────┬────┘             │
│       └────────────┼────────────┘                   │
│                    ▼                                │
│  ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐       │
│  │  E2B   │ │Daytona │ │ Modal  │ │CloudFl │       │
│  └────────┘ └────────┘ └────────┘ └────────┘       │
└─────────────────────────────────────────────────────┘
```

## Quick Start

### Cloudflare Workers

```bash
cd edge-worker

# Set secrets
npx wrangler secret put API_TOKEN
npx wrangler secret put E2B_API_KEY
npx wrangler secret put DAYTONA_API_KEY

# Deploy
npx wrangler deploy
```

### EdgeOne

```bash
# 1. Create a Pages project on EdgeOne console
#    → https://console.cloud.tencent.com/edgeone/pages

# 2. Copy edge-worker/src/core.ts + edge-worker/src/edgeone.ts to:
#    /edge-functions/api/sandbox/[[default]].js

# 3. Set env vars in EdgeOne dashboard

# 4. Deploy via EdgeOne CLI or dashboard
```

## API

### Create Sandbox

```bash
curl -X POST https://your-worker.workers.dev/api/sandbox/create \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "provider": "e2b",
    "fallback": ["daytona", "modal"],
    "image": "python:3.12-slim",
    "labels": {"project": "ml-training"},
    "env_vars": {"API_KEY": "xxx"},
    "timeout": 300
  }'
```

Response:
```json
{
  "id": "sbx-abc123",
  "provider": "e2b",
  "state": "running",
  "_provider": "e2b"
}
```

### Execute Command

```bash
curl -X POST https://your-worker.workers.dev/api/sandbox/sbx-abc123/exec \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "command": "python train.py",
    "provider": "e2b",
    "timeout": 60
  }'
```

Response:
```json
{
  "exit_code": 0,
  "stdout": "Training complete!",
  "stderr": "",
  "duration_ms": 1234
}
```

### Destroy Sandbox

```bash
curl -X DELETE "https://your-worker.workers.dev/api/sandbox/sbx-abc123?provider=e2b" \
  -H "Authorization: Bearer $TOKEN"
```

### Health Check

```bash
curl https://your-worker.workers.dev/api/health
```

Response:
```json
{
  "status": "ok",
  "providers": [
    {"name": "e2b", "healthy": true, "circuit_state": "closed", "failure_count": 0},
    {"name": "daytona", "healthy": true, "circuit_state": "closed", "failure_count": 0}
  ]
}
```

## Fallback Chains

If a provider fails, the next one in the chain is tried automatically:

```json
{
  "provider": "e2b",
  "fallback": ["daytona", "modal", "cloudflare"]
}
```

Circuit breakers track provider health. If a provider fails 5 times, it's marked unhealthy for 60 seconds before retrying.

## Multi-Account Round-Robin

Use multiple API keys per provider. Set comma-separated values:

```bash
# In wrangler.toml or EdgeOne dashboard
E2B_API_KEY=key1,key2,key3
DAYTONA_API_KEY=daytona-key-1,daytona-key-2
```

The worker automatically distributes requests across accounts using round-robin.

## JavaScript/TypeScript Client

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

## Features

| Feature | Status |
|---------|--------|
| Cloudflare Workers | ✅ |
| EdgeOne | ✅ |
| E2B provider | ✅ |
| Daytona provider | ✅ |
| Modal provider | ✅ |
| Cloudflare Sandbox provider | ✅ |
| EdgeOne provider | ✅ |
| Fallback chains | ✅ |
| Circuit breakers | ✅ |
| Multi-account round-robin | ✅ |
| Health-aware routing | ✅ |

## License

MIT
