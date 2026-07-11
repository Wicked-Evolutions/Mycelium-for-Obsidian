/**
 * Markdown parser for Obsidian files
 * Handles frontmatter extraction and content parsing
 */

import matter from 'gray-matter';
import * as fs from 'fs/promises';
import * as path from 'path';
import { ParsedFile } from '../types/index.js';
import { resolvePathInVault, verifyFileHandleInVault } from '../config.js';

/**
 * Maximum file size we'll read into memory (default 50 MB).
 * Prevents OOM from adversarial or accidentally huge files.
 * Override via OBSIDIAN_MAX_FILE_SIZE env var (in bytes).
 */
const MAX_FILE_SIZE = parseInt(process.env.OBSIDIAN_MAX_FILE_SIZE || '', 10) || 50 * 1024 * 1024;

async function readVerifiedTextFile(filePath: string, vaultPath: string): Promise<string> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(filePath, 'r');
    await verifyFileHandleInVault(handle, filePath, vaultPath);
    const fileStat = await handle.stat();
    if (fileStat.size > MAX_FILE_SIZE) {
      const sizeMB = (fileStat.size / (1024 * 1024)).toFixed(1);
      const limitMB = (MAX_FILE_SIZE / (1024 * 1024)).toFixed(0);
      throw new Error(`File too large (${sizeMB} MB, limit ${limitMB} MB): ${path.basename(filePath)}`);
    }
    return await handle.readFile({ encoding: 'utf8' });
  } finally {
    await handle?.close();
  }
}

/**
 * Parse a markdown file, extracting frontmatter and content
 */
export async function parseMarkdownFile(filePath: string, vaultPath: string): Promise<ParsedFile> {
  // If already absolute, verify it's within the vault; otherwise resolve safely
  const absolutePath = path.isAbsolute(filePath)
    ? resolvePathInVault(vaultPath, path.relative(vaultPath, filePath))
    : resolvePathInVault(vaultPath, filePath);

  const rawContent = await readVerifiedTextFile(absolutePath, vaultPath);
  const { data: frontmatter, content } = matter(rawContent);

  // Calculate relative path from vault root
  const relativePath = path.relative(vaultPath, absolutePath);

  return {
    path: relativePath,
    absolutePath,
    frontmatter,
    content: content.trim(),
    rawContent
  };
}

/**
 * Extract title from a parsed file
 * Priority: frontmatter.title > first H1 > filename
 */
