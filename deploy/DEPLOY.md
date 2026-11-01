# Deploying to one server with Docker

This puts the whole product on a single Linux server: database, backend, simulated company systems,
voice engine, and the web app behind automatic HTTPS. Only ports 80 and 443 are open to the
internet; everything else talks over a private Docker network.

```
internet ──► web (Caddy: HTTPS, web app) ──► /api/*   backend ──► db (Postgres + pgvector)
                                         │                  └──► mock (simulated company systems)
                                         └─► /voice/*  voice ──► backend
```

> **Status of these files.** They were written and checked statically on a machine without Docker:
> the lockfile installs cleanly with `--frozen-lockfile` for every service, the backend accepts the
> exact environment the compose file gives it (and refuses the unsafe ones), and the web bundle
> embeds the production address. **The images have not been built, and the Caddyfiles have not been
> run through Caddy.** Expect to read a build log the first time, and see "If something fails" below.

## 1. What you need

| Need | Notes |
| --- | --- |
| A Linux server | Ubuntu 22.04 or 24.04. Estimate: **4 vCPUs, 8 GB RAM, 40 GB disk**. The speech models take about 2 GB of memory; less will make voice slow. |
| A domain name | Create an **A record** (for example `console.example.com`) pointing at the server's IP address. |
| Ports 80 and 443 open | Both are needed: port 80 is how the HTTPS certificate is issued. |
| An AI model key | Anthropic, or any OpenAI-compatible provider (OpenAI, Groq, OpenRouter, Ollama). |
| A sign-in provider (OIDC) | **Required for real use**, see section 3. Or use the private demo mode. |

## 2. Prepare the server (once)

```bash
# install Docker (official convenience script) and let your user run it
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER      # log out and back in afterwards

# firewall: SSH, HTTP, HTTPS only
sudo ufw allow OpenSSH && sudo ufw allow 80,443/tcp && sudo ufw allow 443/udp && sudo ufw enable
```

Copy the project to the server (`git clone`, or `rsync`/`scp` the folder). Do not copy your
development `.env`: it holds your own keys and is not used here.

## 3. Choose how people sign in

### A. Production: OpenID Connect (recommended)

The backend refuses to start in production without it, because the built-in development sign-in makes
every visitor an administrator.

1. Create a **public SPA** application at your provider (Auth0, Microsoft Entra ID, Keycloak, Okta, ...)
   using the Authorization Code flow with PKCE. Details: [docs/AUTHENTICATION.md](../docs/AUTHENTICATION.md).
2. Redirect URI: `https://<DOMAIN>/auth/callback`. Post-logout URI: `https://<DOMAIN>/`.
3. Make the access token carry the API audience, a `roles` claim (`administrator`,
   `support_operator`, ...) and a `tenant_ids` claim. The role names are in the document above.
4. You will put the issuer URL, audience and client id into `.env.production` in the next step.

### B. Private demo only

For showing the product to a few people with simulated data. Everyone who knows the password is an
administrator. In `.env.production` use the "private demo" block (development sign-in, `Caddyfile.demo`)
and create the password hash:

```bash
docker run --rm caddy:2-alpine caddy hash-password --plaintext 'a-long-password'
```

Put the result in `BASIC_AUTH_HASH`, with every `$` written as `$$`.

## 4. Configure and start

```bash
cd agent-delivery-kit
cp deploy/.env.production.example .env.production
nano .env.production        # fill every value marked CHANGE
# generate each secret with:  openssl rand -hex 32

docker compose --env-file .env.production -f docker-compose.prod.yml up -d --build
docker compose --env-file .env.production -f docker-compose.prod.yml ps
```

**The first start is slow** (10 to 20 minutes on a small server) because it builds four images, then:

- the voice engine downloads and checks about 460 MB of speech models (kept in a volume; later starts skip this),
- the backend downloads a small embedding model and indexes the policy documents (also kept in a volume).

Watch it with `docker compose --env-file .env.production -f docker-compose.prod.yml logs -f voice backend`.
The voice engine is ready when its health check turns green.

## 5. Check it works

```bash
curl -s https://<DOMAIN>/api/health                      # the backend's status
curl -s https://<DOMAIN>/voice/health                    # should contain "ready":true
```

Then open `https://<DOMAIN>`, sign in, open **Overview** (agents should show "Voice engine ready"),
and press **Start a voice session**. The browser asks for the microphone, which needs HTTPS: that is
one more reason not to serve it over plain HTTP.

## 6. Run it

| Task | Command (prefix: `docker compose --env-file .env.production -f docker-compose.prod.yml`) |
| --- | --- |
| Logs | `logs -f backend` (or `voice`, `web`, `db`) |
| Update to new code | `git pull`, then `up -d --build` |
| Stop / start | `stop` / `start` |
| Back up the database | `exec -T db pg_dump -U adk adk \| gzip > adk-$(date +%F).sql.gz` |
| Restore | `gunzip -c adk-DATE.sql.gz \| docker compose ... exec -T db psql -U adk adk` |
| Uploaded documents | live in the `adk_appdata` volume: back it up too (`docker run --rm -v adk_appdata:/d -v $PWD:/b alpine tar czf /b/appdata.tgz -C /d .`) |

Changing `DOMAIN`, `OIDC_ISSUER` or `VITE_OIDC_CLIENT_ID` needs `up -d --build`, because the web app
has them fixed into its files at build time.

## 7. Security checklist

- [ ] OIDC sign-in is on (section 3A), or the demo password is long and the data is only simulated.
- [ ] `.env.production` is not in git (it is ignored) and its permissions are `chmod 600`.
- [ ] Every `CHANGE` secret was replaced with a generated value.
- [ ] Only ports 22, 80 and 443 are open. The database, backend, voice engine and mock services have no published ports.
- [ ] Back-ups run on a schedule and a restore was tried once.
- [ ] The voice engine stores no audio or transcripts (`docs/VOICE.md`). Do not set `VOICE_DIAGNOSTICS=1` in production: it saves every turn's audio to disk.
- [ ] If real customers will use it: the company systems in this project are **simulations** (`mock` service). Real integrations must replace them before any real booking or billing data is involved.

## If something fails

| Symptom | Likely cause and fix |
| --- | --- |
| `docker compose` says a variable is missing | A `?set X in .env.production` message names it. Fill it in. |
| `backend` restarts, log says `Invalid environment` | The message lists the exact variable. Production needs `AUTH_MODE=oidc` with an `https://` issuer and an audience. |
| No certificate / browser warning | DNS does not point at the server yet, or ports 80/443 are blocked. `docker compose ... logs web` shows the certificate attempts. |
| Page loads, sign-in fails | The redirect URI at the provider must match `https://<DOMAIN>/auth/callback` exactly, and `OIDC_ISSUER` must equal the provider's issuer. |
| Voice says "not running" | `logs voice`. First start is still downloading models, or the machine is out of memory (`docker stats`). |
| Voice connects then drops | `VOICE_GATEWAY_SECRET` differs between services (it is one value, set once), or the page was opened at a different address than `DOMAIN`. |
| Build fails at `pnpm install --frozen-lockfile` | `pnpm-lock.yaml` is out of date with a `package.json`. Run `pnpm install` locally and commit the lockfile. |
| PDF upload says unavailable | The image was built with `WITH_PDF=false`, or the PDF reader failed to install. Rebuild with `WITH_PDF=true` and read the build log. |
