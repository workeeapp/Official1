process.env.NODE_ENV = "test";
process.env.DATABASE_URL ??=
  "postgresql://workee:workee@localhost:5432/workee_test";
process.env.AUTH_SECRET ??= "test-auth-secret-that-is-at-least-32-chars";
process.env.CLIENT_ORIGIN ??= "http://localhost:5173";
process.env.PORT ??= "3001";
