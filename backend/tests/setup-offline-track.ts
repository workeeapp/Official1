/**
 * offline track guard (vitest.config.ts): no test in this track may reach any
 * database. Point DATABASE_URL at an address that cannot exist and drop the
 * approval, so a hidden DB dependency fails loudly here (and is moved to the
 * db track) instead of silently reading whatever database the shell or the
 * product `.env` points at. Runs before tests/setup.ts, which keeps a set URL.
 */
process.env.DATABASE_URL = "postgresql://offline-track:no-db@127.0.0.1:1/offline_track_has_no_database";
delete process.env.WORKEE_APPROVED_TEST_DATABASE_URL;
