/**
 * Obsidian MCP Type Definitions
 */

// Vault configuration
export interface VaultConfig {
  name: string;
  path: string;
}

// Parsed markdown file
export interface ParsedFile {
  path: string;           // Relative path from vault root
  absolutePath: string;   // Full filesystem path
  frontmatter: Record<string, unknown>;
  content: string;        // Content without frontmatter
  rawContent: string;     // Full file content
}

// Wikilink structure
//
// `raw` and `target` are LOAD-BEARING and must stay byte-identical to their
// historical semantics (all existing callers depend on them):
//   - `raw`    = the full match including `![[...]]`/`[[...]]` brackets
//   - `target` = the inner target with any cross-vault `vault:` prefix stripped,
//                but WITH the `#heading`/`#^block` subpath retained (legacy).
//
// The fields below (`vault`, `path`, `subpath`, `isEmbed`, `rawTarget`) are an
// ADDITIVE extension used by the graph layer (src/graph/*). They are optional so
// no existing WikiLink literal breaks, and existing tools are NOT migrated to
// them. Subpath stripping is computed locally in `path` — `resolveWikilink`
// stays untouched.
export interface WikiLink {
  raw: string;            // [[folder/note|alias]] or ![[folder/note]]
  target: string;         // folder/note (cross-vault prefix stripped; subpath retained)
  alias?: string;         // alias (if provided)
  resolved?: string;      // Resolved absolute path
  exists: boolean;        // Whether target file exists
  // ── Additive graph-layer fields (optional) ──
  rawTarget?: string;     // inner target verbatim, incl. vault prefix + subpath
  vault?: string;         // cross-vault prefix if present (e.g. "MyVault")
  path?: string;          // target with subpath stripped (link destination note)
  subpath?: string;       // "#heading" or "#^block" portion (without leading #), if any
  isEmbed?: boolean;      // true for ![[...]] embeds
}

// Backlink entry
export interface BacklinkEntry {
  sourcePath: string;     // File containing the link
  sourceTitle: string;    // Title of source file
  context: string;        // Surrounding text context
  lineNumber: number;     // Line where link appears
}

// File listing entry
export interface FileEntry {
  name: string;
  path: string;           // Relative path
  isDirectory: boolean;
  modified: Date;
  size: number;
}

// Search result
export interface SearchResult {
  path: string;
  matches: SearchMatch[];
  score?: number;         // For semantic search
}

export interface SearchMatch {
  lineNumber: number;
  lineContent: string;
  matchStart: number;
  matchEnd: number;
}

// Semantic search result
export interface SemanticResult {
  path: string;
  content: string;
  similarity: number;
  vault?: string;         // For cross-vault search
}

// Graph node/edge for ecosystem view
export interface GraphNode {
  id: string;
  path: string;
  title: string;
  vault?: string;
}

export interface GraphEdge {
  source: string;
  target: string;
  type: 'wikilink' | 'backlink';
}

export interface VaultGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

// Tool response wrapper
export interface ToolResponse {
  content: Array<{ type: 'text'; text: string }>;
  isError: boolean;
}
