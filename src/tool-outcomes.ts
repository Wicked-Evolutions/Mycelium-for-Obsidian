import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { ToolResponse } from './types/index.js';

export const RECOVERY_MAX_BYTES = 8 * 1024;
export const RECOVERY_MAX_MATCHES = 3;
export const RECOVERY_MAX_ACTIONS = 3;

const MAX_IDENTIFIER_CODEPOINTS = 128;
const MAX_SCORING_TOKENS = 16;
const MAX_MESSAGE_CODEPOINTS = 512;
const MAX_CREDENTIAL_LABEL_CODEPOINTS = 64;
const MAX_ACTION_ARGUMENT_KEYS = 8;
const MAX_ACTION_ARGUMENT_CODEPOINTS = 256;
const MAX_EXISTING_JSON_BYTES = 32 * 1024;
const SENSITIVE_REDACTION = '[redacted]';
const PROTOTYPE_SENSITIVE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const SAFE_LEGACY_KEYS = new Set([
  'error', 'tool', 'readonly', 'link', 'resolved', 'exists', 'found', 'indexed',
  'path', 'line',
]);

const RECOVERY_STATUSES = new Set([
  'needs_action',
  'no_change',
  'unavailable',
  'conflict',
  'refused',
  'cancelled',
  'failed',
] as const);

export type RecoveryStatus =
  | 'needs_action'
  | 'no_change'
  | 'unavailable'
  | 'conflict'
  | 'refused'
  | 'cancelled'
  | 'failed';

export type SideEffectState = 'none' | 'performed' | 'possible' | 'unknown';

export interface RecoveryAction {
  label: string;
  tool: string;
  arguments?: Record<string, string | number | boolean | null>;
}

export interface RecoveryOutcomeInput {
  status: RecoveryStatus;
  code: string;
  message: string;
  retryable: boolean;
  sideEffects: { state: SideEffectState };
  requested?: string;
  closest_matches?: string[];
  hint?: string;
  actions?: RecoveryAction[];
  suggestionTrust?: {
    state: 'untrusted_identifiers';
    fields: ['closest_matches'];
  };
  legacy?: Record<string, unknown>;
}

export interface RecoveryContext {
  enabledTools: Tool[];
  applicableTools?: Tool[];
}

