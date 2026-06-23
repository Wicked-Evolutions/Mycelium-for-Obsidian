#!/usr/bin/env node

/**
 * Obsidian MCP Server
 *
 * A custom MCP server for Obsidian vaults with:
 * - Direct filesystem access (no Obsidian required)
 * - Multi-vault support via environment variables
 * - Wikilink parsing and resolution
 * - Backlink discovery
 * - Semantic search via Ollama embeddings (Phase 3)
 *
 * @author Influencentricity
 * @license MIT
 */

import 'dotenv/config';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema
} from '@modelcontextprotocol/sdk/types.js';
import { loadConfig, Config } from './config.js';
import { allTools, createAllHandlers } from './tools/index.js';
import { allPrompts, getPromptMessages } from './prompts/index.js';
import { createVaultWatcher, VaultWatcher } from './embeddings/watcher.js';
import { createHttpServer } from './http-server.js';

// Load configuration
let config: Config;

try {
  config = loadConfig();
  console.error(`[mcp-obsidian] Loaded config: ${config.mode} mode with ${config.vaults.length} vault(s)`);
  for (const vault of config.vaults) {
    console.error(`[mcp-obsidian]   - ${vault.name}: ${vault.path}`);
  }
} catch (error) {
  console.error('[mcp-obsidian] Failed to load config:', error);
  process.exit(1);
}

// Create MCP server
const server = new Server(
  {
    name: 'mcp-obsidian',
    version: '1.3.0'
  },
  {
    capabilities: {
      tools: {},
      prompts: {}
    }
  }
);

// Create tool handlers
const handlers = createAllHandlers(config);

// Create file watcher for auto-indexing
let watcher: VaultWatcher | null = null;
const autoIndexEnabled = process.env.OBSIDIAN_AUTO_INDEX !== 'false'; // Enabled by default

if (autoIndexEnabled) {
  watcher = createVaultWatcher({
    vaults: config.vaults,
    ollama: config.ollama,
    debounceMs: 2000
  });
}

// Handle tool listing
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: allTools };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  console.error(`[mcp-obsidian] Tool call: ${name}`);

  const handler = handlers[name];
  if (!handler) {
    return {
      content: [{ type: 'text', text: `Unknown tool: ${name}` }],
      isError: true
    } as const;
  }

  try {
    const result = await handler(args as Record<string, unknown>);
    return {
      content: result.content,
      isError: result.isError
    } as const;
  } catch (error) {
    console.error(`[mcp-obsidian] Tool error:`, error);
    return {
      content: [{ type: 'text', text: `Error executing ${name}: ${error}` }],
      isError: true
    } as const;
  }
});

// Handle prompt listing (MCP prompts capability — #14)
server.setRequestHandler(ListPromptsRequestSchema, async () => {
  return { prompts: allPrompts };
});

// Handle a single prompt fetch — returns primed user messages (never executes a tool)
server.setRequestHandler(GetPromptRequestSchema, async (request) => {
  return getPromptMessages(request.params.name, request.params.arguments ?? {});
});

// Graceful shutdown (idempotent) — used by signals AND client-disconnect detection
let shuttingDown = false;
function shutdown(reason: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.error(`[mcp-obsidian] Shutting down (${reason})...`);
  if (watcher) watcher.stop();
  process.exit(0);
}

// Process signal handlers
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('uncaughtException', (error) => {
  console.error('[mcp-obsidian] Uncaught exception:', error);
  process.exit(1);
});

process.on('unhandledRejection', (error) => {
  console.error('[mcp-obsidian] Unhandled rejection:', error);
  process.exit(1);
});

// Start server
async function main() {
  // Check if HTTP server mode is enabled (accept both env var names)
  const httpServerEnabled = process.env.OBSIDIAN_HTTP_SERVER === 'true' || process.env.HTTP_MODE === 'true';
  const httpPort = parseInt(process.env.OBSIDIAN_HTTP_PORT || process.env.HTTP_PORT || '3456', 10);

  if (httpServerEnabled) {
    // HTTP server mode - for Obsidian plugin access
    console.error('[mcp-obsidian] Starting in HTTP server mode...');
    createHttpServer({ port: httpPort, config });
  } else {
    // Standard MCP stdio mode - for Claude Desktop
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error('[mcp-obsidian] Server started (stdio mode)');

    // Exit when the client disconnects. Otherwise the embeddings file watcher
    // keeps the event loop alive forever and the process orphans (reparenting to
    // launchd/init), leaking one instance per closed client session. See issue #10.
    transport.onclose = () => shutdown('transport closed — client disconnected');
    process.stdin.on('end', () => shutdown('stdin EOF — client disconnected'));
    process.stdin.on('close', () => shutdown('stdin closed — client disconnected'));
  }
}

main().catch((error) => {
  console.error('[mcp-obsidian] Fatal error:', error);
  process.exit(1);
});
