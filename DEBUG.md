# Printer Proxy — Debug Context for AI Assistant

## What this project is

A Node.js/TypeScript authentication reverse proxy deployed on a k3s Kubernetes cluster.
It sits in front of a 3D printer web UI (Mainsail + Moonraker + Klipper) running on a
local machine at `192.168.1.177`.

The goal: expose the printer UI securely over the internet via Cloudflare Tunnel,
protected by a login page, without touching the printer's own configuration.

---

## Full traffic path

```
User browser (HTTPS)
  └─→ Cloudflare Tunnel (thesis-i.com)
        └─→ k3s Traefik Ingress  [192.168.1.10-12]
              └─→ Kubernetes Service: printer-proxy (ClusterIP, port 80)
                    └─→ Pod: printer-proxy (Node.js, port 3000)
                          ├─→ HTTP traffic  → http://192.168.1.177:4409  (Mainsail UI + REST)
                          └─→ WebSocket     → ws://192.168.1.177:7125   (Moonraker JSON-RPC)
```

---

## Printer-side services (192.168.1.177)

| Port | Service | Notes |
|------|---------|-------|
| 4409 | Mainsail UI (Nginx) | Serves static files; also proxies REST API paths to Moonraker locally |
| 7125 | Moonraker | JSON-RPC API + WebSocket at `/websocket` |

Accessing `http://192.168.1.177:4409` directly on the LAN works perfectly — full UI,
live printer data, no issues.

---

## Kubernetes cluster

| Node | IP | Role |
|------|----|------|
| mac-master | 192.168.1.10 | control-plane |
| mac-node1  | 192.168.1.11 | worker |
| mac-node2  | 192.168.1.12 | worker |

- k3s v1.35.x, Traefik as ingress controller
- Argo CD for GitOps — watches `github.com/NULP-AI-Enterprise/prinerproxynulp`, path `k8s/`
- Image: `ghcr.io/nulp-ai-enterprise/printer-proxy` (private, pull secret configured)
- Namespace: `printer-proxy`

---

## Current pod logs (latest working build)

```
[printer-proxy] auth username : "admin"
[printer-proxy] http target   : http://192.168.1.177:4409
[printer-proxy] ws target     : http://192.168.1.177:7125
[printer-proxy] trust proxy   : true
[printer-proxy] listening on port 3000
[printer-proxy] login OK  — user="admin" ip=10.42.0.1
[ws] upgrade → http://192.168.1.177:7125/websocket
[ws] upgrade → http://192.168.1.177:7125/websocket
[ws] upgrade → http://192.168.1.177:7125/websocket
```

---

## Browser console errors

```
Cannot connect to Moonraker (printer.thesis-i.com:443)

manifest.webmanifest:1 Manifest: Line: 1, column: 1, Syntax error.

WebSocket connection to 'wss://printer.thesis-i.com/websocket' failed:
WebSocket connection to 'wss://printer.thesis-i.com/websocket' failed:
WebSocket connection to 'wss://printer.thesis-i.com/websocket' failed:
```

The WebSocket upgrade IS received by the proxy (logged). The proxy forwards it to
`ws://192.168.1.177:7125/websocket`. But the browser reports the connection as failed.

---

## What works

- [x] Login page loads and authentication works
- [x] Session persists after login
- [x] Mainsail static UI loads (HTML, CSS, JS assets served from port 4409)
- [x] Argo CD auto-deploys on every git push
- [x] GitHub Actions builds and pushes Docker image to GHCR on every src/ change
- [x] SealedSecret for credentials (safe to commit to Git)

---

## What does NOT work

- [ ] WebSocket connection `wss://printer.thesis-i.com/websocket` → Moonraker
- [ ] As a result: Mainsail shows "Cannot connect to Moonraker" and printer is "offline"
- [ ] `manifest.webmanifest` returns invalid content (possibly a proxy content-type issue)

---

## What has been tried

### Attempt 1 — Route everything to port 4409
All HTTP and WebSocket → `192.168.1.177:4409`.
Result: WebSocket still fails. Port 4409 Nginx may not survive double WebSocket proxying
(proxy → Nginx → Moonraker).

### Attempt 2 — Split routing: HTTP → 4409, WebSocket → 7125
HTTP traffic → `192.168.1.177:4409`
WebSocket `/websocket` → `192.168.1.177:7125`
Result: Same browser error. No error logged from the proxy side (error handler bug —
it checked `instanceof http.ServerResponse` for the socket parameter, so WS errors
were swallowed silently).

### Current state (latest commit)
Same split routing as Attempt 2, but with a **fixed error handler** that:
- Properly detects `net.Socket` vs `http.ServerResponse`
- Logs the error **code** (e.g. `ECONNREFUSED`, `ETIMEDOUT`) for WebSocket failures
- Destroys the socket on error instead of leaving it hanging

After this build deploys, the pod logs should show the **actual error code** when
the WebSocket to port 7125 fails, which will tell us exactly what is wrong.

---

## Key question to debug

**Why does `ws://192.168.1.177:7125/websocket` fail when proxied from a k3s pod?**

Possible causes:
1. **Port 7125 is firewalled** on the printer — only accepts connections from
   `localhost` or LAN hosts, not from pod subnet `10.42.x.x`.
   → Fix: configure Moonraker to bind to `0.0.0.0`, or add a firewall rule.

2. **Traefik is not forwarding the `Upgrade` header correctly** to the proxy pod.
   → Unlikely: `[ws] upgrade: /websocket` IS logged by the proxy, so Traefik
   is delivering the upgrade request.

3. **http-proxy (`node-http-proxy`) is mishandling the WebSocket upgrade**
   to the upstream.
   → Unlikely: same library works fine in many similar setups.

4. **Cloudflare Tunnel drops or times out WebSocket connections**.
   → Possible: some Cloudflare plans/configs require WebSocket to be explicitly
   enabled. The user does not see a WebSocket toggle in Cloudflare dashboard.

---

## Relevant source files

- `src/server.ts` — main proxy server (auth + HTTP proxy + WS upgrade handler)
- `k8s/deployment.yaml` — env vars, image, resource limits
- `k8s/ingress.yaml` — Traefik ingress, host: printer.thesis-i.com
- `k8s/sealed-secret.yaml` — encrypted credentials (Bitnami Sealed Secrets)
- `.github/workflows/docker-build.yml` — CI: build image → push GHCR → pin SHA in deployment.yaml

---

## Next diagnostic step

Wait for latest build to deploy, then run:
```bash
kubectl logs -n printer-proxy $(kubectl get pod -n printer-proxy -o name) -f
```

The new error handler will print the exact error code, e.g.:
```
[ws error] /websocket — ECONNREFUSED   ← port 7125 not reachable from pod
[ws error] /websocket — ETIMEDOUT      ← firewall dropping packets silently
[ws error] /websocket — ECONNRESET     ← connection accepted then closed
```

That error code determines the fix.
