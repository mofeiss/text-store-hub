# CF-WORKER-TEXT2KV

A text file management and distribution system built on Cloudflare Workers + KV. Manage text files through a web admin panel and share them via public URLs — ideal for syncing config files, subscription lists, or any text content across devices.

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

- **Runtime**: Cloudflare Workers
- **Storage**: Cloudflare KV
- **Auth**: Custom login page + SHA-256 cookie token
- **Frontend**: Single-file inline HTML/CSS/JS, CDN dependencies (Lucide Icons, Ace Editor, js-yaml, Google Fonts)

## Deploy

### 1. Prerequisites

- [Node.js](https://nodejs.org/) >= 18
- [pnpm](https://pnpm.io/) (or npm/yarn)
- [Cloudflare account](https://dash.cloudflare.com/)

### 2. Clone and Install

```bash
git clone https://github.com/ofeiss/cf-worker-text2kv.git
cd cf-worker-text2kv
pnpm install
```

### 3. Create KV Namespace

```bash
npx wrangler kv:namespace create TEXT_STORE_KV
```

Copy the returned namespace ID.

### 4. Configure

Copy the example config and fill in your KV namespace ID:

```bash
cp wrangler.example.toml wrangler.toml
```

Edit `wrangler.toml` and replace `YOUR_KV_NAMESPACE_ID` with the actual ID.

### 5. Set Admin Password

```bash
npx wrangler secret put ADMIN_PASSWORD
```

Enter your password when prompted.

### 6. Deploy

```bash
npx wrangler deploy
```

### 7. Local Development

Create a `.dev.vars` file:

```
ADMIN_PASSWORD=your-password
```

Start the dev server:

```bash
pnpm dev
```

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
