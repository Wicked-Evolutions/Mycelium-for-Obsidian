/** Strict, side-effect-free support for native Obsidian note URIs in Markdown. */

export type ObsidianUriDiagnosticSeverity = 'error' | 'warning';

export interface ObsidianUriDiagnostic {
  code: string;
  severity: ObsidianUriDiagnosticSeverity;
  message: string;
}

export interface ParsedObsidianUri {
  /** The URI exactly as supplied by the caller. */
  raw: string;
  vault?: string;
  file?: string;
  subpath?: string;
  canonicalUri?: string;
  isMarkdownNote: boolean;
  noncanonical: boolean;
  diagnostics: ObsidianUriDiagnostic[];
}

export interface ObsidianUriOccurrence extends ParsedObsidianUri {
  /** The complete Markdown inline link exactly as it appeared. */
  markdown: string;
  label: string;
  offset: number;
  /** One-based source line. */
  line: number;
  /** One-based source column. */
  column: number;
}

function addDiagnostic(
  diagnostics: ObsidianUriDiagnostic[],
  code: string,
  severity: ObsidianUriDiagnosticSeverity,
  message: string
): void {
  if (!diagnostics.some(d => d.code === code && d.message === message)) {
    diagnostics.push({ code, severity, message });
  }
}

function decodeQueryValue(
  raw: string,
  diagnostics: ObsidianUriDiagnostic[],
  name: string
): string | undefined {
  if (/%(?![0-9a-fA-F]{2})/.test(raw)) {
    addDiagnostic(
      diagnostics,
      'malformed_percent_encoding',
      'error',
      `${name} contains malformed percent encoding.`
    );
    return undefined;
  }

  if (raw.includes('+')) {
    addDiagnostic(
      diagnostics,
      'raw_plus_as_space',
      'warning',
      `${name} contains a raw +, which query decoding treats as a space. Encode a literal plus as %2B.`
    );
  }

  try {
    return decodeURIComponent(raw.replace(/\+/g, ' '));
  } catch {
    addDiagnostic(
      diagnostics,
      'malformed_percent_encoding',
      'error',
      `${name} contains malformed percent encoding.`
    );
    return undefined;
  }
}

function notePathDiagnostic(file: string): ObsidianUriDiagnostic | undefined {
  if (
    file.includes('\\') ||
    file.includes('\0') ||
    file.startsWith('/') ||
    /^[a-zA-Z]:/.test(file) ||
    file.split('/').some(segment => segment === '' || segment === '.' || segment === '..')
  ) {
    return {
      code: 'invalid_path',
      severity: 'error',
      message: 'File must be a safe vault-relative path using forward slashes and no empty or dot segments.'
    };
  }
  return undefined;
}

function isMarkdownNotePath(file: string | undefined): boolean {
  return !!file && (!/\.[^/]+$/.test(file) || /\.md$/i.test(file));
}

