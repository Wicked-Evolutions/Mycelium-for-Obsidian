/**
 * CLI-only tools for Obsidian MCP
 * These tools REQUIRE the Obsidian CLI (1.12+) and cannot be replicated
 * via filesystem access. They access Obsidian's runtime state, plugin
 * systems, or internal databases.
 *
 * Tools that CAN work via filesystem have been promoted to fs-promoted.ts.
 */

import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { Config } from '../config.js';
import { ToolResponse } from '../types/index.js';
import { execCli, execCliForVault, evalInObsidian, isCliAvailable } from '../cli/bridge.js';
import { vaultParam } from './schema-helpers.js';

/**
 * Wrap a CLI tool handler to check availability first
 */
function withCliCheck(handler: (...args: any[]) => Promise<ToolResponse>): (...args: any[]) => Promise<ToolResponse> {
  return async (...args) => {
    const available = await isCliAvailable();
    if (!available) {
      return {
        content: [{ type: 'text', text: 'Obsidian CLI is not available. Make sure Obsidian 1.12+ is running with CLI enabled.' }],
        isError: true
      };
    }
    return handler(...args);
  };
}

// ─── Tool Definitions (CLI-only) ─────────────────────────────────────

export const cliTools: Tool[] = [
  // ── Eval ──
  {
    name: 'eval_obsidian',
    description: 'Execute JavaScript inside the Obsidian app and return the result. Access to full app API. Requires Obsidian running.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: vaultParam,
        code: { type: 'string', description: 'JavaScript code to execute (has access to app, app.vault, app.metadataCache, etc.)' }
      },
      required: ['code']
    }
  },

  // ── Commands ──
  {
    name: 'list_commands',
    description: 'List available Obsidian commands. Requires Obsidian running.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: vaultParam,
        filter: { type: 'string', description: 'Filter by command ID prefix' }
      }
    }
  },
  {
    name: 'execute_command',
    description: 'Execute an Obsidian command by ID. Requires Obsidian running.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: vaultParam,
        id: { type: 'string', description: 'Command ID (e.g., "editor:toggle-bold", "app:open-settings")' }
      },
      required: ['id']
    }
  },

  // ── Bases (query/create need runtime) ──
  {
    name: 'query_base',
    description: 'Query a base and return structured results. Requires Obsidian running.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: vaultParam,
        file: { type: 'string', description: 'Base file name' },
        path: { type: 'string', description: 'Base file path' },
        view: { type: 'string', description: 'View name to query' },
        format: { type: 'string', enum: ['json', 'csv', 'tsv', 'md', 'paths'], description: 'Output format (default: json)' }
      }
    }
  },
  {
    name: 'create_base_item',
    description: 'Create a new item in an Obsidian base/database. Requires Obsidian running.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: vaultParam,
        file: { type: 'string', description: 'Base file name' },
        path: { type: 'string', description: 'Base file path' },
        view: { type: 'string', description: 'View name' },
        name: { type: 'string', description: 'New item name' },
        content: { type: 'string', description: 'Initial content' }
      }
    }
  },
  {
    name: 'list_base_views',
    description: 'List views in a base file. Requires Obsidian running.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: vaultParam,
        file: { type: 'string', description: 'Base file name' },
        path: { type: 'string', description: 'Base file path' }
      }
    }
  },

  // ── Plugin state changes (runtime-only) ──
  {
    name: 'enable_plugin',
    description: 'Enable an installed plugin. Requires Obsidian running.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: vaultParam,
        id: { type: 'string', description: 'Plugin ID' }
      },
      required: ['id']
    }
  },
  {
    name: 'disable_plugin',
    description: 'Disable a plugin. Requires Obsidian running.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: vaultParam,
        id: { type: 'string', description: 'Plugin ID' }
      },
      required: ['id']
    }
  },

  // ── Snippet/theme state changes (runtime-only) ──
  {
    name: 'enable_snippet',
    description: 'Enable a CSS snippet. Requires Obsidian running.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: vaultParam,
        name: { type: 'string', description: 'Snippet name' }
      },
      required: ['name']
    }
  },
  {
    name: 'disable_snippet',
    description: 'Disable a CSS snippet. Requires Obsidian running.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: vaultParam,
        name: { type: 'string', description: 'Snippet name' }
      },
      required: ['name']
    }
  },
  {
    name: 'set_theme',
    description: 'Set the active theme. Requires Obsidian running.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: vaultParam,
        name: { type: 'string', description: 'Theme name (empty for default)' }
      },
      required: ['name']
    }
  },

  // ── Sync (runtime state) ──
  {
    name: 'sync_status',
    description: 'Get Obsidian Sync status (paused/active/connected). Requires Obsidian running.',
    inputSchema: {
      type: 'object',
      properties: { vault: vaultParam }
    }
  },
  {
    name: 'sync_history',
    description: 'List sync version history for a file. Requires Obsidian running.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: vaultParam,
        file: { type: 'string', description: 'File name' },
        path: { type: 'string', description: 'File path' }
      }
    }
  },
  {
    name: 'sync_read_version',
    description: 'Read a specific sync version of a file. Requires Obsidian running.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: vaultParam,
        file: { type: 'string', description: 'File name' },
        path: { type: 'string', description: 'File path' },
        version: { type: 'number', description: 'Version number' }
      },
      required: ['version']
    }
  },

  // ── Version management (internal DB) ──
  {
    name: 'list_versions',
    description: 'List version history for a file (from local file recovery and/or sync). Requires Obsidian running.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: vaultParam,
        file: { type: 'string', description: 'File name' },
        path: { type: 'string', description: 'File path' },
        filter: { type: 'string', enum: ['local', 'sync'], description: 'Filter by version source' }
      }
    }
  },
  {
    name: 'read_version',
    description: 'Read a specific version of a file from history. Requires Obsidian running.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: vaultParam,
        file: { type: 'string', description: 'File name' },
        path: { type: 'string', description: 'File path' },
        version: { type: 'number', description: 'Version number (1 = newest)' }
      },
      required: ['version']
    }
  },
  {
    name: 'diff_versions',
    description: 'Diff between two file versions (local or sync). Requires Obsidian running.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: vaultParam,
        file: { type: 'string', description: 'File name' },
        path: { type: 'string', description: 'File path' },
        from: { type: 'number', description: 'Version number to diff from' },
        to: { type: 'number', description: 'Version number to diff to' },
        filter: { type: 'string', enum: ['local', 'sync'], description: 'Filter by version source' }
      }
    }
  },
  {
    name: 'restore_version',
    description: 'Restore a file to a previous history version. Requires Obsidian running.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: vaultParam,
        file: { type: 'string', description: 'File name' },
        path: { type: 'string', description: 'File path' },
        version: { type: 'number', description: 'Version number to restore' }
      },
      required: ['version']
    }
  },
  {
    name: 'list_files_with_history',
    description: 'List files that have version history. Requires Obsidian running.',
    inputSchema: {
      type: 'object',
      properties: { vault: vaultParam }
    }
  },

  // ── Recents (in-memory state) ──
  {
    name: 'list_recents',
    description: 'List recently opened files. Requires Obsidian running.',
    inputSchema: {
      type: 'object',
      properties: { vault: vaultParam }
    }
  },

  // ── Search (Obsidian's FTS engine with operators) ──
  {
    name: 'vault_search',
    description: "Search vault using Obsidian's built-in search engine. Supports operators like file:, tag:, path:. Requires Obsidian running.",
    inputSchema: {
      type: 'object',
      properties: {
        vault: vaultParam,
        query: { type: 'string', description: 'Search query (supports Obsidian search operators)' },
        folder: { type: 'string', description: 'Limit to folder path' },
        limit: { type: 'number', description: 'Max files to return' },
        context: { type: 'boolean', description: 'Include matching line context (default: true)' },
        format: { type: 'string', enum: ['text', 'json'], description: 'Output format (default: text)' }
      },
      required: ['query']
    }
  },

  // ── Vault discovery (Obsidian app config) ──
  {
    name: 'list_known_vaults',
    description: 'List all vaults known to Obsidian with their paths. Requires Obsidian running.',
    inputSchema: {
      type: 'object',
      properties: {
        verbose: { type: 'boolean', description: 'Include vault paths' }
      }
    }
  },

  // ── Templates (with variable resolution via Obsidian engine) ──
  {
    name: 'create_from_template',
    description: 'Create a new file using an Obsidian template. Requires Obsidian running.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: vaultParam,
        name: { type: 'string', description: 'File name' },
        path: { type: 'string', description: 'File path' },
        template: { type: 'string', description: 'Template name to use' },
        content: { type: 'string', description: 'Additional initial content' },
        overwrite: { type: 'boolean', description: 'Overwrite if file exists' }
      },
      required: ['template']
    }
  },
  {
    name: 'list_templates',
    description: 'List available templates in the vault. Requires Obsidian running.',
    inputSchema: {
      type: 'object',
      properties: { vault: vaultParam }
    }
  },
  {
    name: 'read_template',
    description: 'Read a template with optional variable resolution. Requires Obsidian running.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: vaultParam,
        name: { type: 'string', description: 'Template name' },
        resolve: { type: 'boolean', description: 'Resolve template variables' },
        title: { type: 'string', description: 'Title for {{title}} variable resolution' }
      },
      required: ['name']
    }
  },

  // ── Hotkeys (defaults baked into Obsidian binary) ──
  {
    name: 'get_hotkey',
    description: 'Get the hotkey binding for a specific command. Requires Obsidian running.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: vaultParam,
        id: { type: 'string', description: 'Command ID' },
        verbose: { type: 'boolean', description: 'Show if custom or default' }
      },
      required: ['id']
    }
  },
  {
    name: 'list_hotkeys',
    description: 'List all hotkey bindings. Requires Obsidian running.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: vaultParam,
        verbose: { type: 'boolean', description: 'Show if custom or default' },
        all: { type: 'boolean', description: 'Include commands without hotkeys' },
        format: { type: 'string', enum: ['json', 'tsv', 'csv'], description: 'Output format (default: tsv)' }
      }
    }
  },

  // ── Enabled snippets list (partial — appearance.json may not have full state) ──
  {
    name: 'list_enabled_snippets',
    description: 'List enabled CSS snippets. Requires Obsidian running.',
    inputSchema: {
      type: 'object',
      properties: { vault: vaultParam }
    }
  }
];

