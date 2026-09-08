# Workee

A production-ready authentication and dashboard foundation with a React frontend, Express API, and PostgreSQL.

Users sign in with a username and password. Authenticated sessions are stored in an httpOnly cookie. The dashboard greets the signed-in user by name.

## Setup

```bash
cp .env.example .env
docker compose up -d
npm install
npm run db:generate
npm run db:deploy
npm run db:seed
npm run dev
```

Or point `DATABASE_URL` at an existing PostgreSQL database.

- Frontend: [http://localhost:5173](http://localhost:5173)
- API: [http://localhost:3001](http://localhost:3001)

Local user:

```text
Username: Amit
Password: ChangeMe123!
```

Chat uses OpenAI. Put `OPENAI_API_KEY` in `.env`. Model, temperature, and the system message are read from `LLM.config.json` (or `LLM.config`) at the project root.

## Tests

```bash
npm test
```