/** RFC 3986 component encoding, including Markdown-significant parentheses. */
function encodeUriComponentStrict(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, character =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

/** Return the stable `vault + file` form used by Mycelium. */
export function serializeObsidianUri(input: {
  vault: string;
  file: string;
  subpath?: string;
}): string {
  if (!input.vault) throw new Error('A non-empty vault is required.');
  if (!input.file) throw new Error('A non-empty file is required.');
  const unsafe = notePathDiagnostic(input.file);
  if (unsafe) throw new Error(unsafe.message);
  if (!isMarkdownNotePath(input.file)) {
    throw new Error('Only Markdown note targets can be serialized as cross-vault note relationships.');
  }
  if (input.subpath === '') throw new Error('A subpath cannot be empty.');

  const file = /\.md$/i.test(input.file) ? input.file.slice(0, -3) : input.file;
  const target = input.subpath === undefined ? file : `${file}#${input.subpath}`;
  return `obsidian://open?vault=${encodeUriComponentStrict(input.vault)}&file=${encodeUriComponentStrict(target)}`;
}

/**
 * Parse the official `obsidian://open?vault=…&file=…` relationship form.
 *
 * The parser does not use `URLSearchParams`, because it must retain duplicate
 * parameters, malformed escapes, raw `+`, and noncanonical ordering as evidence.
 */
export function parseObsidianUri(raw: string): ParsedObsidianUri {
  const diagnostics: ObsidianUriDiagnostic[] = [];
  let vault: string | undefined;
  let file: string | undefined;
  let subpath: string | undefined;

  const match = /^obsidian:\/\/([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/i.exec(raw);
  if (!match) {
    addDiagnostic(diagnostics, 'malformed_uri', 'error', 'URI is not a parseable obsidian:// URI.');
    return {
      raw,
      isMarkdownNote: false,
      noncanonical: false,
      diagnostics
    };
  }

  const action = match[1];
  const query = match[2];
  const fragment = match[3];

  if (action.toLowerCase() !== 'open') {
    addDiagnostic(
      diagnostics,
      action.toLowerCase().startsWith('open/') ? 'unsupported_shorthand' : 'unsupported_action',
      'error',
      'Only the obsidian://open action with vault and file query parameters is supported.'
    );
  }
  if (fragment !== undefined) {
    addDiagnostic(
      diagnostics,
      'fragment',
      'error',
      'URI fragments are not file subpaths. Encode #Heading or #^block inside the file value.'
    );
  }
  if (query === undefined || query === '') {
    addDiagnostic(
      diagnostics,
      'missing_query',
      'error',
      'The vault and file query parameters are required.'
    );
  }

  const values = new Map<string, string>();
  const seen = new Set<string>();
  for (const part of (query || '').split('&')) {
    if (!part) {
      if (query) {
        addDiagnostic(
          diagnostics,
          'empty_query_segment',
          'warning',
          'Empty query segments are noncanonical.'
        );
      }
      continue;
    }

    const equals = part.indexOf('=');
    const name = equals < 0 ? part : part.slice(0, equals);
    const encodedValue = equals < 0 ? '' : part.slice(equals + 1);

    if (seen.has(name)) {
      addDiagnostic(
        diagnostics,
        'duplicate_query_param',
        'error',
        `Duplicate ${name || '(empty)'} query parameter.`
      );
      continue;
    }
    seen.add(name);

    if (name === 'path') {
      decodeQueryValue(encodedValue, diagnostics, 'path');
      addDiagnostic(
        diagnostics,
        'path_override',
        'error',
        'The absolute path form overrides vault and file and is outside this relationship contract.'
      );
      continue;
    }
    if (name !== 'vault' && name !== 'file') {
      decodeQueryValue(encodedValue, diagnostics, name || 'query parameter');
      addDiagnostic(
        diagnostics,
        'unknown_query_param',
        'error',
        `Unsupported query parameter: ${name || '(empty)'}.`
      );
      continue;
    }

    const decoded = decodeQueryValue(encodedValue, diagnostics, name);
    if (decoded !== undefined) values.set(name, decoded);
  }

  vault = values.get('vault');
  const decodedFile = values.get('file');

  if (!vault) {
    addDiagnostic(diagnostics, 'missing_vault', 'error', 'A non-empty vault query parameter is required.');
  }
  if (!decodedFile) {
    addDiagnostic(diagnostics, 'missing_file', 'error', 'A non-empty file query parameter is required.');
  } else {
    const hash = decodedFile.indexOf('#');
    file = hash < 0 ? decodedFile : decodedFile.slice(0, hash);
    subpath = hash < 0 ? undefined : decodedFile.slice(hash + 1);

    if (!file) {
      addDiagnostic(diagnostics, 'missing_file', 'error', 'A file path is required before a subpath.');
    }
    if (hash >= 0 && !subpath) {
      addDiagnostic(diagnostics, 'invalid_subpath', 'error', 'A heading or block subpath cannot be empty.');
    }

    const unsafe = file ? notePathDiagnostic(file) : undefined;
    if (unsafe) diagnostics.push(unsafe);

    if (file && !isMarkdownNotePath(file)) {
      addDiagnostic(
        diagnostics,
        'non_markdown_target',
        'error',
        'The URI targets a non-Markdown file, not a cross-vault note relationship.'
      );
    }
    if (file && /\.md$/i.test(file)) {
      addDiagnostic(
        diagnostics,
        'markdown_extension_present',
        'warning',
        'The Markdown .md extension is valid but omitted by the canonical relationship form.'
      );
    }
  }

  let canonicalUri: string | undefined;
  const hasParseError = diagnostics.some(d => d.severity === 'error');
  if (!hasParseError && vault && file && isMarkdownNotePath(file) && !notePathDiagnostic(file) && subpath !== '') {
    canonicalUri = serializeObsidianUri({ vault, file, subpath });
    if (raw !== canonicalUri) {
      addDiagnostic(
        diagnostics,
        'noncanonical_uri',
        'warning',
        'URI differs from the stable Mycelium serialization.'
      );
    }
  }

  return {
    raw,
    vault,
    file,
    subpath,
    canonicalUri,
    isMarkdownNote: isMarkdownNotePath(file),
    noncanonical: diagnostics.some(d => d.severity === 'warning'),
    diagnostics
  };
}

/** Build a mask for fenced and inline code while retaining original offsets. */
function markdownCodeMask(markdown: string): Uint8Array {
  const mask = new Uint8Array(markdown.length);
  let offset = 0;
  let fence: { marker: string; length: number } | undefined;

  for (const lineWithNewline of markdown.match(/.*(?:\n|$)/g) || []) {
    if (!lineWithNewline) continue;
    const line = lineWithNewline.endsWith('\n') ? lineWithNewline.slice(0, -1) : lineWithNewline;
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);

    if (fence) {
      mask.fill(1, offset, offset + lineWithNewline.length);
      if (
        fenceMatch &&
        fenceMatch[1][0] === fence.marker &&
        fenceMatch[1].length >= fence.length &&
        fenceMatch[2].trim() === ''
      ) {
        fence = undefined;
      }
    } else if (fenceMatch) {
      fence = { marker: fenceMatch[1][0], length: fenceMatch[1].length };
      mask.fill(1, offset, offset + lineWithNewline.length);
    } else {
      for (let cursor = 0; cursor < line.length;) {
        if (line[cursor] !== '`' || (cursor > 0 && line[cursor - 1] === '\\')) {
          cursor++;
          continue;
        }
        let runEnd = cursor;
        while (line[runEnd] === '`') runEnd++;
        const run = line.slice(cursor, runEnd);
        let close = -1;
        for (let candidate = runEnd; candidate < line.length;) {
          if (line[candidate] !== '`') {
            candidate++;
            continue;
          }
          let candidateEnd = candidate;
          while (line[candidateEnd] === '`') candidateEnd++;
          if (candidateEnd - candidate === run.length) {
            close = candidate;
            break;
          }
          candidate = candidateEnd;
        }
        if (close < 0) {
          cursor = runEnd;
          continue;
        }
        mask.fill(1, offset + cursor, offset + close + run.length);
        cursor = close + run.length;
      }
    }

    offset += lineWithNewline.length;
  }
  return mask;
}

/** Extract supported Markdown inline links, excluding images and code. */
export function extractObsidianUris(markdown: string): ObsidianUriOccurrence[] {
  const found: ObsidianUriOccurrence[] = [];
  const ignored = markdownCodeMask(markdown);
  const pattern = /(!?)\[([^\]\n]*)\]\(\s*(?:<(obsidian:\/\/[^>\s]+)>|(obsidian:\/\/[^\s)>]+))(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/gi;

  for (const match of markdown.matchAll(pattern)) {
    const offset = match.index || 0;
    if (match[1] === '!' || ignored[offset]) continue;

    const before = markdown.slice(0, offset);
    const lastNewline = before.lastIndexOf('\n');
    found.push({
      ...parseObsidianUri(match[3] || match[4]),
      markdown: match[0],
      label: match[2],
      offset,
      line: before.split('\n').length,
      column: offset - lastNewline
    });
  }
  return found;
}
