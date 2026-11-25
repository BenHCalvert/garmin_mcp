import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { getOAuthProtectedResourceMetadataUrl, mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import type { OAuthTokenVerifier } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import { InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { HttpConfig } from './config.js';
import { log } from './logging.js';
import { constantTimeEquals, OwnerOAuthProvider } from './oauth.js';
import type { AnyListService } from './service.js';
import { createMcpServer } from './tools.js';

const STATIC_TOKEN_CLIENT_ID = 'static-bearer-token';
const APPROVE_PATH = '/oauth/approve';

export function createHttpApp(config: HttpConfig, service: AnyListService): Express {
  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', 1);

  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true });
  });

  let oauth: OwnerOAuthProvider | undefined;
  let resourceMetadataUrl: string | undefined;
  if (config.publicUrl) {
    const mcpUrl = new URL('/mcp', config.publicUrl);
    oauth = new OwnerOAuthProvider({
      ownerSecret: config.authToken,
      allowedRedirectHosts: config.allowedRedirectHosts,
      stateFile: config.oauthStateFile,
      approvePath: APPROVE_PATH,
    });
    app.use(
      mcpAuthRouter({
        provider: oauth,
        issuerUrl: new URL(config.publicUrl.origin),
        resourceServerUrl: mcpUrl,
        resourceName: 'AnyList MCP',
      }),
    );
    app.post(APPROVE_PATH, express.urlencoded({ extended: false, limit: '16kb' }), oauth.handleApprove);
    resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(mcpUrl);
  }

  // Accept the static MCP_AUTH_TOKEN, or an access token issued by the OAuth flow above.
  const verifier: OAuthTokenVerifier = {
    async verifyAccessToken(token) {
      if (constantTimeEquals(token, config.authToken)) {
        return {
          token,
          clientId: STATIC_TOKEN_CLIENT_ID,
          scopes: [],
          expiresAt: Math.floor(Date.now() / 1000) + 3600,
        };
      }
      if (oauth) return oauth.verifyAccessToken(token);
      throw new InvalidTokenError('Invalid token');
    },
  };
  const auth = requireBearerAuth({ verifier, resourceMetadataUrl });

  // Stateless Streamable HTTP: a fresh MCP server + transport per request, sharing one AnyList session.
  app.post('/mcp', auth, express.json({ limit: '1mb' }), async (req: Request, res: Response) => {
    const server = createMcpServer(service);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      log.error('MCP request failed:', err);
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
      }
    }
  });

  const methodNotAllowed = (_req: Request, res: Response) => {
    res.status(405).set('Allow', 'POST').json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method not allowed (stateless server: use POST).' },
      id: null,
    });
  };
  app.get('/mcp', auth, methodNotAllowed);
  app.delete('/mcp', auth, methodNotAllowed);

  // Never leak stack traces.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    log.error('HTTP error:', err);
    if (!res.headersSent) res.status(500).json({ error: 'internal_error' });
  });

  return app;
}
