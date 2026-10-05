// The headless client now lives in the shared @4am/agent-core workspace so the
// in-server bot supervisor (Phase 1) can reuse it. This module re-exports it
// unchanged so existing MCP code and tests keep importing `./client.js`.
export * from '@4am/agent-core/client';
