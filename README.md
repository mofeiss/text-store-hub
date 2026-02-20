# <img src="screenshot/favicon.svg" width="28" height="28" /> TEXT-STORE-HUB

[中文文档](README_CN.md)

A text file management and distribution system with multiple independent deployment targets:

- **Cloudflare Workers + KV** (`cloudflare/` subdirectory)
- **Vercel Edge + Turso** (`vercel/` subdirectory)
- **Deno Deploy + Deno KV** (`deno/` subdirectory)
- **EdgeOne Pages + KV** (`edgeone/` subdirectory)

All versions expose the same UI and API behavior, but they are intentionally isolated in code and storage.

## Screenshots

### Desktop

![Desktop](screenshot/desktop.png)

### Mobile

<p float="left">
  <img src="screenshot/mobile-1.png" width="280" />
  <img src="screenshot/mobile-2.png" width="280" />
</p>

## Features

- **Web Admin Panel** — File CRUD with [Ace Editor](https://ace.c9.io/) (syntax highlighting, line numbers, code folding)
- **Public File Access** — Share files via `https://your-domain.com/f/{filename}`, always returns the latest content
- **Responsive Design** — Desktop dual-pane layout + mobile dual-view switching
- **Dark / Light Theme** — Persisted in localStorage
- **JSON / YAML Formatter** — One-click formatting in the editor
- **Import / Export** — Bulk backup and restore as JSON (Base64-encoded content)
- **Search** — Real-time file list filtering by title or filename
- **Dirty Tracking** — Unsaved change indicators, confirm prompts on navigation
- **Keyboard Shortcut** — `Ctrl/Cmd+S` to save

## Tech Stack

### Cloudflare Version (`cloudflare/`)

- **Runtime**: Cloudflare Workers
- **Storage**: Cloudflare KV
- **Auth**: Custom login page + SHA-256 cookie token

### Vercel Version (`vercel/`)

- **Runtime**: Vercel Edge Runtime
- **Storage**: Turso (libSQL / SQLite)
- **Auth**: Same custom login page + SHA-256 cookie token

### Deno Version (`deno/`)

- **Runtime**: Deno
- **Storage**: Deno KV
- **Auth**: Same custom login page + SHA-256 cookie token

### EdgeOne Version (`edgeone/`)

- **Runtime**: EdgeOne Pages Functions
- **Storage**: EdgeOne KV
- **Auth**: Same custom login page + SHA-256 cookie token

## Deploy Options

## Option A: Cloudflare Workers (`cloudflare/`)

### 1. Prerequisites

- [Node.js](https://nodejs.org/) >= 18
- [pnpm](https://pnpm.io/) (or npm/yarn)
- [Cloudflare account](https://dash.cloudflare.com/)

### 2. Clone and Install

```bash
git clone https://github.com/ofeiss/text-store-hub.git
cd text-store-hub/cloudflare
pnpm install
```

### 3. Create KV Namespace

```bash
npx wrangler kv:namespace create TEXT_STORE_KV
```

Copy the returned namespace ID.

### 4. Configure Wrangler

```bash
cp wrangler.example.toml wrangler.toml
```

Edit `wrangler.toml` and replace `YOUR_KV_NAMESPACE_ID` with the actual ID.

### 5. Set Admin Password

```bash
npx wrangler secret put ADMIN_PASSWORD
```

### 6. Deploy

```bash
npx wrangler deploy
```

### 7. Local Development

Create `.dev.vars` inside `cloudflare/`:

```env
ADMIN_PASSWORD=your-password
```

Then run:

```bash
pnpm dev
```

## Option B: Vercel Edge + Turso (`vercel/`)

### 1. Prerequisites

- [Node.js](https://nodejs.org/) >= 18
- [pnpm](https://pnpm.io/)
- [Vercel account](https://vercel.com/)
- [Turso database](https://turso.tech/)

### 2. Install Subproject Dependencies

```bash
cd vercel
pnpm install
```

### 3. Configure Environment Variables

Create local env file for development:

```bash
cp .env.example .env.local
```

Required vars:

- `ADMIN_PASSWORD`
- `TURSO_DATABASE_URL`
- `TURSO_AUTH_TOKEN`

### 4. Local Development

```bash
cd vercel
pnpm dev:vercel
```

### 5. Deploy

When importing this repository in Vercel:

- Set **Root Directory** to `vercel`
- Configure the three env vars above
- Bind a **custom domain** (mainland China IPs may not be able to access Vercel default domains reliably)

Then deploy:

```bash
cd vercel
pnpm deploy:prod
```

## Option C: Deno Deploy (`deno/`)

### 1. Prerequisites

- [Deno](https://deno.com/)
- [Deno Deploy account](https://dash.deno.com/)

### 2. Cloud Deployment

Connect your GitHub repository from the **Deno Deploy** dashboard:

1. Create a new Project and link this repository.
2. Set the Entry File to: `deno/main.js`
3. Add the environment variable: `ADMIN_PASSWORD`
4. Click Deploy.
5. **Important:** The initial deployment might fail due to a missing KV database. Go to the project's **Settings -> KV** page, manually create a new KV database, and link it to your project. The project will automatically redeploy and work properly once linked.

### 3. Local Development

```bash
cd deno
deno task dev
```

## Option D: EdgeOne Pages (`edgeone/`)

### 1. Prerequisites

- [Tencent EdgeOne account](https://console.cloud.tencent.com/edgeone)
- GitHub repository (EdgeOne Pages deploys from Git)

### 2. Create KV Namespace

In the [EdgeOne Pages console](https://console.cloud.tencent.com/edgeone), go to **KV Storage** and create a new namespace. Note down the namespace ID.

### 3. Configure edgeone.json (local development only)

`edgeone.json` is gitignored and never committed. For local development, copy the template and fill in the actual ID:

```bash
cp edgeone/edgeone.example.json edgeone/edgeone.json
```

Edit `edgeone/edgeone.json` and replace `YOUR_KV_NAMESPACE_ID` with the actual namespace ID.

### 4. Deploy to EdgeOne Pages

Configure the KV binding in the dashboard — no need to commit a file containing the namespace ID:

1. Create a new Pages project and link this repository
2. Set **Root Directory** to `edgeone`
3. In the project **KV Bindings** settings, bind your namespace to the variable name `TEXT_STORE_KV`
4. Add environment variable `ADMIN_PASSWORD` (your admin password)
5. Click Deploy

### 5. Verify

After deployment, visit the assigned domain. You should see the login page. Enter your password to access the admin panel.

## Data & Migration

- Cloudflare and Vercel deployments are **independent**.
- No automatic cross-platform sync is provided.
- Use built-in `Export` / `Import` APIs for manual migration.

## URL Routes

| Path | Method | Description | Auth |
|------|--------|-------------|------|
| `/` | GET | Admin panel (or login page) | Yes |
| `/f/{filename}` | GET | Public file access (plain text) | No |
| `/api/files` | GET | List files | Yes |
| `/api/files` | POST | Create file | Yes |
| `/api/files/{id}` | GET | Get file detail | Yes |
| `/api/files/{id}` | PUT | Update file | Yes |
| `/api/files/{id}` | DELETE | Delete file | Yes |
| `/api/export` | GET | Export all data as JSON | Yes |
| `/api/import` | POST | Bulk import JSON data | Yes |
| `/api/login` | POST | Login | No |
| `/api/logout` | POST | Logout | No |

## License

MIT
