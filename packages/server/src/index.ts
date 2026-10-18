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
export {
  WorkspaceStore,
  SqliteStore,
  openStore,
  databasePath,
  migrateJsonStore,
  migrateWorkspaceDoc,
  DB_FILE,
  MIGRATION_KEY,
  SCHEMA_VERSION,
  type Store,
  type OpenedStore,
  type MigrationReport,
  type WorkspaceInit,
  type WorkspacePatch,
  type CatalogCacheRow,
  type LivenessRow,
  type RunLogRow,
  type FrameCacheRow,
} from './store/index.js'
export { SqliteCache, type SqliteCacheOptions } from './cache-sqlite.js'
export {
  createDataRoutes,
  exportDocument,
  recipeNamesIn,
  loadUserRecipes,
  recipesPath,
  WorkspaceExportSchema,
  EXPORT_FORMAT,
  EXPORT_VERSION,
  TICKER_DEFAULT,
  type ProbeFn,
  type DataRouteDeps,
  type WorkspaceExport,
} from './routes-data.js'
export { Executor, Poller, errorMessage, nextExpiry, withProviderOverrides, PROVIDER_OVERRIDES_KEY, type Emit, type RunOptions, type PollerOptions, type Frames, type DatasetResult, type ProviderOverrides } from './executor.js'
export { createStubAgentRunner, stubWidgets, STUB_SYMBOLS, STUB_REPLY, STUB_WORKSPACE_NAME, type StubAgentOptions } from './stub-agent.js'
export { createAgentRunner, type LlmConfig as AgentLlmConfig } from './agent/index.js'
