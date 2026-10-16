// @terminal/server: config, connectors, store, executor, HTTP + WebSocket app, and startServer.
export { startServer, DEFAULT_PORT, DEFAULT_WEB_DIST, type StartOptions, type RunningServer } from './main.js'
export { createApp, type App, type AppDeps, type InflightRun } from './app.js'
export {
  loadConfig,
  normalizeConfig,
  saveConnectorConfig,
  resolvedLlm,
  terminalHome,
  configPath,
  workspacesDir,
  ensureHome,
  ConfigSchema,
  LlmConfigSchema,
  ConnectorEntrySchema,
  DEFAULT_CONFIG_YML,
  DEFAULT_MODELS,
  PROVIDERS,
  type Config,
  type LlmConfig,
  type ConnectorEntry,
  type Provider,
  type LoadConfigOptions,
} from './config.js'
export { BUILTIN_CONNECTORS, builtinConnector, buildRegistry, connectorNeedsKey, describeConnectors, type ConnectorInfo, type BuildRegistryOptions } from './connectors.js'
export { WorkspaceStore, type WorkspaceInit, type WorkspacePatch } from './store.js'
export { Executor, Poller, errorMessage, type Emit, type RunOptions, type PollerOptions } from './executor.js'
export { createStubAgentRunner, stubWidgets, STUB_SYMBOLS, STUB_REPLY, STUB_WORKSPACE_NAME, type StubAgentOptions } from './stub-agent.js'
export { createAgentRunner, type LlmConfig as AgentLlmConfig } from './agent/index.js'
