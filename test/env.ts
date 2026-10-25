/** Import before src/config.ts, which validates the environment on import and throws. */
process.env.ORIGIN ??= "https://wrapped.example.test";
process.env.ACTOR_SALT ??= "test-salt-not-a-real-secret";
process.env.DATA_DIR ??= "/tmp/fediverse-wrapped-test";
process.env.LOG_LEVEL ??= "error";
