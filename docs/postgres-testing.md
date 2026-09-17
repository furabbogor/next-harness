# PostgreSQL integration tests

The PostgreSQL suite is opt-in and is skipped when `TEST_DATABASE_URL` is unset. Use a dedicated local test database, never production. Each run creates a uniquely named schema, scopes its database connections and migrations to that schema, runs the real migration entrypoint twice, and drops only that schema during cleanup. It does not drop application tables in `public`.

Example local Debian setup (the role/password/database below are only local test credentials):

```sh
sudo service postgresql start
sudo -u postgres createuser --login next_harness_test 2>/dev/null || true
sudo -u postgres createdb --owner next_harness_test next_harness_test 2>/dev/null || true
sudo -u postgres psql -c "ALTER ROLE next_harness_test PASSWORD 'next_harness_test';"
TEST_DATABASE_URL='postgresql://next_harness_test:next_harness_test@127.0.0.1:5432/next_harness_test' npm test -- tests/postgres.test.ts
```

For a normal run without PostgreSQL, `npm test` remains unchanged and the suite is skipped. The test role needs permission to create schemas; it does not need superuser access.
