module.exports = {
  apps: [
    {
      name: "unsync-portal-api",
      script: "src/server.js",
      cwd: __dirname,
      instances: 1,
      exec_mode: "fork",
      max_memory_restart: "256M",
      restart_delay: 5000,
      max_restarts: 10,
      min_uptime: "10s",
      time: true,
      error_file: "./logs/portal-api-error.log",
      out_file: "./logs/portal-api-out.log",
      merge_logs: true,
      env: {
        NODE_ENV: "production",
        PORT: "8787",
        PORTAL_DATA_DIR: "./data",
        PORTAL_ALLOWED_ORIGIN: "https://mail.unsync.uk",
        PORTAL_PUBLIC_READER_BASE_URL: "https://mail.unsync.uk",
        PORTAL_PUBLIC_API_BASE_URL: "https://api.mail.unsync.uk",
        PORTAL_MAX_BODY_BYTES: "524288",
        PORTAL_MAX_JSON_BODY_BYTES: "524288",
        PORTAL_MAX_ATTACHMENT_CHUNK_BYTES: "1052672",
        TRUST_PROXY: "true",
        PORTAL_ENABLE_HSTS: "true",
        CLEANUP_INTERVAL_MS: "300000",
        CONSUMED_PORTAL_RETENTION_MS: "600000",
        PORTAL_RATE_LIMIT_WINDOW_MS: "60000",
        PORTAL_RATE_LIMIT_MAX: "60",
        OTP_COOLDOWN_MS: "60000",
        BAD_TOKEN_BLOCK_MS: "900000",
        ATTACHMENT_RATE_LIMIT_MAX: "120",
        UPLOAD_SESSION_TTL_MS: "900000",
        STAGED_UPLOAD_RETENTION_MS: "900000",
        OPS_ADMIN_TOKEN: "change-me-long-random-token",
        OPS_EVENTS_MAX: "100"
      }
    }
  ]
};
