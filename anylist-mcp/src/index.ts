#!/usr/bin/env node
import { installSafeConsole, log } from './logging.js';
// Must run before anything logs: keeps stdout clean for stdio and redacts secrets.
installSafeConsole();

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createAnyListProvider } from './anylist-client.js';
import { ConfigError, loadAnyListConfig, loadHttpConfig } from './config.js';
import { createHttpApp } from './http.js';
import { registerSecrets } from './redact.js';
import { AnyListService } from './service.js';
import { createMcpServer } from './tools.js';

async function main() {
  const args = process.argv.slice(2);
  const mode = args.includes('--http') ? 'http' : args.includes('--stdio') ? 'stdio' : (process.env.MCP_TRANSPORT ?? 'stdio');

  const anylistConfig = loadAnyListConfig();
  const provider = createAnyListProvider(anylistConfig);
  const service = new AnyListService(provider);

  if (mode === 'http') {
    const httpConfig = loadHttpConfig();
    registerSecrets(() => [httpConfig.authToken]);
    const app = createHttpApp(httpConfig, service);
    const server = app.listen(httpConfig.port, httpConfig.host, () => {
      log.info(
        `AnyList MCP listening on http://${httpConfig.host}:${httpConfig.port}/mcp` +
          (httpConfig.publicUrl ? ` (OAuth issuer ${httpConfig.publicUrl.origin})` : ' (bearer token only; set PUBLIC_URL to enable OAuth)'),
      );
    });
    const shutdown = () => server.close(() => process.exit(0));
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
  } else if (mode === 'stdio') {
    const server = createMcpServer(service);
    await server.connect(new StdioServerTransport());
    log.info('AnyList MCP running on stdio');
  } else {
    throw new ConfigError(`Unknown MCP_TRANSPORT "${mode}" (use "stdio" or "http").`);
  }
}

main().catch(err => {
  log.error(err instanceof ConfigError ? err.message : 'Fatal error:', err instanceof ConfigError ? '' : err);
  process.exit(1);
});
