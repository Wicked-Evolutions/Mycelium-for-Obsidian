/**
 * HTTP Server for mcp-obsidian
 *
 * Provides REST API access to semantic search and vault tools
 * for use by the Obsidian plugin and other local clients.
 *
 * Security:
 * - Binds to 127.0.0.1 only (not all interfaces)
 * - Requires Bearer token auth via OBSIDIAN_HTTP_TOKEN env var
 * - CORS restricted to app://obsidian.md origin (configurable)
 *
 * Start with: OBSIDIAN_HTTP_SERVER=true OBSIDIAN_HTTP_TOKEN=your-secret node dist/index.js
 */

import * as crypto from 'crypto';
import express, { Request, Response, NextFunction } from 'express';
import { Config, getPrimaryVault } from './config.js';
import {
  allTools,
  applicableRecoveryTools,
  createAllHandlers,
  getToolByName,
  isKnownToolName
} from './tools/index.js';
import {
  normalizeToolResponse,
  toolResponseBody,
  unknownToolResponse,
  unexpectedToolFailure
} from './tool-outcomes.js';
import { ToolResponse } from './types/index.js';

export interface HttpServerOptions {
  port: number;
  config: Config;
  handlers?: ReturnType<typeof createAllHandlers>;
}

export function createHttpServer(options: HttpServerOptions) {
  const { port, config } = options;
  const app = express();

  // Auth token — required for HTTP mode
  const authToken = process.env.OBSIDIAN_HTTP_TOKEN;
  if (!authToken) {
    console.error('[mcp-obsidian] WARNING: OBSIDIAN_HTTP_TOKEN not set. Generating a random token for this session.');
  }
  const effectiveToken = authToken || crypto.randomBytes(32).toString('hex');
  if (!authToken) {
    console.error(`[mcp-obsidian] Session token: ${effectiveToken}`);
    console.error('[mcp-obsidian] Set OBSIDIAN_HTTP_TOKEN env var to use a persistent token.');
  }

  app.use(express.json());

  // CORS — restricted to Obsidian app origin (configurable via env)
  const allowedOrigin = process.env.OBSIDIAN_HTTP_CORS_ORIGIN || 'app://obsidian.md';
  app.use((req: Request, res: Response, next: NextFunction) => {
    res.header('Access-Control-Allow-Origin', allowedOrigin);
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') {
      return res.sendStatus(200);
    }
    next();
  });

  // Auth middleware — all routes except health check require Bearer token
  // Uses timing-safe comparison to prevent side-channel attacks
  const authMiddleware = (req: Request, res: Response, next: NextFunction) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Unauthorized. Provide Authorization: Bearer <token> header.' });
    }
    const provided = authHeader.slice(7);
    // Constant-time comparison — prevents timing side-channel leaking token bytes
    const tokenBuf = Buffer.from(effectiveToken, 'utf-8');
    const providedBuf = Buffer.from(provided, 'utf-8');
    if (tokenBuf.length !== providedBuf.length || !crypto.timingSafeEqual(tokenBuf, providedBuf)) {
      return res.status(401).json({ error: 'Unauthorized. Provide Authorization: Bearer <token> header.' });
    }
    next();
  };

  // Create all handlers
  const allHandlers = options.handlers ?? createAllHandlers(config);
  const vault = getPrimaryVault(config);
  const recoveryContext = {
    enabledTools: allTools,
    applicableTools: applicableRecoveryTools(config, allTools),
  };

  const errorBody = (result: ToolResponse, toolName: string): unknown => {
    const tool = getToolByName(toolName);
    const normalized = tool
      ? normalizeToolResponse(tool, result, recoveryContext)
      : result;
    if (normalized.structuredContent) return normalized.structuredContent;
    try {
      const parsed = toolResponseBody(normalized);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {
      // Fall through to a generic body rather than reflecting raw diagnostics.
    }
    return { error: 'The request could not be completed.' };
  };

  // Health check (no auth required)
  app.get('/health', (req: Request, res: Response) => {
    res.json({ status: 'ok', vault: vault.name });
  });

  // List all available tools with their schemas
  app.get('/tools', authMiddleware, (req: Request, res: Response) => {
    res.json(allTools);
  });

  // Execute any tool by name
  app.post('/call', authMiddleware, async (req: Request, res: Response) => {
    const controller = new AbortController();
    const abortRequest = () => controller.abort();
    const abortOnClose = () => {
      if (!res.writableEnded) controller.abort();
    };
    req.once('aborted', abortRequest);
    res.once('close', abortOnClose);
    try {
      const { tool, args = {} } = req.body;

      if (typeof tool !== 'string' || tool.length === 0) {
        return res.status(400).json({ error: 'tool name is required' });
      }

      const handler = Object.prototype.hasOwnProperty.call(allHandlers, tool)
        ? allHandlers[tool]
        : undefined;
      if (!handler) {
        const outcome = unknownToolResponse(
          tool,
          recoveryContext,
          config.disabledTools.has(tool) && isKnownToolName(tool)
        );
        return res.status(404).json(outcome.structuredContent);
      }

      const result = await handler(args, { signal: controller.signal });

      if (result.isError) {
        return res.status(500).json(errorBody(result, tool));
      }

      res.json(toolResponseBody(result));
    } catch (error) {
      if (!res.headersSent) {
        const toolName = typeof req.body?.tool === 'string' ? req.body.tool : '';
        const tool = getToolByName(toolName);
        if (tool) {
          const outcome = unexpectedToolFailure(tool, error);
          res.status(500).json(outcome.structuredContent);
        } else {
          res.status(500).json({ error: 'The request could not be completed.' });
        }
      }
    } finally {
      req.removeListener('aborted', abortRequest);
      res.removeListener('close', abortOnClose);
    }
  });

  // Legacy endpoints for backwards compatibility

  // Semantic search (legacy)
  app.post('/search', authMiddleware, async (req: Request, res: Response) => {
    try {
      const { query, limit = 10, minSimilarity = 0.5, expand = false } = req.body;

      if (!query) {
        return res.status(400).json({ error: 'query is required' });
      }

      const result = await allHandlers.semantic_search({
        query,
        limit,
        minSimilarity,
        expand
      });

      if (result.isError) {
        return res.status(500).json(errorBody(result, 'semantic_search'));
      }

      res.json(toolResponseBody(result));
    } catch {
      res.status(500).json({ error: 'The request could not be completed.' });
    }
  });

  // Read file (legacy)
  app.post('/read', authMiddleware, async (req: Request, res: Response) => {
    try {
      const { path: filePath } = req.body;

      if (!filePath) {
        return res.status(400).json({ error: 'path is required' });
      }

      const result = await allHandlers.read_file({ path: filePath });

      if (result.isError) {
        return res.status(500).json(errorBody(result, 'read_file'));
      }

      res.json(toolResponseBody(result));
    } catch {
      res.status(500).json({ error: 'The request could not be completed.' });
    }
  });

  // Index status (legacy)
  app.get('/index/status', authMiddleware, async (req: Request, res: Response) => {
    try {
      const result = await allHandlers.index_status({});
      if (result.isError) {
        return res.json(errorBody(result, 'index_status'));
      }
      res.json(toolResponseBody(result));
    } catch {
      res.status(500).json({ error: 'The request could not be completed.' });
    }
  });

  // Bind to localhost only — never expose to network
  const host = '127.0.0.1';
  const server = app.listen(port, host, () => {
    console.error(`[mcp-obsidian] HTTP server started on ${host}:${port}`);
  });

  return server;
}
