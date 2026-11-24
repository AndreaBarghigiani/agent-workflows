---
name: tailscale-web-dev
distribution: reference-only
description: Expose a local web application to another tailnet device through a stable private Tailscale Serve route without changing its dev command. Use when testing from a second device over Tailscale; not for public exposure or Funnel.
---

# Serve a web project over Tailscale

Goal: a browser on a second tailnet device reaches `https://<magicdns-host>/<project>` and the request lands on the dev machine's local server. Report the exact browser URL, local port, Serve mapping, and OAuth redirect URI when relevant.

## Inspect before changing anything

- Read the project's `package.json`, scripts, and framework dev configuration. Preserve the existing dev command and package manager; detect npm, pnpm, yarn, or bun from the lockfile.
- Prefer a fixed, project-specific local port over a random one, and record it in the consumer's own documentation.
- Confirm Tailscale is installed and connected (`tailscale status`) and list existing Serve routes (`tailscale serve status`) before adding one. Never clobber an existing route.

## Keep the backend on localhost

- Bind the dev server to `127.0.0.1` when the framework supports it; use `0.0.0.0` only when the framework requires it.
- If HMR or WebSockets break through the proxy, configure the framework's HMR/client host for the external hostname while keeping the backend local.

## Choose a stable route

- Prefer one path per project on HTTPS 443 (for example `/my-project`) so OAuth callback URLs stay stable instead of carrying dev ports.
- Use a distinct HTTPS port only when a path prefix is unsuitable, and document the choice in the consumer's own documentation.
- Use the MagicDNS hostname from `tailscale status`, not the Tailscale IP.
- Never use Funnel or public exposure unless the user explicitly asks.

## Configure Serve without owning the dev process

`tailscaled` acts as the proxy; `tailscale serve --bg` configures the route and returns immediately. Adapt the examples to the framework and package manager:

```json
{
  "scripts": {
    "dev:serve": "tailscale serve --yes --bg --https=443 --set-path=/my-project localhost:3000",
    "dev": "npm run dev:serve && vite --host 127.0.0.1 --port 3000"
  }
}
```

The consumer owns its script names and dev command; a package script that blindly replaces the existing dev command is wrong. A `predev` hook is also suitable.

Serve configuration persists after the dev process exits. Never run `tailscale serve reset` automatically. On requested cleanup, inspect the current config and remove only the route this workflow added.

## Verify end to end

- The local URL responds.
- `tailscale serve status` shows the expected path and target.
- The external URL is actually opened from the second device — configuration alone is not evidence of access.
- Exercise HMR/WebSocket refresh if the project uses them.
- For OAuth flows, report the exact HTTPS callback URL; providers require an exact match.

## Boundaries

- Serve is tailnet-private. Never substitute Funnel without explicit authorization.
- Do not install packages, change firewall rules, or alter Tailscale ACLs unless needed and authorized.
- Never claim the remote URL works until the route and local service are both verified.
