# qwerty-WS

WebSocket collaboration server for qwerty using Hocuspocus and Yjs.

## Setup

1. Install dependencies:

```bash
npm install
```

2. Copy `.env.example` to `.env` and configure:

```bash
cp .env.example .env
```

3. Make sure Redis is running:

```bash
redis-server
```

4. Generate Prisma client (from parent directory):

```bash
cd ..
npx prisma generate
```

## Development

Start the WebSocket server:

```bash
npm run dev
```

Start the snapshot worker:

```bash
npm run worker:dev
```

## Production

Build the project:

```bash
npm run build
```

Start the server:

```bash
npm start
```

Start the worker:

```bash
npm run worker
```

## Architecture

- **Hocuspocus Server**: WebSocket server for real-time collaboration
- **Redis**: Live persistence layer for Yjs documents
- **BullMQ**: Job queue for snapshot processing
- **Snapshot Worker**: Background worker that syncs Yjs docs to PostgreSQL

## Environment Variables

See `.env.example` for required configuration.