// ─── Tool Handlers (CLI-only) ────────────────────────────────────────

export function createCliHandlers(config: Config): Record<string, (args: any) => Promise<ToolResponse>> {
  const ok = (text: string): ToolResponse => ({
    content: [{ type: 'text', text }],
    isError: false
  });

  const fileArg = (args: any): string[] => {
    const a: string[] = [];
    if (args.file) a.push(`file=${args.file}`);
    if (args.path) a.push(`path=${args.path}`);
    return a;
  };

  const handlers: Record<string, (args: any) => Promise<ToolResponse>> = {
    // ── Eval ──
    eval_obsidian: async (args) => {
      const result = await evalInObsidian(config, args.vault, args.code, 30000);
      return ok(result);
    },

    // ── Commands ──
    list_commands: async (args) => {
      const cliArgs: string[] = [];
      if (args.filter) cliArgs.push(`filter=${args.filter}`);
      const result = await execCliForVault(config, args.vault, 'commands', cliArgs);
      return ok(result || 'No commands found.');
    },

    execute_command: async (args) => {
      await execCliForVault(config, args.vault, 'command', [`id=${args.id}`]);
      return ok(`Command "${args.id}" executed.`);
    },

    // ── Bases ──
    query_base: async (args) => {
      const cliArgs = [...fileArg(args)];
      if (args.view) cliArgs.push(`view=${args.view}`);
      if (args.format) cliArgs.push(`format=${args.format}`);
      const result = await execCliForVault(config, args.vault, 'base:query', cliArgs);
      return ok(result || 'No results.');
    },

    create_base_item: async (args) => {
      const cliArgs = [...fileArg(args)];
      if (args.view) cliArgs.push(`view=${args.view}`);
      if (args.name) cliArgs.push(`name=${args.name}`);
      if (args.content) cliArgs.push(`content=${args.content}`);
      await execCliForVault(config, args.vault, 'base:create', cliArgs);
      return ok('Base item created.');
    },

    list_base_views: async (args) => {
      const result = await execCliForVault(config, args.vault, 'base:views', fileArg(args));
      return ok(result || 'No views found.');
    },

    // ── Plugin state changes ──
    enable_plugin: async (args) => {
      await execCliForVault(config, args.vault, 'plugin:enable', [`id=${args.id}`]);
      return ok(`Plugin "${args.id}" enabled.`);
    },

    disable_plugin: async (args) => {
      await execCliForVault(config, args.vault, 'plugin:disable', [`id=${args.id}`]);
      return ok(`Plugin "${args.id}" disabled.`);
    },

    // ── Snippet/theme state changes ──
    enable_snippet: async (args) => {
      await execCliForVault(config, args.vault, 'snippet:enable', [`name=${args.name}`]);
      return ok(`Snippet "${args.name}" enabled.`);
    },

    disable_snippet: async (args) => {
      await execCliForVault(config, args.vault, 'snippet:disable', [`name=${args.name}`]);
      return ok(`Snippet "${args.name}" disabled.`);
    },

    set_theme: async (args) => {
      await execCliForVault(config, args.vault, 'theme:set', [`name=${args.name}`]);
      return ok(`Theme set to "${args.name || 'default'}".`);
    },

    // ── Sync ──
    sync_status: async (args) => {
      const result = await execCliForVault(config, args.vault, 'sync:status');
      return ok(result || 'Sync status unavailable.');
    },

    sync_history: async (args) => {
      const result = await execCliForVault(config, args.vault, 'sync:history', fileArg(args));
      return ok(result || 'No sync history.');
    },

    sync_read_version: async (args) => {
      const cliArgs = [...fileArg(args), `version=${args.version}`];
      const result = await execCliForVault(config, args.vault, 'sync:read', cliArgs);
      return ok(result || 'Version not found.');
    },

    // ── Version management ──
    list_versions: async (args) => {
      const cliArgs = [...fileArg(args)];
      if (args.filter) cliArgs.push(`filter=${args.filter}`);
      const result = await execCliForVault(config, args.vault, 'diff', cliArgs);
      return ok(result || 'No versions found.');
    },

    read_version: async (args) => {
      const cliArgs = [...fileArg(args), `version=${args.version}`];
      const result = await execCliForVault(config, args.vault, 'history:read', cliArgs);
      return ok(result || 'Version not found.');
    },

    diff_versions: async (args) => {
      const cliArgs = [...fileArg(args)];
      if (args.from !== undefined) cliArgs.push(`from=${args.from}`);
      if (args.to !== undefined) cliArgs.push(`to=${args.to}`);
      if (args.filter) cliArgs.push(`filter=${args.filter}`);
      const result = await execCliForVault(config, args.vault, 'diff', cliArgs);
      return ok(result || 'No versions to diff.');
    },

    restore_version: async (args) => {
      const cliArgs = [...fileArg(args), `version=${args.version}`];
      await execCliForVault(config, args.vault, 'history:restore', cliArgs);
      return ok(`Restored to version ${args.version}.`);
    },

    list_files_with_history: async (args) => {
      const result = await execCliForVault(config, args.vault, 'history:list');
      return ok(result || 'No files with history.');
    },

    // ── Search ──
    vault_search: async (args) => {
      const cliArgs = [`query=${args.query}`];
      if (args.folder) cliArgs.push(`path=${args.folder}`);
      if (args.limit) cliArgs.push(`limit=${args.limit}`);
      if (args.format) cliArgs.push(`format=${args.format}`);
      const command = args.context !== false ? 'search:context' : 'search';
      const result = await execCliForVault(config, args.vault, command, cliArgs, 30000);
      return ok(result || 'No results found.');
    },

    // ── Recents ──
    list_recents: async (args) => {
      const result = await execCliForVault(config, args.vault, 'recents');
      return ok(result || 'No recent files.');
    },

    // ── Vault discovery ──
    list_known_vaults: async (_args) => {
      const cliArgs = ['vaults', 'verbose'];
      const result = await execCli(cliArgs);
      return ok(result || 'No vaults found.');
    },

    // ── Templates ──
    create_from_template: async (args) => {
      const cliArgs: string[] = [`template=${args.template}`];
      if (args.name) cliArgs.push(`name=${args.name}`);
      if (args.path) cliArgs.push(`path=${args.path}`);
      if (args.content) cliArgs.push(`content=${args.content}`);
      if (args.overwrite) cliArgs.push('overwrite');
      await execCliForVault(config, args.vault, 'create', cliArgs);
      return ok(`File created from template "${args.template}".`);
    },

    list_templates: async (args) => {
      const result = await execCliForVault(config, args.vault, 'templates');
      return ok(result || 'No templates found.');
    },

    read_template: async (args) => {
      const cliArgs = [`name=${args.name}`];
      if (args.resolve) cliArgs.push('resolve');
      if (args.title) cliArgs.push(`title=${args.title}`);
      const result = await execCliForVault(config, args.vault, 'template:read', cliArgs);
      return ok(result || 'Template not found.');
    },

    // ── Hotkeys ──
    get_hotkey: async (args) => {
      const cliArgs = [`id=${args.id}`];
      if (args.verbose) cliArgs.push('verbose');
      const result = await execCliForVault(config, args.vault, 'hotkey', cliArgs);
      return ok(result || 'No hotkey assigned.');
    },

    list_hotkeys: async (args) => {
      const cliArgs: string[] = [];
      if (args.verbose) cliArgs.push('verbose');
      if (args.all) cliArgs.push('all');
      if (args.format) cliArgs.push(`format=${args.format}`);
      const result = await execCliForVault(config, args.vault, 'hotkeys', cliArgs);
      return ok(result || 'No hotkeys configured.');
    },

    // ── Enabled snippets ──
    list_enabled_snippets: async (args) => {
      const result = await execCliForVault(config, args.vault, 'snippets:enabled');
      return ok(result || 'No snippets enabled.');
    }
  };

  // Wrap all handlers with CLI availability check
  const wrapped: Record<string, (args: any) => Promise<ToolResponse>> = {};
  for (const [name, handler] of Object.entries(handlers)) {
    wrapped[name] = withCliCheck(handler);
  }
  return wrapped;
}
