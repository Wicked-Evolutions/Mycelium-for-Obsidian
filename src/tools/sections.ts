/**
 * Section editing tools for Obsidian MCP
 * Phase 5: Partial Content Updates
 *
 * Enables appending/prepending to markdown sections without
 * loading/sending entire file content.
 */

import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { Config, resolveVault } from '../config.js';
import { ToolResponse } from '../types/index.js';
import {
  appendToSection,
  prependToSection,
  replaceSection
} from '../parsers/markdown.js';
import { vaultParam } from './schema-helpers.js';

/**
 * Tool definitions for section operations
 */
export const sectionTools: Tool[] = [
  {
    name: 'append_to_section',
    description: 'Append content to the end of a markdown section (before the next heading of same or higher level). Useful for adding entries to Progress Logs, adding items to lists, etc. without sending the entire file.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: vaultParam,
        path: {
          type: 'string',
          description: 'Relative path to the file (e.g., "03 Projects/PROJECT My Project.md")'
        },
        heading: {
          type: 'string',
          description: 'The heading text to find. Can include level (e.g., "## Progress Log") or just text (e.g., "Progress Log")'
        },
        content: {
          type: 'string',
          description: 'Content to append to the section'
        }
      },
      required: ['path', 'heading', 'content']
    }
  },
  {
    name: 'prepend_to_section',
    description: 'Prepend content to the beginning of a markdown section (right after the heading). Useful for adding new items at the top of a section.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: vaultParam,
        path: {
          type: 'string',
          description: 'Relative path to the file'
        },
        heading: {
          type: 'string',
          description: 'The heading text to find. Can include level (e.g., "## Log") or just text (e.g., "Log")'
        },
        content: {
          type: 'string',
          description: 'Content to prepend to the section'
        }
      },
      required: ['path', 'heading', 'content']
    }
  },
  {
    name: 'update_section',
    description: 'Replace the entire content of a markdown section (between heading and next heading of same or higher level). The heading itself is preserved.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: vaultParam,
        path: {
          type: 'string',
          description: 'Relative path to the file'
        },
        heading: {
          type: 'string',
          description: 'The heading text to find'
        },
        content: {
          type: 'string',
          description: 'New content to replace the section with'
        }
      },
      required: ['path', 'heading', 'content']
    }
  }
];

/**
 * Handler functions for section tools
 */
export function createSectionHandlers(config: Config) {
  return {
    append_to_section: async (args: {
      vault?: string;
      path: string;
      heading: string;
      content: string;
    }): Promise<ToolResponse> => {
      try {
        const vault = resolveVault(config, args.vault);
        const result = await appendToSection(
          args.path,
          vault.path,
          args.heading,
          args.content
        );

        if (!result.success) {
          return {
            content: [{ type: 'text', text: result.error || 'Unknown error' }],
            isError: true
          };
        }

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              success: true,
              path: args.path,
              section: args.heading,
              operation: 'append'
            }, null, 2)
          }],
          isError: false
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: `Error appending to section: ${error}` }],
          isError: true
        };
      }
    },

    prepend_to_section: async (args: {
      vault?: string;
      path: string;
      heading: string;
      content: string;
    }): Promise<ToolResponse> => {
      try {
        const vault = resolveVault(config, args.vault);
        const result = await prependToSection(
          args.path,
          vault.path,
          args.heading,
          args.content
        );

        if (!result.success) {
          return {
            content: [{ type: 'text', text: result.error || 'Unknown error' }],
            isError: true
          };
        }

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              success: true,
              path: args.path,
              section: args.heading,
              operation: 'prepend'
            }, null, 2)
          }],
          isError: false
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: `Error prepending to section: ${error}` }],
          isError: true
        };
      }
    },

    update_section: async (args: {
      vault?: string;
      path: string;
      heading: string;
      content: string;
    }): Promise<ToolResponse> => {
      try {
        const vault = resolveVault(config, args.vault);
        const result = await replaceSection(
          args.path,
          vault.path,
          args.heading,
          args.content
        );

        if (!result.success) {
          return {
            content: [{ type: 'text', text: result.error || 'Unknown error' }],
            isError: true
          };
        }

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              success: true,
              path: args.path,
              section: args.heading,
              operation: 'replace'
            }, null, 2)
          }],
          isError: false
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: `Error updating section: ${error}` }],
          isError: true
        };
      }
    }
  };
}
