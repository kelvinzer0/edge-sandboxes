# edge-sandboxes

**Edge-native universal sandbox router with automatic fallback.**

Deploy once to Cloudflare Workers or EdgeOne, manage all sandbox providers from one place.

[![Deploy to Cloudflare](https:// deploy.workers.cloudflare.com/button.svg)](https://dash.cloudflare.com/?url=https://github.com/kelvinzer0/edge-sandboxes)

[![Deploy to EdgeOne](https://raw.githubusercontent.com/nicedoc/images/master/deploy-to-edgeone-button.svg)](https://console.cloud.tencent.com/edgeone/pages/new?gitRepo=https://github.com/kelvinzer0/edge-sandboxes)

## Why?

Most sandbox libraries are **provider-specific**. You need a different SDK for E2B, Daytona, etc. And if one provider goes down, you're stuck.

**edge-sandboxes** solves this:

1. **One edge worker** — deploy to Cloudflare or EdgeOne
2. **All providers** — E2B, Daytona, Cloudflare, EdgeOne in one place
3. **Automatic fallback** — if E2B fails, try Daytona, then Cloudflare...
4. **Circuit breakers** — unhealthy providers are temporarily skipped

## Supported Providers

| Provider | Type | Env Var | Docs |
|----------|------|---------|------|
| [E2B](https://e2b.dev/docs) | API Key | `E2B_API_KEY` | [API Reference](https://e2b.mintlify.app/docs/api-reference/sandboxes/create-sandbox) |
| [Daytona](https://daytona.io/docs) | API Key | `DAYTONA_API_KEY` | [API Reference](https://www.daytona.io/docs/en/tools/api) |
| [Cloudflare Sandbox](https://developers.cloudflare.com/sandbox/) | Worker URL | `CLOUDFLARE_WORKER_URL` | [Get Started](https://developers.cloudflare.com/sandbox/get-started/) |
| EdgeOne | Worker URL | `EDGEONE_WORKER_URL` | [Edge Functions](https://www.edgeone.com/document/detail/edgeone/pages) |

## Architecture

```
edge-worker/src/
├── types.ts              # All interfaces (Env, SandboxRequest, etc.)
├── circuit-breaker.ts    # Circuit breaker implementation
├── router.ts             # Fallback chain + provider routing
├── handlers.ts           # HTTP request handlers
├── providers/
│   ├── base.ts           # Abstract SandboxProvider
│   ├── e2b.ts            # E2B provider
│   ├── daytona.ts        # Daytona provider
│   ├── modal.ts          # Modal provider
│   ├── cloudflare.ts     # Cloudflare Sandbox provider
│   ├── edgeone.ts        # EdgeOne provider
│   └── index.ts          # Provider registry
├── core.ts               # Barrel export
├── cf.ts                 # Cloudflare Worker entry
└── edgeone.ts            # EdgeOne entry
```

**Adding a new provider:**
1. Create `src/providers/myprovider.ts`
2. Extend `SandboxProvider`
3. Register in `src/providers/index.ts`

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

```
edge-sandboxes/
├── edge-functions/           # EdgeOne auto-detects this
│   └── api/sandbox/[[default]].js
├── edge-worker/              # Source code (for reference)
└── README.md
```

```bash
# 1. Create Pages project on EdgeOne console
#    → https://console.cloud.tencent.com/edgeone/pages

# 2. Connect your GitHub repo

# 3. EdgeOne auto-detects edge-functions/api/sandbox/[[default]].js

# 4. Set env vars in EdgeOne dashboard:
#    E2B_API_KEY=your-key
#    DEFAULT_PROVIDER=e2b

# 5. Deploy automatically on push
```

## API

**Base URL:** `https://edge-sandboxes-dpl8r4b932li.edgeone.dev`

### Health Check

```bash
curl https://edge-sandboxes-dpl8r4b932li.edgeone.dev/api/sandbox/health
```

Response:
```json
{
  "status": "ok",
  "providers": [
    {"name": "e2b", "healthy": true, "circuit_state": "closed", "failure_count": 0, "accounts": 3}
  ]
}
```

### Create Sandbox

```bash
curl -X POST https://edge-sandboxes-dpl8r4b932li.edgeone.dev/api/sandbox/create \
  -H "Content-Type: application/json" \
  -d '{
    "provider": "e2b",
    "fallback": ["daytona", "cloudflare"],
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
  "provider": "e2b[0]",
  "state": "running",
  "_provider": "e2b"
}
```

### Execute Command

```bash
curl -X POST https://edge-sandboxes-dpl8r4b932li.edgeone.dev/api/sandbox/sbx-abc123/exec \
  -H "Content-Type: application/json" \
  -d '{
    "command": "python -c \"print(42)\"",
    "provider": "e2b",
    "timeout": 60
  }'
```

Response:
```json
{
  "exit_code": 0,
  "stdout": "42\n",
  "stderr": "",
  "duration_ms": 1234
}
```

### Destroy Sandbox

```bash
curl -X DELETE "https://edge-sandboxes-dpl8r4b932li.edgeone.dev/api/sandbox/sbx-abc123?provider=e2b"
```

Response:
```json
{"destroyed": true}
```

## Fallback Chains

If a provider fails, the next one in the chain is tried automatically:

```json
{
  "provider": "e2b",
  "fallback": ["daytona", "cloudflare"]
}
```

Circuit breakers track provider health. If a provider fails 5 times, it's marked unhealthy for 60 seconds before retrying.

## Multi-Account Round-Robin

Use multiple API keys per provider. Set comma-separated values:

```bash
# In EdgeOne dashboard or wrangler.toml
E2B_API_KEY=key1,key2,key3
DAYTONA_API_KEY=daytona-key-1,daytona-key-2
```

The worker automatically distributes requests across accounts using round-robin. Each account has its own circuit breaker.

## Usage Examples

### cURL

```bash
# 1. Health check
curl https://edge-sandboxes-dpl8r4b932li.edgeone.dev/api/sandbox/health

# 2. Create sandbox with fallback
curl -X POST https://edge-sandboxes-dpl8r4b932li.edgeone.dev/api/sandbox/create \
  -H "Content-Type: application/json" \
  -d '{"provider":"e2b","fallback":["daytona"],"image":"python:3.12"}'

# 3. Execute command
curl -X POST https://edge-sandboxes-dpl8r4b932li.edgeone.dev/api/sandbox/SANDBOX_ID/exec \
  -H "Content-Type: application/json" \
  -d '{"command":"echo hello","provider":"e2b"}'

# 4. Destroy sandbox
curl -X DELETE "https://edge-sandboxes-dpl8r4b932li.edgeone.dev/api/sandbox/SANDBOX_ID?provider=e2b"
```

### JavaScript/TypeScript

```typescript
const API = "https://edge-sandboxes-dpl8r4b932li.edgeone.dev";

// Create sandbox
const sbx = await fetch(`${API}/api/sandbox/create`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    provider: "e2b",
    fallback: ["daytona"],
    image: "python:3.12-slim",
  }),
}).then(r => r.json());

console.log(`Sandbox ${sbx.id} created via ${sbx._provider}`);

// Execute command
const result = await fetch(`${API}/api/sandbox/${sbx.id}/exec`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    command: "python -c 'print(42)'",
    provider: sbx._provider,
  }),
}).then(r => r.json());

console.log(result.stdout); // "42"

// Destroy
await fetch(`${API}/api/sandbox/${sbx.id}?provider=${sbx._provider}`, {
  method: "DELETE",
});
```

### Python

```python
import requests

API = "https://edge-sandboxes-dpl8r4b932li.edgeone.dev"

# Create sandbox
sbx = requests.post(f"{API}/api/sandbox/create", json={
    "provider": "e2b",
    "fallback": ["daytona"],
    "image": "python:3.12-slim",
}).json()

print(f"Sandbox {sbx['id']} created via {sbx['_provider']}")

# Execute command
result = requests.post(f"{API}/api/sandbox/{sbx['id']}/exec", json={
    "command": "python -c 'print(42)'",
    "provider": sbx["_provider"],
}).json()

print(result["stdout"])  # "42"

# Destroy sandbox
requests.delete(f"{API}/api/sandbox/{sbx['id']}?provider={sbx['_provider']}")
```

### Go

```go
package main

import (
    "bytes"
    "encoding/json"
    "fmt"
    "net/http"
)

const API = "https://edge-sandboxes-dpl8r4b932li.edgeone.dev"

func main() {
    // Create sandbox
    body, _ := json.Marshal(map[string]interface{}{
        "provider": "e2b",
        "fallback": []string{"daytona"},
        "image":    "python:3.12-slim",
    })
    resp, _ := http.Post(API+"/api/sandbox/create", "application/json", bytes.NewReader(body))

    var sbx map[string]interface{}
    json.NewDecoder(resp.Body).Decode(&sbx)
    fmt.Printf("Sandbox %s created\n", sbx["id"])

    // Execute command
    execBody, _ := json.Marshal(map[string]interface{}{
        "command":  "echo hello",
        "provider": sbx["_provider"],
    })
    execResp, _ := http.Post(
        API+"/api/sandbox/"+sbx["id"].(string)+"/exec",
        "application/json",
        bytes.NewReader(execBody),
    )

    var result map[string]interface{}
    json.NewDecoder(execResp.Body).Decode(&result)
    fmt.Println(result["stdout"])

    // Destroy
    req, _ := http.NewRequest("DELETE", API+"/api/sandbox/"+sbx["id"].(string)+"?provider="+sbx["_provider"].(string), nil)
    http.DefaultClient.Do(req)
}
```

## Features

| Feature | Status |
|---------|--------|
| Cloudflare Workers | ✅ |
| EdgeOne | ✅ |
| [E2B provider](https://e2b.dev/docs) | ✅ |
| [Daytona provider](https://daytona.io/docs) | ✅ |
| [Cloudflare Sandbox provider](https://developers.cloudflare.com/sandbox/) | ✅ |
| EdgeOne provider | ✅ |
| Fallback chains | ✅ |
| Circuit breakers | ✅ |
| Multi-account round-robin | ✅ |
| Health-aware routing | ✅ |

## License

MIT