const WRITE_INTENT = new Set([
  'add', 'append', 'create', 'delete', 'disable', 'enable', 'eval', 'execute',
  'index', 'move', 'open', 'prepend', 'rebuild', 'remove', 'rename', 'replace',
  'restore', 'set', 'update', 'write',
]);
const NARROWING_TOKENS = new Set([
  'base', 'command', 'daily', 'history', 'hotkey', 'plugin', 'random', 'snippet',
  'sync', 'template', 'theme', 'version',
]);
const TOKEN_ALIASES = new Map<string, string[]>([
  ['note', ['file', 'markdown']],
  ['file', ['note', 'markdown']],
  ['read', ['content']],
  ['fetch', ['read', 'content']],
  ['load', ['read', 'content']],
  ['lookup', ['find', 'read']],
  ['retrieve', ['read', 'content']],
  ['content', ['read', 'text']],
  ['tool', ['command']],
  ['command', ['tool']],
]);
const COMMON_INTENT_ALIASES = new Map<string, string[]>([
  ['read_note', ['read_file', 'find_note_by_name', 'follow_link']],
]);
const NOT_FOUND_CLASSIFIER =
  /(?:not\s+found|(?:was|is|were|are)n['\u2019]t\s+found|does(?:\s+not|n['\u2019]t)\s+exist|(?:could|can)(?:\s+not|n['\u2019]t)\s+be\s+found)(?!\.[\p{L}\p{N}]|[/\\])/iu;
const UNAVAILABLE_CLASSIFIER =
  /(?:not\s+available|(?:was|is|were|are)n['\u2019]t\s+available|unavailable|not\s+ready|cannot\s+connect|not\s+running)(?!\.[\p{L}\p{N}]|[/\\])/iu;
const READ_ONLY_CLASSIFIER =
  /read[_ -]?only[_ -]?mode(?!\.[\p{L}\p{N}]|[/\\])/iu;
const VAULT_IDENTITY_CLASSIFIER =
  /vault_identity_unavailable(?!\.[\p{L}\p{N}]|[/\\])/iu;
const CANCELLED_CLASSIFIER =
  /\b(?:abort(?:ed|ing)?|cancel(?:led|ed|ing)?)\b(?!\.[\p{L}\p{N}]|[/\\])/iu;
const CONFLICT_CLASSIFIER =
  /(?:already\s+exists|destination.{0,160}\bexists)(?!\.[\p{L}\p{N}]|[/\\])/iu;
const NO_CHANGE_CLASSIFIER =
  /(?:no\s+changes?\s+made|search\s+text\s+not\s+found)(?!\.[\p{L}\p{N}]|[/\\])/iu;
const CLASSIFICATION_PATH_REDACTION = '[path]';
const CLASSIFICATION_SECRET_REDACTION = '[secret]';
const DIAGNOSTIC_PREFIX = '(?:(?:error|failure|failed)\\s*:\\s*)?';
const GENERAL_PATH_DIAGNOSTIC = new RegExp(
  `^${DIAGNOSTIC_PREFIX}(?:vault|file|note|link|section|item|destination|target|operation|request|obsidian|ollama|model|cli|provider|service|tool|plugin|search|replacement|content)\\b`,
  'iu'
);
const CANCELLED_PATH_DIAGNOSTIC = new RegExp(
  `^${DIAGNOSTIC_PREFIX}(?:operation|request|tool|command|write|move|copy|rename|delete|update|create|open|index)\\b`,
  'iu'
);
const CONFLICT_PATH_DIAGNOSTIC = new RegExp(
  `^${DIAGNOSTIC_PREFIX}(?:destination|target|operation|file|note|folder)\\b`,
  'iu'
);
const NO_CHANGE_PATH_DIAGNOSTIC = new RegExp(
  `^${DIAGNOSTIC_PREFIX}(?:file|note|section|content|search|replacement|operation|request)\\b`,
  'iu'
);
const NOT_FOUND_PATH_DIAGNOSTIC = new RegExp(
  `^${DIAGNOSTIC_PREFIX}(?:vault|file|note|link|section|item|plugin|tool|model)\\b`,
  'iu'
);
const UNAVAILABLE_PATH_DIAGNOSTIC = new RegExp(
  `^${DIAGNOSTIC_PREFIX}(?:vault|obsidian|ollama|model|cli|provider|service|tool)\\b`,
  'iu'
);
const URL_RELATIVE_PARAMETER_NAMES = new Set([
  'continue', 'next', 'redirect', 'return', 'returnto',
]);
const SECRET_PARAMETER_SUFFIXES = [
  'apikey', 'accesskey', 'accesskeyid', 'secretkey', 'privatekey', 'password',
  'passwd', 'passphrase', 'secret', 'token', 'credential', 'authorization', 'pat',
];
const MALFORMED_PERCENT_GAP = '(?:%[\\p{L}\\p{N}]*?)*';
const MALFORMED_PERCENT_SECRET_PATTERNS = SECRET_PARAMETER_SUFFIXES.map(suffix => (
  new RegExp(`${[...suffix].map(character => (
    `${character}${MALFORMED_PERCENT_GAP}`
  )).join('')}$`, 'u')
));
const QUOTE_PAIRS = new Map([
  ['"', '"'],
  ["'", "'"],
  ['\x60', '\x60'],
  ['\u00ab', '\u00bb'],
  ['\u2018', '\u2019'],
  ['\u201c', '\u201d'],
  ['\u201a', '\u2018'],
  ['\u201e', '\u201c'],
  ['\u2039', '\u203a'],
  ['\u3008', '\u3009'],
  ['\u300a', '\u300b'],
  ['\u300c', '\u300d'],
  ['\u300e', '\u300f'],
  ['\u301d', '\u301f'],
  ['\uff62', '\uff63'],
]);
const GENERIC_QUOTE_CLOSE = '\u0000';

function boundedCodePointPrefix(value: string, limit: number): {
  text: string;
  truncated: boolean;
} {
  let end = 0;
  let count = 0;
  while (end < value.length && count < limit) {
    const codePoint = value.codePointAt(end);
    end += codePoint !== undefined && codePoint > 0xffff ? 2 : 1;
    count += 1;
  }
  return { text: value.slice(0, end), truncated: end < value.length };
}

function boundedCodePointSuffix(value: string, limit: number): string {
  let start = value.length;
  let count = 0;
  while (start > 0 && count < limit) {
    const char = codePointBefore(value, start);
    start -= char.length;
    count += 1;
  }
  return value.slice(start);
}

function codePointAt(value: string, index: number): string {
  const codePoint = value.codePointAt(index);
  return codePoint === undefined ? '' : String.fromCodePoint(codePoint);
}

function codePointBefore(value: string, index: number): string {
  if (index <= 0) return '';
  const low = value.charCodeAt(index - 1);
  const start = low >= 0xdc00 && low <= 0xdfff && index > 1
    ? index - 2
    : index - 1;
  return codePointAt(value, start);
}

function isWordCodePoint(value: string): boolean {
  return value !== '' && /[\p{L}\p{N}_]/u.test(value);
}

function isWithinHttpUrl(value: string, index: number): boolean {
  return /https?:\/\/[^\s"<>]*$/i.test(value.slice(0, index));
}

function followsUriScheme(value: string, index: number): boolean {
  return /[A-Za-z][A-Za-z0-9+.-]*:$/.test(value.slice(0, index));
}

function decodeUtf8At(bytes: number[], index: number): {
  char: string;
  length: number;
} | undefined {
    const first = bytes[index];
    let length = 0;
    if (first <= 0x7f) length = 1;
    else if (first >= 0xc2 && first <= 0xdf) length = 2;
    else if (first >= 0xe0 && first <= 0xef) length = 3;
    else if (first >= 0xf0 && first <= 0xf4) length = 4;

    const sequence = bytes.slice(index, index + length);
    const continuationValid = length > 0 && sequence.length === length &&
      sequence.slice(1).every(byte => byte >= 0x80 && byte <= 0xbf);
    const boundaryValid = continuationValid && !(
      (first === 0xe0 && sequence[1] < 0xa0) ||
      (first === 0xed && sequence[1] > 0x9f) ||
      (first === 0xf0 && sequence[1] < 0x90) ||
      (first === 0xf4 && sequence[1] > 0x8f)
    );
    if (!boundaryValid) return undefined;

    let codePoint = length === 1 ? first : first & (0x7f >> length);
    for (const byte of sequence.slice(1)) {
      codePoint = (codePoint << 6) | (byte & 0x3f);
    }
    return { char: String.fromCodePoint(codePoint), length };
}

function decodePercentRun(value: string): string {
  const tokens = value.match(/%[0-9a-f]{2}/gi) ?? [];
  const bytes = tokens.map(token => Number.parseInt(token.slice(1), 16));
  let decoded = '';
  let index = 0;
  while (index < bytes.length) {
    const sequence = decodeUtf8At(bytes, index);
    if (!sequence) {
      decoded += tokens[index];
      index += 1;
      continue;
    }
    decoded += sequence.char;
    index += sequence.length;
  }
  return decoded;
}

function decodePercentEscapesOnce(value: string): string {
  return value.replace(/(?:%[0-9a-f]{2})+/gi, decodePercentRun);
}

function decodeRecognizedPercentEscapes(value: string): string {
  let decoded = value;
  // Every successful round shortens the bounded input, so this reaches a
  // fixpoint in at most the original code-unit length without an open-ended loop.
  for (let round = 0; round < value.length; round += 1) {
    const next = decodePercentEscapesOnce(decoded);
    if (next === decoded) break;
    decoded = next;
  }
  return decoded;
}

function detectionShadow(value: string): string {
  return decodeRecognizedPercentEscapes(value)
    .normalize('NFKC')
    .replace(/[\p{Cc}\p{Cf}]+/gu, '');
}

interface DetectionUnit {
  char: string;
  rawStart: number;
  rawEnd: number;
}

interface MappedDetectionShadow {
  text: string;
  rawStarts: number[];
  rawEnds: number[];
  formatSpans: RawEdit[];
}

interface RawEdit {
  start: number;
  end: number;
  replacement: string;
}

interface ShadowRange {
  start: number;
  end: number;
}

function sourceDetectionUnits(value: string): DetectionUnit[] {
  const units: DetectionUnit[] = [];
  let index = 0;
  while (index < value.length) {
    const char = codePointAt(value, index);
    units.push({ char, rawStart: index, rawEnd: index + char.length });
    index += char.length;
  }
  return units;
}

function isHexUnit(unit: DetectionUnit | undefined): boolean {
  return !!unit && /^[0-9a-f]$/i.test(unit.char);
}

function isPercentTriplet(units: DetectionUnit[], index: number): boolean {
  return units[index]?.char === '%' &&
    isHexUnit(units[index + 1]) &&
    isHexUnit(units[index + 2]);
}

function decodeMappedPercentRound(units: DetectionUnit[]): DetectionUnit[] {
  const output: DetectionUnit[] = [];
  let index = 0;
  while (index < units.length) {
    if (!isPercentTriplet(units, index)) {
      output.push(units[index]);
      index += 1;
      continue;
    }

    const triplets: DetectionUnit[][] = [];
    const bytes: number[] = [];
    let cursor = index;
    while (isPercentTriplet(units, cursor)) {
      const triplet = units.slice(cursor, cursor + 3);
      triplets.push(triplet);
      bytes.push(Number.parseInt(`${triplet[1].char}${triplet[2].char}`, 16));
      cursor += 3;
    }

    let byteIndex = 0;
    while (byteIndex < bytes.length) {
      const sequence = decodeUtf8At(bytes, byteIndex);
      if (!sequence) {
        output.push(...triplets[byteIndex]);
        byteIndex += 1;
        continue;
      }
      output.push({
        char: sequence.char,
        rawStart: triplets[byteIndex][0].rawStart,
        rawEnd: triplets[byteIndex + sequence.length - 1][2].rawEnd,
      });
      byteIndex += sequence.length;
    }
    index = cursor;
  }
  return output;
}

function mappedDetectionShadow(
  value: string,
  mode: 'credential' | 'url-boundary'
): MappedDetectionShadow {
  let units = sourceDetectionUnits(value);
  for (let round = 0; round < value.length; round += 1) {
    const next = decodeMappedPercentRound(units);
    if (
      next.length === units.length &&
      next.every((unit, index) => unit.char === units[index].char)
    ) break;
    units = next;
  }

  const normalized: DetectionUnit[] = [];
  const formatSpans: RawEdit[] = [];
  for (const unit of units) {
    for (const char of unit.char.normalize('NFKC')) {
      if (/\p{Cf}/u.test(char)) {
        formatSpans.push({
          start: unit.rawStart,
          end: unit.rawEnd,
          replacement: '',
        });
        if (mode === 'credential') normalized.push({ ...unit, char });
      } else {
        normalized.push({ ...unit, char });
      }
    }
  }

  let text = '';
  const rawStarts: number[] = [];
  const rawEnds: number[] = [];
  for (const unit of normalized) {
    text += unit.char;
    for (let offset = 0; offset < unit.char.length; offset += 1) {
      rawStarts.push(unit.rawStart);
      rawEnds.push(unit.rawEnd);
    }
  }
  return { text, rawStarts, rawEnds, formatSpans };
}

function mappedCredentialShadow(value: string): MappedDetectionShadow {
  return mappedDetectionShadow(value, 'credential');
}

function mappedUrlBoundaryShadow(value: string): MappedDetectionShadow {
  return mappedDetectionShadow(value, 'url-boundary');
}

function normalizeSensitiveLabelVariant(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

function sensitiveLabelCandidates(value: string): string[] {
  const decoded = decodeRecognizedPercentEscapes(
    boundedCodePointSuffix(value, MAX_MESSAGE_CODEPOINTS).replace(/\p{Cf}+/gu, '')
  );
  return [
    decoded,
    decoded.replace(/%[A-Za-z0-9]*/g, ''),
    decoded.replace(/%/g, ''),
  ].map(candidate => boundedCodePointSuffix(
    normalizeSensitiveLabelVariant(candidate),
    MAX_CREDENTIAL_LABEL_CODEPOINTS
  ));
}

function normalizeMalformedPercentLabel(value: string): string {
  const normalized = decodeRecognizedPercentEscapes(
    boundedCodePointSuffix(value, MAX_MESSAGE_CODEPOINTS).replace(/\p{Cf}+/gu, '')
  )
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}%]+/gu, '');
  return boundedCodePointSuffix(normalized, MAX_MESSAGE_CODEPOINTS);
}

function normalizeSensitiveLabel(value: string): string {
  return sensitiveLabelCandidates(value)[0] ?? '';
}

function normalizeUrlParameterName(value: string): string {
  return normalizeSensitiveLabel(value);
}

function isSecretParameterName(value: string): boolean {
  return /(?:apikey|accesskey(?:id)?|secretkey|privatekey|password|passwd|passphrase|secret|token|credential|authorization|pat)$/
    .test(value);
}

function isSensitiveLabel(value: string): boolean {
  if (sensitiveLabelCandidates(value).some(isSecretParameterName)) return true;
  const normalized = normalizeMalformedPercentLabel(value);
  return normalized.includes('%') &&
    MALFORMED_PERCENT_SECRET_PATTERNS.some(pattern => pattern.test(normalized));
}

function hasSecretAssignmentLabel(value: string, separatorIndex: number): boolean {
  let end = separatorIndex;
  while (end > 0 && /\s/u.test(codePointBefore(value, end))) end -= 1;
  const candidate = boundedCodePointSuffix(
    value.slice(0, end),
    MAX_MESSAGE_CODEPOINTS
  );
  return isSensitiveLabel(candidate);
}

function structuralCharacter(value: string): string {
  const normalized = value.normalize('NFKC');
  return [...normalized].length === 1 ? normalized : value;
}

function closesQuotedValue(value: string, index: number, quote: string): boolean {
  const current = codePointAt(value, index);
  if (structuralCharacter(current) !== quote) return false;
  let nextIndex = index + current.length;
  while (
    nextIndex < value.length &&
    /\s/u.test(structuralCharacter(codePointAt(value, nextIndex)))
  ) {
    nextIndex += codePointAt(value, nextIndex).length;
  }
  const next = structuralCharacter(codePointAt(value, nextIndex));
  return next === '' || ';,&#)]}.!?'.includes(next) || next === '"' || next === "'";
}

function closesGenericQuotedValue(value: string, index: number): boolean {
  const current = structuralCharacter(codePointAt(value, index));
  return /[\p{Pf}\p{Pe}]/u.test(current) && closesQuotedValue(value, index, current);
}

function sensitiveValueEnd(value: string, start: number): number {
  let end = start;
  let quote = '';
  let escaped = false;
  while (end < value.length) {
    const rawCurrent = codePointAt(value, end);
    const current = structuralCharacter(rawCurrent);
    if (escaped) {
      escaped = false;
    } else if (current === '\\' && quote !== '') {
      escaped = true;
    } else if (quote !== '') {
      if (
        (quote === GENERIC_QUOTE_CLOSE && closesGenericQuotedValue(value, end)) ||
        (quote !== GENERIC_QUOTE_CLOSE && closesQuotedValue(value, end, quote))
      ) quote = '';
    } else if (QUOTE_PAIRS.has(current)) {
      quote = QUOTE_PAIRS.get(current) ?? '';
    } else if (/[\p{Pi}\p{Ps}]/u.test(current)) {
      quote = GENERIC_QUOTE_CLOSE;
    } else if (
      current === ';' || current === '&' || current === '#' ||
      current === '\r' || current === '\n'
    ) {
      break;
    }
    end += rawCurrent.length;
  }
  return end;
}

function redactNormalizedSecretAssignments(value: string, replacement: string): string {
  let output = '';
  let cursor = 0;
  let index = 0;
  while (index < value.length) {
    const current = codePointAt(value, index);
    if ((current !== '=' && current !== ':') || !hasSecretAssignmentLabel(value, index)) {
      index += current.length;
      continue;
    }
    let start = index + current.length;
    while (start < value.length && /\s/u.test(codePointAt(value, start))) {
      start += codePointAt(value, start).length;
    }
    const end = sensitiveValueEnd(value, start);
    output += value.slice(cursor, start) + replacement;
    cursor = end;
    index = end;
  }
  return output + value.slice(cursor);
}

function redactUriUserinfo(value: string, replacement: string): string {
  return value.replace(
    /\b([a-z][a-z0-9+.-]*:\/\/)([^/?#\s"<>]*)/gi,
    (match: string, scheme: string, authority: string) => {
      const separator = authority.lastIndexOf('@');
      if (separator < 0) return match;
      return `${scheme}${replacement}${authority.slice(separator)}`;
    }
  );
}

function findAbsolutePathStart(value: string, fromIndex = 0): number {
  let index = fromIndex;
  while (index < value.length) {
    const char = codePointAt(value, index);
    const previous = codePointBefore(value, index);
    const next = codePointAt(value, index + char.length);
    const afterNext = codePointAt(value, index + char.length + next.length);
    const prefixBoundary = previous === '' ||
      (!isWordCodePoint(previous) && previous !== '/' && previous !== '\\');
    const startsFileUrl = /^file:\/\/\/?/iu.test(value.slice(index));
    const startsPosixPath = char === '/' &&
      next !== '' &&
      next !== '/' &&
      !/\s/u.test(next);
    const startsUncPath = char === '/' &&
      next === '/' &&
      !followsUriScheme(value, index);
    const startsWindowsDrive = /^[A-Za-z]$/.test(char) &&
      next === ':' &&
      (afterNext === '/' || afterNext === '\\');
    const startsBackslashRoot = char === '\\' && next !== '' && !/\s/u.test(next);
    const startsPath = prefixBoundary &&
      !isWithinHttpUrl(value, index) &&
      (startsFileUrl || startsPosixPath || startsUncPath ||
        startsWindowsDrive || startsBackslashRoot);
    if (startsPath) return index;
    index += char.length;
  }
  return -1;
}

function containsLocalAbsolutePath(value: string): boolean {
  return findAbsolutePathStart(decodeRecognizedPercentEscapes(value)) >= 0;
}

function isAllowedRootRelativeUrlControl(parameterName: string, value: string): boolean {
  if (!URL_RELATIVE_PARAMETER_NAMES.has(parameterName)) return false;
  return value.trim() === '/dashboard' || value.trim() === '/home';
}

function redactSensitiveUrlParameters(
  value: string,
  secretReplacement = '[redacted]',
  pathReplacement = '[path]'
): string {
  const matcher = /[?&#;][^=\s&#;]+=/g;
  let output = '';
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = matcher.exec(value)) !== null) {
    const start = matcher.lastIndex;
    const rawParameterName = match[0].slice(1, -1);
    const parameterName = normalizeUrlParameterName(rawParameterName);
    let end = start;
    while (end < value.length && !/[&#;\r\n"<>]/u.test(codePointAt(value, end))) {
      end += codePointAt(value, end).length;
    }
    const decodedValue = decodeRecognizedPercentEscapes(value.slice(start, end));
    const secret = isSensitiveLabel(rawParameterName);
    const path = containsLocalAbsolutePath(decodedValue) &&
      !isAllowedRootRelativeUrlControl(parameterName, decodedValue);
    if (!secret && !path) continue;
    output += value.slice(cursor, start) + (secret ? secretReplacement : pathReplacement);
    cursor = end;
    matcher.lastIndex = end;
  }

  return output + value.slice(cursor);
}

function classificationPathEnd(value: string, start: number): number {
  let hardEnd = start;
  while (hardEnd < value.length) {
    const current = codePointAt(value, hardEnd);
    if (
      current === ';' || current === '\r' || current === '\n' ||
      current === '\x60' || current === '"' || current === '<' || current === '>' ||
      current === '\u201c' || current === '\u201d'
    ) break;
    hardEnd += current.length;
  }
  const segment = value.slice(start, hardEnd);
  const extensionMatcher = /\.[\p{L}\p{N}]{1,12}/giu;
  let extension: RegExpExecArray | null;
  while ((extension = extensionMatcher.exec(segment)) !== null) {
    const end = extension.index + extension[0].length;
    const after = segment.slice(end);
    if (
      after === '' ||
      /^[)\]}>;,:]/u.test(after) ||
      /^\s+(?:was|is|were|are|does|could|can|not|already|search|no|cancel|abort|then|while|because|and|but|retry|at|in|for)\b/iu.test(after)
    ) {
      return start + end;
    }
  }
  const outcomeBoundary = segment.match(
    /\s+(?=(?:(?:was|is|were|are)(?:\s+not|n['\u2019]t)\s+(?:found|available|ready|running)|(?:was|is|were|are)\s+(?:unavailable|cancelled|canceled|aborted)|does(?:\s+not|n['\u2019]t)\s+exist|(?:could|can)(?:\s+not|n['\u2019]t)\s+be\s+found|not\s+found|not\s+ready|not\s+running|cannot\s+connect|already\s+exists|search\s+text\s+not\s+found|no\s+changes?\s+made|cancel(?:led|ed)|abort(?:ed)?))/iu
  );
  return outcomeBoundary?.index !== undefined ? start + outcomeBoundary.index : hardEnd;
}

function maskAbsolutePathsForClassification(value: string): string {
  let output = '';
  let cursor = 0;
  let searchFrom = 0;
  while (searchFrom < value.length) {
    const start = findAbsolutePathStart(value, searchFrom);
    if (start < 0) break;
    const end = classificationPathEnd(value, start);
    output += value.slice(cursor, start) + CLASSIFICATION_PATH_REDACTION;
    cursor = Math.max(end, start + codePointAt(value, start).length);
    searchFrom = cursor;
  }
  return output + value.slice(cursor);
}

function maskHttpUrlsForClassification(value: string): string {
  return value.replace(/\bhttps?:\/\/[^\s"<>]+/gi, '[url]');
}

function redactBearerValues(value: string, replacement: string): string {
  return value.replace(/\bBearer\s*\S+/gi, `Bearer ${replacement}`);
}

function rawBoundaryForShadowIndex(
  raw: string,
  shadow: MappedDetectionShadow,
  index: number
): number {
  return index >= shadow.text.length
    ? raw.length
    : shadow.rawStarts[index] ?? raw.length;
}

function mappedHttpUrlRanges(
  raw: string,
  shadow: MappedDetectionShadow
): ShadowRange[] {
  const ranges: ShadowRange[] = [];
  const matcher = /\bhttps?:\/\//gi;
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(shadow.text)) !== null) {
    const start = match.index;
    let end = matcher.lastIndex;
    while (end < shadow.text.length) {
      const current = codePointAt(shadow.text, end);
      if (
        /[\p{Cc}\s"<>]/u.test(current) &&
        shadowSyntaxIsLiteral(raw, shadow, end, current)
      ) break;
      end += current.length;
    }
    ranges.push({ start, end });
    matcher.lastIndex = Math.max(end, matcher.lastIndex);
  }
  return ranges;
}

function maskMappedHttpUrls(value: string): string {
  const shadow = mappedUrlBoundaryShadow(value);
  const edits = mappedHttpUrlRanges(value, shadow).map(range => ({
    start: rawBoundaryForShadowIndex(value, shadow, range.start),
    end: rawBoundaryForShadowIndex(value, shadow, range.end),
    replacement: '[url]',
  }));
  return applyRawEdits(value, edits);
}

function containsMappedLocalAbsolutePath(value: string): boolean {
  return containsLocalAbsolutePath(maskMappedHttpUrls(value));
}

function shadowSyntaxIsLiteral(
  raw: string,
  shadow: MappedDetectionShadow,
  index: number,
  syntax: string
): boolean {
  const start = shadow.rawStarts[index];
  const end = shadow.rawEnds[index];
  if (start === undefined || end === undefined) return false;
  return structuralCharacter(raw.slice(start, end)) === syntax;
}

function skipRawWhitespace(value: string, start: number): number {
  let index = start;
  while (
    index < value.length &&
    /\s/u.test(structuralCharacter(codePointAt(value, index)))
  ) {
    index += codePointAt(value, index).length;
  }
  return index;
}

function rawUrlValueEnd(value: string, start: number): number {
  let index = start;
  while (index < value.length) {
    const rawCurrent = codePointAt(value, index);
    const current = structuralCharacter(rawCurrent);
    if (
      current === '&' || current === '#' || current === ';' ||
      current === '\r' || current === '\n' || current === '"' ||
      current === '<' || current === '>'
    ) break;
    index += rawCurrent.length;
  }
  return index;
}

function mappedSensitiveValueEnd(
  raw: string,
  shadow: MappedDetectionShadow,
  start: number
): number {
  let index = start;
  let quote = '';
  let escaped = false;
  while (index < shadow.text.length) {
    const current = codePointAt(shadow.text, index);
    if (escaped) {
      escaped = false;
    } else if (current === '\\' && quote !== '') {
      escaped = true;
    } else if (quote !== '') {
      if (
        (quote === GENERIC_QUOTE_CLOSE && closesGenericQuotedValue(shadow.text, index)) ||
        (quote !== GENERIC_QUOTE_CLOSE && closesQuotedValue(shadow.text, index, quote))
      ) quote = '';
    } else if (QUOTE_PAIRS.has(current)) {
      quote = QUOTE_PAIRS.get(current) ?? '';
    } else if (/[\p{Pi}\p{Ps}]/u.test(current)) {
      quote = GENERIC_QUOTE_CLOSE;
    } else if (
      (current === ';' || current === '&' || current === '#') &&
      shadowSyntaxIsLiteral(raw, shadow, index, current)
    ) {
      return rawBoundaryForShadowIndex(raw, shadow, index);
    }
    index += current.length;
  }
  return raw.length;
}

function mappedAssignmentEdits(
  raw: string,
  shadow: MappedDetectionShadow,
  replacement: string
): RawEdit[] {
  const edits: RawEdit[] = [];
  let index = 0;
  while (index < shadow.text.length) {
    const current = codePointAt(shadow.text, index);
    if (
      (current === '=' || current === ':') &&
      hasSecretAssignmentLabel(shadow.text, index)
    ) {
      const separatorEnd = shadow.rawEnds[index];
      if (separatorEnd !== undefined) {
        const start = skipRawWhitespace(raw, separatorEnd);
        let shadowStart = index + current.length;
        while (
          shadowStart < shadow.text.length &&
          /\s/u.test(codePointAt(shadow.text, shadowStart))
        ) {
          shadowStart += codePointAt(shadow.text, shadowStart).length;
        }
        const end = mappedSensitiveValueEnd(raw, shadow, shadowStart);
        if (end > start) edits.push({ start, end, replacement });
      }
    }
    index += current.length;
  }
  return edits;
}

function mappedUriUserinfoEdits(
  raw: string,
  shadow: MappedDetectionShadow,
  replacement: string
): RawEdit[] {
  const edits: RawEdit[] = [];
  const matcher = /\b[a-z](?:[\p{Cc}\p{Cf}]*[a-z0-9+.-])*[\p{Cc}\p{Cf}]*:[\p{Cc}\p{Cf}]*\/[\p{Cc}\p{Cf}]*\//giu;
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(shadow.text)) !== null) {
    const authorityStart = matcher.lastIndex;
    let index = authorityStart;
    let finalAt = -1;
    while (index < shadow.text.length) {
      const current = codePointAt(shadow.text, index);
      if (
        /[/?#\s"<>]/u.test(current) &&
        !/[\p{Cc}\p{Cf}]/u.test(current) &&
        shadowSyntaxIsLiteral(raw, shadow, index, current)
      ) break;
      if (current === '@') finalAt = index;
      index += current.length;
    }
    if (finalAt >= authorityStart) {
      const start = rawBoundaryForShadowIndex(raw, shadow, authorityStart);
      const end = rawBoundaryForShadowIndex(raw, shadow, finalAt);
      if (end > start) edits.push({ start, end, replacement });
    }
    matcher.lastIndex = Math.max(index, matcher.lastIndex);
  }
  return edits;
}

function mappedUrlParameterEdits(
  raw: string,
  shadow: MappedDetectionShadow,
  secretReplacement: string,
  pathReplacement: string
): RawEdit[] {
  const edits: RawEdit[] = [];
  const matcher = /[?&#;](?:[^=\s&#;]|[\p{Cc}\p{Cf}])+=/gu;
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(shadow.text)) !== null) {
    const valueStart = matcher.lastIndex;
    const rawParameterName = match[0].slice(1, -1);
    const parameterName = normalizeUrlParameterName(rawParameterName);
    let valueEnd = valueStart;
    while (valueEnd < shadow.text.length) {
      const current = codePointAt(shadow.text, valueEnd);
      if (
        /[&#;"<>]/u.test(current) &&
        shadowSyntaxIsLiteral(raw, shadow, valueEnd, current)
      ) break;
      valueEnd += current.length;
    }
    const decodedValue = shadow.text.slice(valueStart, valueEnd);
    const secret = isSensitiveLabel(rawParameterName);
    const path = containsLocalAbsolutePath(decodedValue) &&
      !isAllowedRootRelativeUrlControl(parameterName, decodedValue);
    if (!secret && !path) continue;

    const separatorIndex = valueStart - 1;
    const start = shadow.rawEnds[separatorIndex];
    if (start === undefined) continue;
    const end = valueEnd < shadow.text.length
      ? rawBoundaryForShadowIndex(raw, shadow, valueEnd)
      : rawUrlValueEnd(raw, start);
    if (end > start) {
      edits.push({
        start,
        end,
        replacement: secret ? secretReplacement : pathReplacement,
      });
    }
  }
  return edits;
}

function mappedBearerEdits(
  raw: string,
  shadow: MappedDetectionShadow,
  replacement: string
): RawEdit[] {
  const edits: RawEdit[] = [];
  const matcher = /\bB[\p{Cc}\p{Cf}]*e[\p{Cc}\p{Cf}]*a[\p{Cc}\p{Cf}]*r[\p{Cc}\p{Cf}]*e[\p{Cc}\p{Cf}]*r[\s\p{Cf}]*/giu;
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(shadow.text)) !== null) {
    const tokenStart = matcher.lastIndex;
    if (tokenStart >= shadow.text.length) continue;
    const start = rawBoundaryForShadowIndex(raw, shadow, match.index);
    const end = mappedSensitiveValueEnd(raw, shadow, tokenStart);
    if (end > start) edits.push({
      start,
      end,
      replacement: `Bearer ${replacement}`,
    });
  }
  return edits;
}

function redactionPriority(replacement: string): number {
  if (replacement === '') return 0;
  if (replacement === CLASSIFICATION_PATH_REDACTION || replacement === '[path]') return 1;
  return 2;
}

function applyRawEdits(value: string, edits: RawEdit[]): string {
  const ordered = edits
    .filter(edit => edit.start >= 0 && edit.end > edit.start && edit.end <= value.length)
    .sort((left, right) => left.start - right.start || right.end - left.end);
  const merged: RawEdit[] = [];
  for (const edit of ordered) {
    const previous = merged[merged.length - 1];
    if (!previous || edit.start >= previous.end) {
      merged.push({ ...edit });
      continue;
    }
    previous.end = Math.max(previous.end, edit.end);
    if (redactionPriority(edit.replacement) > redactionPriority(previous.replacement)) {
      previous.replacement = edit.replacement;
    }
  }

  let output = '';
  let cursor = 0;
  for (const edit of merged) {
    output += value.slice(cursor, edit.start) + edit.replacement;
    cursor = edit.end;
  }
  return output + value.slice(cursor);
}

function redactMappedSensitiveContent(
  value: string,
  secretReplacement: string,
  pathReplacement: string
): string {
  const shadow = mappedCredentialShadow(value);
  return applyRawEdits(value, [
    ...shadow.formatSpans,
    ...mappedAssignmentEdits(value, shadow, secretReplacement),
    ...mappedUriUserinfoEdits(value, shadow, secretReplacement),
    ...mappedUrlParameterEdits(
      value,
      shadow,
      secretReplacement,
      pathReplacement
    ),
    ...mappedBearerEdits(value, shadow, secretReplacement),
  ]);
}

export function sanitizeRecoveryString(
  value: unknown,
  limit = MAX_MESSAGE_CODEPOINTS
): string {
  const source = typeof value === 'string' ? value : String(value ?? '');
  const bounded = boundedCodePointPrefix(source, limit).text;
  let text = bounded.normalize('NFC');
  text = redactMappedSensitiveContent(text, '[redacted]', '[path]');
  text = text.replace(/\p{Cf}+/gu, '');
  text = redactUriUserinfo(text, '[redacted]');
  text = redactSensitiveUrlParameters(text);
  text = redactNormalizedSecretAssignments(text, '[redacted]');
  text = redactBearerValues(text, '[redacted]');
  if (containsMappedLocalAbsolutePath(text)) text = SENSITIVE_REDACTION;
  text = text
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return boundedCodePointPrefix(text, limit).text;
}

function classificationText(value: unknown): string {
  const source = typeof value === 'string' ? value : String(value ?? '');
  const bounded = boundedCodePointPrefix(source, MAX_MESSAGE_CODEPOINTS).text
    .normalize('NFC');
  const safeRaw = redactMappedSensitiveContent(
    bounded,
    CLASSIFICATION_SECRET_REDACTION,
    CLASSIFICATION_PATH_REDACTION
  );
  let text = detectionShadow(maskMappedHttpUrls(safeRaw));
  text = redactUriUserinfo(text, CLASSIFICATION_SECRET_REDACTION);
  text = redactSensitiveUrlParameters(
    text,
    CLASSIFICATION_SECRET_REDACTION,
    CLASSIFICATION_PATH_REDACTION
  );
  text = redactNormalizedSecretAssignments(text, CLASSIFICATION_SECRET_REDACTION);
  text = redactBearerValues(text, CLASSIFICATION_SECRET_REDACTION);
  text = maskHttpUrlsForClassification(text);
  text = maskAbsolutePathsForClassification(text);
  return text
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function classifierEvidence(
  values: string[],
  classifier: RegExp,
  pathDiagnostic = GENERAL_PATH_DIAGNOSTIC
): string | undefined {
  return values.find(value => (
    classifier.test(value) &&
    (!value.includes(CLASSIFICATION_PATH_REDACTION) || pathDiagnostic.test(value))
  ));
}

function sanitizeIdentifier(value: unknown): string {
  const identifier = sanitizeRecoveryString(value, MAX_IDENTIFIER_CODEPOINTS);
  return identifier === SENSITIVE_REDACTION ? '' : identifier;
}

function sanitizeCode(value: unknown): string {
  const sanitized = sanitizeRecoveryString(value, 80);
  if (!sanitized || sanitized === SENSITIVE_REDACTION) return 'tool_execution_failed';
  const code = sanitized
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return code || 'tool_execution_failed';
}

function sanitizeActionArguments(
  value: unknown
): Record<string, string | number | boolean | null> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const entries = Object.entries(value);
  if (entries.length === 0 || entries.length > MAX_ACTION_ARGUMENT_KEYS) return undefined;
  const result: Record<string, string | number | boolean | null> = {};
  for (const [rawKey, rawValue] of entries) {
    const key = sanitizeIdentifier(rawKey);
    if (!key || key !== rawKey || PROTOTYPE_SENSITIVE_KEYS.has(key)) return undefined;
    if (typeof rawValue === 'string') {
      const safeValue = sanitizeRecoveryString(rawValue, MAX_ACTION_ARGUMENT_CODEPOINTS);
      if (safeValue !== rawValue) return undefined;
      result[key] = safeValue;
    } else if (rawValue === null || typeof rawValue === 'boolean') {
      result[key] = rawValue;
    } else if (typeof rawValue === 'number' && Number.isFinite(rawValue)) {
      result[key] = Object.is(rawValue, -0) ? 0 : rawValue;
    } else {
      return undefined;
    }
  }
  return result;
}

function sanitizeLegacyFields(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result: Record<string, unknown> = {};
  for (const rawKey in value as Record<string, unknown>) {
    if (!Object.prototype.hasOwnProperty.call(value, rawKey)) continue;
    const rawValue = (value as Record<string, unknown>)[rawKey];
    const safeKey = sanitizeIdentifier(rawKey);
    if (!safeKey || !SAFE_LEGACY_KEYS.has(safeKey.toLowerCase())) continue;
    if (typeof rawValue === 'string') {
      result[safeKey] = sanitizeRecoveryString(rawValue);
    } else if (rawValue === null || typeof rawValue === 'boolean') {
      result[safeKey] = rawValue;
    } else if (typeof rawValue === 'number' && Number.isFinite(rawValue)) {
      result[safeKey] = Object.is(rawValue, -0) ? 0 : rawValue;
    }
    if (Object.keys(result).length >= 16) break;
  }
  return result;
}

function sanitizeMatches(values: unknown): string[] | undefined {
  if (!Array.isArray(values)) return undefined;
  const matches = values
    .slice(0, RECOVERY_MAX_MATCHES)
    .map(sanitizeIdentifier)
    .filter(Boolean);
  return matches;
}

function sanitizeActions(
  values: unknown,
  allowedActionTools?: ReadonlySet<string>,
  allowArguments = true
): RecoveryAction[] | undefined {
  if (!Array.isArray(values)) return undefined;
  const actions: RecoveryAction[] = [];
  for (const value of values.slice(0, RECOVERY_MAX_ACTIONS)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const candidate = value as Record<string, unknown>;
    if (typeof candidate.tool !== 'string' || typeof candidate.label !== 'string') continue;
    const tool = sanitizeIdentifier(candidate.tool);
    const label = sanitizeIdentifier(candidate.label);
    if (
      !tool ||
      !label ||
      tool !== candidate.tool ||
      label !== candidate.label ||
      (allowedActionTools && !allowedActionTools.has(tool))
    ) continue;
    let args: Record<string, string | number | boolean | null> | undefined;
    if (Object.prototype.hasOwnProperty.call(candidate, 'arguments')) {
      const rawArguments = candidate.arguments;
      if (!rawArguments || typeof rawArguments !== 'object' || Array.isArray(rawArguments)) {
        continue;
      }
      if (Object.keys(rawArguments).length > 0) {
        if (!allowArguments) continue;
        args = sanitizeActionArguments(rawArguments);
        if (!args) continue;
      }
    }
    actions.push({ label, tool, ...(args ? { arguments: args } : {}) });
  }
  return actions.length > 0 ? actions : undefined;
}

function safeRecoveryMessage(status: RecoveryStatus, code: string): string {
  const messages: Record<string, string> = {
    cancelled: 'The requested operation was cancelled.',
    cli_unavailable: 'The Obsidian CLI is not currently available.',
    destination_exists: 'The destination already exists.',
    index_required: 'The requested operation requires indexed content.',
    item_not_found: 'The requested item could not be found.',
    model_unavailable: 'The requested model is not currently available.',
    no_change: 'The request completed without changing state.',
    note_not_found: 'The requested note could not be found.',
    obsidian_unavailable: 'Obsidian is not currently available.',
    read_only_mode: 'The requested operation is unavailable in read-only mode.',
    section_not_found: 'The requested section could not be found.',
    vault_identity_unavailable: 'The requested vault identity could not be verified.',
    vault_not_found: 'The requested vault could not be found.',
    vault_unavailable: 'The requested vault is not currently available.',
  };
  if (messages[code]) return messages[code];
  switch (status) {
    case 'needs_action':
      return 'The request needs a corrective action before it can continue.';
    case 'no_change':
      return 'The request completed without changing state.';
    case 'unavailable':
      return 'A required provider is not currently available.';
    case 'conflict':
      return 'The requested operation conflicts with existing state.';
    case 'refused':
      return 'The requested operation was refused.';
    case 'cancelled':
      return 'The requested operation was cancelled.';
    case 'failed':
      return 'The requested tool could not complete.';
  }
}

function byteLength(value: Record<string, unknown>): number {
  return Buffer.byteLength(JSON.stringify(value, null, 2), 'utf8');
}

function fitRecoveryPayload(payload: Record<string, unknown>): Record<string, unknown> {
  if (byteLength(payload) <= RECOVERY_MAX_BYTES) return payload;

  const fitted = { ...payload };
  delete fitted.actions;
  if (byteLength(fitted) <= RECOVERY_MAX_BYTES) return fitted;
  delete fitted.closest_matches;
  delete fitted.suggestionTrust;
  if (byteLength(fitted) <= RECOVERY_MAX_BYTES) return fitted;
  delete fitted.hint;
  if (byteLength(fitted) <= RECOVERY_MAX_BYTES) return fitted;

  fitted.message = sanitizeRecoveryString(fitted.message, 256);
  fitted.requested = sanitizeRecoveryString(fitted.requested, 64);
  if (byteLength(fitted) <= RECOVERY_MAX_BYTES) return fitted;

  const minimal: Record<string, unknown> = {
    status: fitted.status,
    code: fitted.code,
    message: sanitizeRecoveryString(fitted.message, 128),
    retryable: fitted.retryable === true,
    sideEffects: fitted.sideEffects,
  };
  for (const key of ['error', 'tool', 'readOnly'] as const) {
    if (fitted[key] !== undefined) minimal[key] = fitted[key];
  }
  return minimal;
}

function finalizeRecoveryObject(
  input: RecoveryOutcomeInput | Record<string, unknown>,
  isError: boolean,
  allowedActionTools?: ReadonlySet<string>
): ToolResponse {
  const canonicalKeys = new Set([
    'status', 'code', 'message', 'retryable', 'sideEffects', 'requested',
    'closest_matches', 'hint', 'actions', 'suggestionTrust', 'legacy',
  ]);
  const implicitLegacy = Object.fromEntries(
    Object.entries(input).filter(([key]) => !canonicalKeys.has(key))
  );
  const legacySource = 'legacy' in input && input.legacy && typeof input.legacy === 'object'
    ? { ...implicitLegacy, ...input.legacy }
    : implicitLegacy;
  const legacy = sanitizeLegacyFields(legacySource);
  const statusValue = sanitizeRecoveryString(input.status, 32) as RecoveryStatus;
  const status = RECOVERY_STATUSES.has(statusValue) ? statusValue : 'failed';
  const sideEffectValue = input.sideEffects && typeof input.sideEffects === 'object'
    ? sanitizeRecoveryString((input.sideEffects as Record<string, unknown>).state, 16)
    : 'unknown';
  const sideEffectState: SideEffectState = (
    ['none', 'performed', 'possible', 'unknown'] as string[]
  ).includes(sideEffectValue) ? sideEffectValue as SideEffectState : 'unknown';
  const code = sanitizeCode(input.code);
  const sanitizedMessage = sanitizeRecoveryString(input.message);
  const message = sanitizedMessage && sanitizedMessage !== SENSITIVE_REDACTION
    ? sanitizedMessage
    : safeRecoveryMessage(status, code);

  const payload: Record<string, unknown> = {
    ...legacy,
    status,
    code,
    message,
    retryable: input.retryable === true,
    sideEffects: { state: sideEffectState },
  };

  const requested = sanitizeIdentifier(input.requested);
  if (requested) payload.requested = requested;
  const matches = sanitizeMatches(input.closest_matches ?? legacy.closest_matches);
  if (matches) payload.closest_matches = matches;
  const hint = sanitizeRecoveryString(input.hint ?? legacy.hint);
  if (hint && hint !== SENSITIVE_REDACTION) payload.hint = hint;
  const actions = sanitizeActions(input.actions, allowedActionTools, !input.suggestionTrust);
  if (actions) payload.actions = actions;
  if (matches && matches.length > 0 && input.suggestionTrust) {
    payload.suggestionTrust = {
      state: 'untrusted_identifiers',
      fields: ['closest_matches'],
    };
  }

  const fitted = fitRecoveryPayload(payload);
  return {
    content: [{ type: 'text', text: JSON.stringify(fitted, null, 2) }],
    isError,
    structuredContent: fitted,
  };
}

export function recoveryResponse(
  input: RecoveryOutcomeInput,
  isError = true
): ToolResponse {
  return finalizeRecoveryObject(input, isError);
}

export function isRecoveryOutcome(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const object = value as Record<string, unknown>;
  return (
    typeof object.status === 'string' &&
    RECOVERY_STATUSES.has(object.status as RecoveryStatus) &&
    typeof object.code === 'string' &&
    typeof object.message === 'string' &&
    typeof object.retryable === 'boolean' &&
    !!object.sideEffects &&
    typeof object.sideEffects === 'object'
  );
}

function parseResponseObject(response: ToolResponse): Record<string, unknown> | undefined {
  if (response.structuredContent && typeof response.structuredContent === 'object') {
    return response.structuredContent;
  }
  const text = response.content[0]?.text;
  if (!text || Buffer.byteLength(text, 'utf8') > MAX_EXISTING_JSON_BYTES) return undefined;
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function isGraphOrVaultDomainResult(toolName: string, value: Record<string, unknown>): boolean {
  if (toolName !== 'analyze_link_hierarchy' && toolName !== 'open_vault') return false;
  return (
    typeof value.status === 'string' &&
    (
      typeof value.decisionState === 'object' ||
      typeof value.providerState === 'object' ||
      ['decision_required', 'exact_unavailable', 'prepared', 'complete', 'cancelled', 'analysis_failed']
        .includes(value.status)
    )
  );
}

function annotationReadOnly(tool: Tool): boolean {
  return (tool.annotations as { readOnlyHint?: boolean } | undefined)?.readOnlyHint === true;
}

function inferExistingOutcome(
  tool: Tool,
  existing: Record<string, unknown> | undefined,
  rawText: string
): RecoveryOutcomeInput {
  const existingError = sanitizeRecoveryString(existing?.error);
  const existingMessage = sanitizeRecoveryString(existing?.message);
  const diagnosticValues = existing
    ? [existing.error, existing.message].filter((value): value is string => (
      typeof value === 'string'
    ))
    : (/^\s*[\[{]/u.test(rawText) ? [] : [rawText]);
  const classificationParts = diagnosticValues
    .map(classificationText)
    .filter(Boolean);
  const readOnlyEvidence = classifierEvidence(classificationParts, READ_ONLY_CLASSIFIER);
  const vaultIdentityEvidence = classifierEvidence(classificationParts, VAULT_IDENTITY_CLASSIFIER);
  const cancelledEvidence = classifierEvidence(
    classificationParts,
    CANCELLED_CLASSIFIER,
    CANCELLED_PATH_DIAGNOSTIC
  );
  const conflictEvidence = classifierEvidence(
    classificationParts,
    CONFLICT_CLASSIFIER,
    CONFLICT_PATH_DIAGNOSTIC
  );
  const noChangeEvidence = classifierEvidence(
    classificationParts,
    NO_CHANGE_CLASSIFIER,
    NO_CHANGE_PATH_DIAGNOSTIC
  );
  const notFoundEvidence = classifierEvidence(
    classificationParts,
    new RegExp(`${NOT_FOUND_CLASSIFIER.source}|no indexed content|missing required`, 'iu'),
    NOT_FOUND_PATH_DIAGNOSTIC
  );
  const unavailableEvidence = classifierEvidence(
    classificationParts,
    UNAVAILABLE_CLASSIFIER,
    UNAVAILABLE_PATH_DIAGNOSTIC
  );
  const readOnlyTool = annotationReadOnly(tool);
  const structuredErrorCode = existingError.toLowerCase();
  const declaredSideEffects = existing?.sideEffects && typeof existing.sideEffects === 'object'
    ? sanitizeRecoveryString((existing.sideEffects as Record<string, unknown>).state, 16)
    : '';
  const validDeclaredSideEffects = (
    ['none', 'performed', 'possible', 'unknown'] as string[]
  ).includes(declaredSideEffects)
    ? declaredSideEffects as SideEffectState
    : undefined;
  let status: RecoveryStatus = 'failed';
  let code = 'tool_execution_failed';
  let retryable = true;
  let sideEffects: SideEffectState = validDeclaredSideEffects ?? (readOnlyTool ? 'none' : 'unknown');

  if (readOnlyEvidence) {
    status = 'refused';
    code = 'read_only_mode';
    retryable = false;
    if (structuredErrorCode === 'read_only_mode') sideEffects = 'none';
  } else if (vaultIdentityEvidence) {
    status = 'refused';
    code = 'vault_identity_unavailable';
    retryable = true;
    if (structuredErrorCode === 'vault_identity_unavailable') sideEffects = 'none';
  } else if (cancelledEvidence) {
    status = 'cancelled';
    code = 'cancelled';
    retryable = true;
  } else if (conflictEvidence) {
    status = 'conflict';
    code = 'destination_exists';
    retryable = false;
  } else if (noChangeEvidence) {
    status = 'no_change';
    code = 'no_change';
    retryable = false;
  } else if (notFoundEvidence) {
    status = 'needs_action';
    code = notFoundEvidence.includes('vault') ? 'vault_not_found'
      : notFoundEvidence.includes('section') ? 'section_not_found'
        : notFoundEvidence.includes('indexed') ? 'index_required'
          : /\b(note|file|link)\b/.test(notFoundEvidence) ? 'note_not_found'
            : 'item_not_found';
    retryable = false;
  } else if (unavailableEvidence) {
    status = 'unavailable';
    code = unavailableEvidence.includes('vault')
      ? 'vault_unavailable'
      : unavailableEvidence.includes('ollama') || unavailableEvidence.includes('model')
      ? 'model_unavailable'
      : unavailableEvidence.includes('obsidian') && !unavailableEvidence.includes('cli')
        ? 'obsidian_unavailable'
        : 'cli_unavailable';
    retryable = true;
  }

  const message = existingMessage
    ? existingMessage
    : existingError
      ? existingError
      : status === 'needs_action'
        ? 'The requested item could not be resolved.'
        : status === 'unavailable'
          ? 'A required provider is not currently available.'
          : status === 'conflict'
            ? 'The requested operation conflicts with existing state.'
            : status === 'cancelled'
              ? 'The requested operation was cancelled.'
              : `The ${tool.name} tool could not complete.`;
  const legacy = existing ? { ...existing } : undefined;
  if (legacy) {
    delete legacy.status;
    delete legacy.code;
    delete legacy.message;
    delete legacy.retryable;
    delete legacy.sideEffects;
    delete legacy.actions;
    delete legacy.suggestionTrust;
  }
  const matches = sanitizeMatches(existing?.closest_matches);

  return {
    status,
    code,
    message: message || `The ${tool.name} tool could not complete.`,
    retryable,
    sideEffects: { state: sideEffects },
    ...(typeof existing?.requested === 'string' ? { requested: existing.requested } : {}),
    ...(matches ? { closest_matches: matches } : {}),
    ...(typeof existing?.hint === 'string' ? { hint: existing.hint } : {}),
    ...(matches && matches.length > 0 ? {
      suggestionTrust: {
        state: 'untrusted_identifiers',
        fields: ['closest_matches'],
      },
    } : {}),
    ...(legacy ? { legacy } : {}),
  };
}

export function normalizeToolResponse(
  tool: Tool,
  response: ToolResponse,
  context: RecoveryContext
): ToolResponse {
  const existing = parseResponseObject(response);
  if (existing && isGraphOrVaultDomainResult(tool.name, existing)) return response;

  const allowedActionTools = new Set(
    (context.applicableTools ?? context.enabledTools).map(candidate => candidate.name)
  );
  if (existing && isRecoveryOutcome(existing)) {
    return finalizeRecoveryObject(existing, response.isError, allowedActionTools);
  }
  if (!response.isError) return response;

  return finalizeRecoveryObject(
    inferExistingOutcome(tool, existing, response.content[0]?.text ?? ''),
    true,
    allowedActionTools
  );
}

export function unexpectedToolFailure(tool: Tool, error: unknown): ToolResponse {
  return recoveryResponse({
    status: 'failed',
    code: 'tool_execution_failed',
    message: `The ${tool.name} tool could not complete.`,
    retryable: true,
    sideEffects: { state: annotationReadOnly(tool) ? 'none' : 'unknown' },
    legacy: { tool: tool.name },
  });
}

function normalizedToolTokens(value: string): string[] {
  return value
    .normalize('NFC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function isOversizedForScoring(value: string): boolean {
  const bounded = boundedCodePointPrefix(value, MAX_IDENTIFIER_CODEPOINTS);
  if (bounded.truncated) return true;
  return normalizedToolTokens(bounded.text).length > MAX_SCORING_TOKENS;
}

function editDistance(a: string, b: string): number {
  const left = Array.from(a.toLowerCase());
  const right = Array.from(b.toLowerCase());
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= right.length; j += 1) {
      current[j] = left[i - 1] === right[j - 1]
        ? previous[j - 1]
        : 1 + Math.min(previous[j - 1], previous[j], current[j - 1]);
    }
    previous = current;
  }
  return previous[right.length];
}

function closestToolMatches(requested: string, tools: Tool[]): string[] {
  if (!requested || isOversizedForScoring(requested)) return [];
  const requestedTokens = normalizedToolTokens(requested);
  const expanded = new Set(requestedTokens);
  for (const token of requestedTokens) {
    for (const alias of TOKEN_ALIASES.get(token) ?? []) expanded.add(alias);
  }
  const hasMutatingIntent = requestedTokens.some(token => WRITE_INTENT.has(token));
  const normalizedRequested = requestedTokens.join('_');
  const preferred = COMMON_INTENT_ALIASES.get(normalizedRequested) ?? [];

  return tools
    .filter(tool => hasMutatingIntent || annotationReadOnly(tool))
    .map(tool => {
      const nameTokens = normalizedToolTokens(tool.name);
      const descriptionTokens = new Set(normalizedToolTokens(tool.description ?? ''));
      const nameOverlap = nameTokens.filter(token => expanded.has(token)).length;
      const descriptionOverlap = [...expanded].filter(token => descriptionTokens.has(token)).length;
      const distance = editDistance(normalizedRequested, tool.name.toLowerCase());
      const substring = tool.name.toLowerCase().includes(normalizedRequested) ||
        normalizedRequested.includes(tool.name.toLowerCase());
      const narrowingPenalty = nameTokens.some(token => NARROWING_TOKENS.has(token)) ? 12 : 0;
      const preferredIndex = preferred.indexOf(tool.name);
      const preferredBoost = preferredIndex >= 0 ? (preferred.length - preferredIndex) * 100 : 0;
      const score = nameOverlap * 10 + descriptionOverlap * 2 + (substring ? 8 : 0) +
        Math.max(0, 5 - distance) - narrowingPenalty + preferredBoost;
      return { name: tool.name, score, distance };
    })
    .filter(candidate => candidate.score >= 4 || candidate.distance <= 3)
    .sort((left, right) => (
      right.score - left.score ||
      left.distance - right.distance ||
      left.name.localeCompare(right.name)
    ))
    .slice(0, RECOVERY_MAX_MATCHES)
    .map(candidate => candidate.name);
}

function discoveryAction(enabledTools: Tool[]): RecoveryAction[] | undefined {
  if (!enabledTools.some(tool => tool.name === 'discover_tools')) return undefined;
  return [{ label: 'List available tools', tool: 'discover_tools', arguments: {} }];
}

export function unknownToolResponse(
  requestedValue: unknown,
  context: RecoveryContext,
  disabled = false
): ToolResponse {
  const rawRequested = typeof requestedValue === 'string' ? requestedValue : String(requestedValue ?? '');
  const candidateTools = context.applicableTools ?? context.enabledTools;
  const matches = disabled ? [] : closestToolMatches(rawRequested, candidateTools);
  return recoveryResponse({
    status: disabled ? 'unavailable' : 'needs_action',
    code: disabled ? 'tool_disabled' : 'unknown_tool',
    message: disabled
      ? 'The requested tool is disabled in this server instance.'
      : 'The requested tool is not registered in this server instance.',
    requested: rawRequested,
    closest_matches: matches,
    hint: 'Use discover_tools to inspect the enabled tool inventory before retrying.',
    actions: discoveryAction(context.enabledTools),
    retryable: false,
    sideEffects: { state: 'none' },
  });
}

export function toolResponseBody(response: ToolResponse): unknown {
  if (response.structuredContent) return response.structuredContent;
  return JSON.parse(response.content[0]?.text || '{}');
}