export function extractTitle(parsed: ParsedFile): string {
  // Check frontmatter
  if (parsed.frontmatter.title && typeof parsed.frontmatter.title === 'string') {
    return parsed.frontmatter.title;
  }

  // Check for first H1
  const h1Match = parsed.content.match(/^#\s+(.+)$/m);
  if (h1Match) {
    return h1Match[1].trim();
  }

  // Fall back to filename without extension
  return path.basename(parsed.path, '.md');
}

/**
 * Update frontmatter in a file
 */
export async function updateFrontmatter(
  filePath: string,
  vaultPath: string,
  updates: Record<string, unknown>
): Promise<ParsedFile> {
  const parsed = await parseMarkdownFile(filePath, vaultPath);

  // Merge frontmatter updates
  const newFrontmatter = { ...parsed.frontmatter, ...updates };

  // Reconstruct file content
  const newContent = matter.stringify(parsed.content, newFrontmatter);

  // Write back to file
  await fs.writeFile(parsed.absolutePath, newContent, 'utf-8');

  // Return updated parsed file
  return {
    ...parsed,
    frontmatter: newFrontmatter,
    rawContent: newContent
  };
}

/**
 * Create a new markdown file with frontmatter
 */
export async function createMarkdownFile(
  filePath: string,
  vaultPath: string,
  content: string,
  frontmatter: Record<string, unknown> | string = {}
): Promise<ParsedFile> {
  const absolutePath = path.isAbsolute(filePath)
    ? resolvePathInVault(vaultPath, path.relative(vaultPath, filePath))
    : resolvePathInVault(vaultPath, filePath);

  // Ensure directory exists
  const dir = path.dirname(absolutePath);
  await fs.mkdir(dir, { recursive: true });

  // Normalize frontmatter: if it arrives as a JSON string, parse it.
  // gray-matter.stringify iterates strings char-by-char, producing corrupt YAML.
  let normalizedFrontmatter: Record<string, unknown>;
  if (typeof frontmatter === 'string') {
    try {
      normalizedFrontmatter = JSON.parse(frontmatter);
    } catch {
      normalizedFrontmatter = {};
    }
  } else {
    normalizedFrontmatter = frontmatter;
  }

  // Create file content with frontmatter
  const fileContent = Object.keys(normalizedFrontmatter).length > 0
    ? matter.stringify(content, normalizedFrontmatter)
    : content;

  await fs.writeFile(absolutePath, fileContent, 'utf-8');

  return parseMarkdownFile(absolutePath, vaultPath);
}

/**
 * Check if a file exists in the vault
 */
export async function fileExists(filePath: string, vaultPath: string): Promise<boolean> {
  const absolutePath = path.isAbsolute(filePath)
    ? resolvePathInVault(vaultPath, path.relative(vaultPath, filePath))
    : resolvePathInVault(vaultPath, filePath);

  try {
    await fs.access(absolutePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Section boundaries in a markdown file
 */
export interface SectionBoundary {
  headingStart: number;  // Start of heading line
  headingEnd: number;    // End of heading line (after newline)
  contentStart: number;  // Start of section content
  contentEnd: number;    // End of section content (before next heading or EOF)
  level: number;         // Heading level (1-6)
}

/**
 * Escape special regex characters in a string
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Find section boundaries by heading text
 * Returns null if heading not found
 */
export function findSectionByHeading(content: string, heading: string): SectionBoundary | null {
  // Normalize heading - user might pass "Progress Log" or "## Progress Log"
  const headingMatch = heading.match(/^(#{1,6})\s+(.+)$/);
  let targetLevel: number | null = null;
  let headingText: string;

  if (headingMatch) {
    targetLevel = headingMatch[1].length;
    headingText = headingMatch[2].trim();
  } else {
    headingText = heading.trim();
  }

  // Build regex to find the heading
  // If level specified, match exactly that level; otherwise match any level
  const levelPattern = targetLevel ? `#{${targetLevel}}` : '#{1,6}';
  const headingRegex = new RegExp(`^(${levelPattern})\\s+${escapeRegex(headingText)}\\s*$`, 'mi');

  const match = headingRegex.exec(content);
  if (!match || match.index === undefined) {
    return null;
  }

  const headingStart = match.index;
  const level = match[1].length;

  // Find end of heading line
  const lineEnd = content.indexOf('\n', headingStart);
  const headingEnd = lineEnd === -1 ? content.length : lineEnd + 1;
  const contentStart = headingEnd;

  // Find next heading of same or higher level (lower number = higher level)
  // E.g., if we're in ## Section, stop at # or ##, but not ###
  const nextHeadingRegex = new RegExp(`^#{1,${level}}\\s+`, 'm');
  const restOfContent = content.slice(contentStart);
  const nextMatch = nextHeadingRegex.exec(restOfContent);

  const contentEnd = nextMatch?.index !== undefined
    ? contentStart + nextMatch.index
    : content.length;

  return {
    headingStart,
    headingEnd,
    contentStart,
    contentEnd,
    level
  };
}

/**
 * Atomic write helper — writes to a temp file then renames.
 * Prevents partial writes from corrupting files on crash or concurrent access.
 */
async function atomicWriteFile(filePath: string, content: string): Promise<void> {
  const tmpPath = filePath + '.tmp.' + Date.now();
  await fs.writeFile(tmpPath, content, 'utf-8');
  await fs.rename(tmpPath, filePath);
}

/**
 * Append content to a section (before the next heading)
 */
export async function appendToSection(
  filePath: string,
  vaultPath: string,
  heading: string,
  newContent: string
): Promise<{ success: boolean; error?: string }> {
  const absolutePath = path.isAbsolute(filePath)
    ? resolvePathInVault(vaultPath, path.relative(vaultPath, filePath))
    : resolvePathInVault(vaultPath, filePath);

  const rawContent = await readVerifiedTextFile(absolutePath, vaultPath);
  const section = findSectionByHeading(rawContent, heading);

  if (!section) {
    return { success: false, error: `Section "${heading}" not found` };
  }

  // Insert at end of section content, before next heading
  // trimEnd() removes trailing whitespace, then add exactly one blank line separator
  const before = rawContent.slice(0, section.contentEnd).trimEnd();
  const after = rawContent.slice(section.contentEnd);
  const updatedContent = before + '\n\n' + newContent.trim() + '\n' +
    (after.length > 0 ? '\n' + after : '');

  await atomicWriteFile(absolutePath, updatedContent);

  return { success: true };
}

/**
 * Prepend content to a section (right after the heading)
 */
export async function prependToSection(
  filePath: string,
  vaultPath: string,
  heading: string,
  newContent: string
): Promise<{ success: boolean; error?: string }> {
  const absolutePath = path.isAbsolute(filePath)
    ? resolvePathInVault(vaultPath, path.relative(vaultPath, filePath))
    : resolvePathInVault(vaultPath, filePath);

  const rawContent = await readVerifiedTextFile(absolutePath, vaultPath);
  const section = findSectionByHeading(rawContent, heading);

  if (!section) {
    return { success: false, error: `Section "${heading}" not found` };
  }

  // headingEnd already includes the trailing newline of the heading line,
  // so contentStart === headingEnd. Insert content with one blank line after heading.
  const existingContent = rawContent.slice(section.contentStart);
  const updatedContent =
    rawContent.slice(0, section.headingEnd) +
    newContent.trim() + '\n\n' +
    existingContent.replace(/^\n+/, '');  // Remove leading blank lines to prevent accumulation

  await atomicWriteFile(absolutePath, updatedContent);

  return { success: true };
}

/**
 * Replace entire section content (between heading and next heading)
 */
export async function replaceSection(
  filePath: string,
  vaultPath: string,
  heading: string,
  newContent: string
): Promise<{ success: boolean; error?: string }> {
  const absolutePath = path.isAbsolute(filePath)
    ? resolvePathInVault(vaultPath, path.relative(vaultPath, filePath))
    : resolvePathInVault(vaultPath, filePath);

  const rawContent = await readVerifiedTextFile(absolutePath, vaultPath);
  const section = findSectionByHeading(rawContent, heading);

  if (!section) {
    return { success: false, error: `Section "${heading}" not found` };
  }

  // Replace: heading stays, content between headingEnd and contentEnd is replaced
  const after = rawContent.slice(section.contentEnd);
  const updatedContent =
    rawContent.slice(0, section.headingEnd) +
    newContent.trim() + '\n' +
    (after.length > 0 ? '\n' + after : '');

  await atomicWriteFile(absolutePath, updatedContent);

  return { success: true };
}

/**
 * Section extracted from markdown for chunking
 */
export interface ExtractedSection {
  heading: string;      // Full heading text with # prefix
  level: number;        // 1-6 for h1-h6
  content: string;      // Section content without heading
  blockId: string;      // Slugified heading for unique ID
  startLine: number;    // Line number where section starts
}

/**
 * Convert heading text to a URL-safe block ID
 */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')  // Remove special chars
    .replace(/\s+/g, '-')       // Spaces to hyphens
    .replace(/-+/g, '-')        // Collapse multiple hyphens
    .trim();
}

/**
 * Extract all sections from markdown content for chunking
 * Each section includes its heading and content until the next heading of same or higher level
 */
export function extractSections(content: string): ExtractedSection[] {
  const sections: ExtractedSection[] = [];
  const lines = content.split('\n');

  // Regex to match markdown headings
  const headingRegex = /^(#{1,6})\s+(.+)$/;

  // Track blockId usage to deduplicate — two "## Summary" headings get
  // blockIds "summary" and "summary-2" instead of both being "summary"
  const blockIdCounts = new Map<string, number>();

  let currentSection: {
    heading: string;
    level: number;
    blockId: string;
    startLine: number;
    contentLines: string[];
  } | null = null;

  // Track leading content before first heading (preamble)
  const preambleLines: string[] = [];
  let foundFirstHeading = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const match = line.match(headingRegex);

    if (match) {
      foundFirstHeading = true;
      const level = match[1].length;
      const headingText = match[2].trim();

      // Save previous section if exists
      if (currentSection) {
        sections.push({
          heading: currentSection.heading,
          level: currentSection.level,
          content: currentSection.contentLines.join('\n').trim(),
          blockId: currentSection.blockId,
          startLine: currentSection.startLine
        });
      }

      // Generate unique blockId — append counter suffix for duplicates
      let baseId = slugify(headingText);
      const count = (blockIdCounts.get(baseId) || 0) + 1;
      blockIdCounts.set(baseId, count);
      const blockId = count === 1 ? baseId : `${baseId}-${count}`;

      // Start new section
      currentSection = {
        heading: line,
        level,
        blockId,
        startLine: i + 1,  // 1-indexed
        contentLines: []
      };
    } else if (currentSection) {
      currentSection.contentLines.push(line);
    } else if (!foundFirstHeading) {
      preambleLines.push(line);
    }
  }

  // Don't forget the last section
  if (currentSection) {
    sections.push({
      heading: currentSection.heading,
      level: currentSection.level,
      content: currentSection.contentLines.join('\n').trim(),
      blockId: currentSection.blockId,
      startLine: currentSection.startLine
    });
  }

  // Add preamble as special section if it has meaningful content
  const preambleContent = preambleLines.join('\n').trim();
  if (preambleContent.length > 50) {  // Only if substantial
    sections.unshift({
      heading: '',
      level: 0,
      content: preambleContent,
      blockId: '_preamble',
      startLine: 1
    });
  }

  return sections;
}
