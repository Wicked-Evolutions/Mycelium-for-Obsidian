export interface EmbeddingChunk {
  blockId: string | null;
  embeddingText: string;
  sourceText: string;
  heading: string;
  level: number;
  startLine: number;
  chunkIndex: number;
  chunkCount: number;
}

interface LogicalSection {
  blockId: string | null;
  sourceText: string;
  heading: string;
  level: number;
  startLine: number;
}

interface HeadingMatch {
  index: number;
  heading: string;
  level: number;
  startLine: number;
  baseId: string;
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function slugifyHeading(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .trim();
}

function uniqueId(candidate: string, used: Set<string>): string {
  const base = candidate || '_section';
  let value = base;
  let suffix = 2;
  while (used.has(value)) value = `${base}-${suffix++}`;
  used.add(value);
  return value;
}

function findHeadings(content: string): HeadingMatch[] {
  const matches: HeadingMatch[] = [];
  const counts = new Map<string, number>();
  const headingPattern = /^(#{1,6})[ \t]+(.+?)[ \t]*$/gm;
  let match: RegExpExecArray | null;
  let startLine = 1;
  let scannedThrough = 0;

  while ((match = headingPattern.exec(content)) !== null) {
    let newline = content.indexOf('\n', scannedThrough);
    while (newline !== -1 && newline < match.index) {
      startLine += 1;
      scannedThrough = newline + 1;
      newline = content.indexOf('\n', scannedThrough);
    }
    const headingText = match[2].trim();
    const rawBase = slugifyHeading(headingText);
    const count = (counts.get(rawBase) ?? 0) + 1;
    counts.set(rawBase, count);
    const fallback = rawBase || `_section-${matches.length + 1}`;
    const baseId = count === 1 ? fallback : `${fallback}-${count}`;
    matches.push({
      index: match.index,
      heading: match[0],
      level: match[1].length,
      startLine,
      baseId,
    });
  }

  return matches;
}

function logicalSections(content: string): LogicalSection[] {
  const headings = findHeadings(content);
  if (headings.length === 0) {
    return [{ blockId: null, sourceText: content, heading: '', level: 0, startLine: 1 }];
  }

  const sections: LogicalSection[] = [];
  const usedIds = new Set<string>();
  const preamble = content.slice(0, headings[0].index);
  let firstHeadingStart = headings[0].index;
  if (preamble.trim().length > 0) {
    sections.push({
      blockId: uniqueId('_preamble', usedIds),
      sourceText: preamble,
      heading: '',
      level: 0,
      startLine: 1,
    });
  } else {
    firstHeadingStart = 0;
  }

  for (let index = 0; index < headings.length; index++) {
    const heading = headings[index];
    const start = index === 0 ? firstHeadingStart : heading.index;
    const end = headings[index + 1]?.index ?? content.length;
    sections.push({
      blockId: uniqueId(heading.baseId, usedIds),
      sourceText: content.slice(start, end),
      heading: heading.heading,
      level: heading.level,
      startLine: heading.startLine,
    });
  }

  return sections;
}

function boundedEnd(value: string, start: number, maxBytes: number): number {
  let end = start;
  let bytes = 0;
  let paragraphBreak = -1;
  let lineBreak = -1;
  let whitespaceBreak = -1;

  while (end < value.length) {
    const codePoint = value.codePointAt(end);
    if (codePoint === undefined) break;
    const character = String.fromCodePoint(codePoint);
    const nextBytes = utf8Bytes(character);
    if (bytes + nextBytes > maxBytes) break;
    bytes += nextBytes;
    end += character.length;

    if (character === '\n') {
      lineBreak = end;
      if (end >= 2 && value[end - 2] === '\n') paragraphBreak = end;
    } else if (/\s/u.test(character)) {
      whitespaceBreak = end;
    }
  }

  if (end === start) {
    throw new Error('Embedding byte budget is too small for one UTF-8 code point.');
  }
  if (end === value.length) return end;

  const minimumPreferred = start + Math.floor((end - start) / 2);
  for (const preferred of [paragraphBreak, lineBreak, whitespaceBreak]) {
    if (preferred >= minimumPreferred) return preferred;
  }
  return end;
}

function splitSection(section: LogicalSection, maxInputBytes: number): Array<{
  sourceText: string;
  embeddingText: string;
}> {
  const pieces: Array<{ sourceText: string; embeddingText: string }> = [];
  const headingPrefix = section.heading ? `${section.heading}\n\n` : '';
  const canRepeatHeading = headingPrefix.length > 0 &&
    utf8Bytes(headingPrefix) <= Math.floor(maxInputBytes / 2);
  let start = 0;

  while (start < section.sourceText.length) {
    const prefix = pieces.length > 0 && canRepeatHeading ? headingPrefix : '';
    const availableBytes = maxInputBytes - utf8Bytes(prefix);
    const end = boundedEnd(section.sourceText, start, availableBytes);
    const sourceText = section.sourceText.slice(start, end);
    pieces.push({ sourceText, embeddingText: prefix + sourceText });
    start = end;
  }

  return pieces;
}

/**
 * Split Markdown into deterministic, UTF-8-bounded embedding prompts.
 * `sourceText` slices concatenate to the original nonblank source exactly;
 * `embeddingText` may repeat a bounded heading prefix for retrieval context.
 */
export function chunkMarkdownForEmbedding(
  content: string,
  maxInputBytes: number
): EmbeddingChunk[] {
  if (!Number.isSafeInteger(maxInputBytes) || maxInputBytes < 16) {
    throw new RangeError('Embedding byte budget must be an integer of at least 16 bytes.');
  }
  if (content.trim().length === 0) return [];

  const sections = logicalSections(content);
  const split = sections.map(section => ({ section, pieces: splitSection(section, maxInputBytes) }));
  const reservedIds = new Set(
    sections.flatMap(section => section.blockId === null ? [] : [section.blockId])
  );
  const usedIds = new Set<string>();
  const chunks: EmbeddingChunk[] = [];

  for (const { section, pieces } of split) {
    for (let index = 0; index < pieces.length; index++) {
      let blockId: string | null;
      if (pieces.length === 1) {
        blockId = section.blockId;
        if (blockId !== null) usedIds.add(blockId);
      } else {
        const base = section.blockId ?? '_file';
        const candidate = `${base}--chunk-${index + 1}`;
        let generated = candidate;
        let suffix = 2;
        while (reservedIds.has(generated) || usedIds.has(generated)) {
          generated = `${candidate}-${suffix++}`;
        }
        usedIds.add(generated);
        blockId = generated;
      }

      chunks.push({
        blockId,
        sourceText: pieces[index].sourceText,
        embeddingText: pieces[index].embeddingText,
        heading: section.heading,
        level: section.level,
        startLine: section.startLine,
        chunkIndex: index + 1,
        chunkCount: pieces.length,
      });
    }
  }

  return chunks;
}
