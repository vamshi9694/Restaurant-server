# Media Stream Server

Standalone WebSocket server that bridges Twilio Media Streams to the OpenAI Realtime API. No timeouts — each call runs in a single, persistent session for as long as needed.

## Setup

1. Copy this folder to its own repository
2. Install dependencies:
   ```bash
   npm install
   ```
3. Copy `.env.example` to `.env` and fill in your values:
   ```bash
   cp .env.example .env
   ```
4. Start the server:
   ```bash
   npm start
   ```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `PORT` | Server port (default: 8080) |
| `SUPABASE_URL` | Your Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role key |
| `OPENAI_API_KEY` | OpenAI API key |
| `TWILIO_PHONE_NUMBER` | Fallback Twilio phone number |

## Deploying to Railway

1. Push this folder to a GitHub repo
2. Connect the repo to [Railway](https://railway.app)
3. Set all environment variables in the Railway dashboard
4. Railway will give you a public URL like `your-app.up.railway.app`
5. Set the `MEDIA_STREAM_URL` secret in your Lovable project to `wss://your-app.up.railway.app`

## Deploying to Fly.io

1. Install the Fly CLI: `brew install flyctl`
2. Run `fly launch` in this directory
3. Set secrets: `fly secrets set OPENAI_API_KEY=... SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=...`
4. Deploy: `fly deploy`
5. Set the `MEDIA_STREAM_URL` secret to `wss://your-app.fly.dev`

## Health Check

`GET /health` returns `{ "status": "ok", "activeCalls": N }`

## Architecture

Each incoming Twilio WebSocket connection gets its own isolated `CallHandler` instance:
- Looks up the restaurant from the database by the called phone number
- Loads the menu dynamically
- Opens a persistent OpenAI Realtime session (no relay/timeout)
- Handles orders, reservations, menu lookups, and transcripts
- All calls are fully concurrent and isolated
