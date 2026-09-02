// Proves this project's own config still resolved its relative paths.
(globalThis as { __APP_SETUP_RAN__?: boolean }).__APP_SETUP_RAN__ = true;
