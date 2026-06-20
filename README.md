# FileSplit

Split, embed & distribute files. Upload any file to split it into chunks and generate a zero-dependency JS download embed. Also supports WebRTC P2P seeding directly from the browser.

## Quick Start

```bash
npm install          # or pnpm install / yarn install
cp .env.example .env

# Development (runs client + server concurrently)
npm run dev

# Production build + start
npm run build
NODE_ENV=production PORT=4000 npm start
```

The app runs at:
- **Dev client**: http://localhost:5173
- **Dev API / WS**: http://localhost:4000
- **Production**: everything on the PORT you set (static + API + WS all in one)

## Deploy on Render

1. Push this repo to GitHub.
2. Create a **Web Service** on [render.com](https://render.com) with:
   - **Build command**: `npm install && npm run build`
   - **Start command**: `NODE_ENV=production npm start`
   - **Environment variables**: `PORT=10000`, `NODE_ENV=production`
3. Done.

## Deploy on Railway / Fly.io

Same as Render — build command then start command.

## Deploy with Docker

```bash
docker build -t filesplit .
docker run -p 4000:4000 -e NODE_ENV=production filesplit
```

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | required | Port the server listens on |
| `NODE_ENV` | `development` | `production` serves the built React app |
| `UPLOAD_DIR` | `uploads` | Where uploaded chunks are stored |
| `MAX_FILE_SIZE_MB` | `500` | Max upload size |
| `CHUNK_SIZE_MB` | `1` | Size of each split chunk |

## Project Structure

```
client/          React + Vite frontend
server/          Express 5 API + WebSocket signaling
  src/
    lib/
      fileStore.ts   flat-file JSON metadata store
      signaling.ts   WebRTC WebSocket signaling
    routes/
      files/         upload, list, download, delete endpoints
      health.ts      /api/healthz
dist/            build output (gitignored)
uploads/         uploaded file chunks (gitignored)
```

## Features

- **File splitting** — uploaded files are split into 1 MB chunks stored on disk
- **JS embed snippet** — paste a `<script>` tag anywhere to add a reassembled download button
- **P2P seeding** — share files peer-to-peer via WebRTC without server storage
- **File expiry** — optional expiration on upload; expired files are auto-purged
- **Chunk API** — direct URL access to individual chunks
