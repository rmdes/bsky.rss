// shared/feedSource/markdownLinks.ts

// [text](url) syntax for config.string/imageAlt, resolved by bsky.rss itself into
// hand-built app.bsky.richtext.facet#link facets - see
// documentation/specs/2026-08-08-markdown-links-design.md. @atproto/api has no Markdown
// parsing (confirmed by reading its detection.ts source directly); this module is the
// entire mechanism, not a wrapper around anything the library provides.
//
// Byte offsets are computed with Buffer.byteLength(str, 'utf8'), not string .length -
// AT Protocol facet indices are UTF-8 byte offsets, and @atproto/api's own UnicodeString
// class that does this conversion internally is not exported from its public API.
//
// Two-phase design: the caller (rssHandler.parseString) runs a bare-placeholder
// substitution pass ($title/$link/$description/$georss/mappedValues) on top of this
// module's own output, which changes the string's length and invalidates any byte
// offset computed before that pass runs. So this module splits into extractMarkdownLinks
// (before the bare pass: swap each [text](url) span for an opaque marker) and
// finalizeMarkdownLinks (after the bare pass: swap markers for resolved text and compute
// offsets against the final string). See extractMarkdownLinks/finalizeMarkdownLinks
// comments below for why each phase is where it is.

export interface MarkdownFacet {
  byteStart: number;
  byteEnd: number;
  uri: string;
}

interface PendingMarkdownLink {
  marker: string;
  displayText: string;
  uri: string | undefined;
}

export interface ExtractedMarkdownLinks {
  text: string;
  pending: PendingMarkdownLink[];
}

export interface MarkdownLinkResult {
  text: string;
  facets: MarkdownFacet[];
}

const MARKDOWN_LINK_PATTERN = /\[([^\]]*)\]\(([^)]*)\)/g;
const URL_PATTERN = /^https?:\/\//;
const PLACEHOLDER_TOKEN_PATTERN = /\$[a-zA-Z][a-zA-Z0-9]*/g;

function resolveTokens(text: string, resolve: (placeholder: string) => string | undefined): string {
  return text.replace(PLACEHOLDER_TOKEN_PATTERN, token => resolve(token) ?? token);
}

// Phase 1: replace each [text](url) span in the RAW template with a unique, opaque marker
// that cannot collide with $placeholder syntax or real feed content, so the caller's
// subsequent bare-placeholder substitution pass can run safely on the result without
// disturbing already-resolved bracket content, and without being fooled by feed content
// that happens to contain "$something" (that text now lives inside a marker's associated
// displayText, invisible to the bare-substitution pass entirely - it's only spliced back
// in by finalizeMarkdownLinks, after that pass has already finished).
//
// Byte offsets for facets cannot be computed yet here - the bare-placeholder pass hasn't
// run, so this span's final position in the text isn't known until finalizeMarkdownLinks
// (Phase 2) runs after it.
export function extractMarkdownLinks(
  template: string,
  resolve: (placeholder: string) => string | undefined,
): ExtractedMarkdownLinks {
  const pending: PendingMarkdownLink[] = [];
  let output = '';
  let cursor = 0;
  let index = 0;
  MARKDOWN_LINK_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = MARKDOWN_LINK_PATTERN.exec(template)) !== null) {
    output += template.slice(cursor, match.index);
    cursor = MARKDOWN_LINK_PATTERN.lastIndex;

    const displayText = resolveTokens(match[1] ?? '', resolve);
    const url = resolveTokens(match[2] ?? '', resolve);

    if (displayText.length === 0) continue; // span vanishes entirely, no marker, no facet

    const marker = ` MDLINK${index} `;
    index++;
    output += marker;
    pending.push({marker, displayText, uri: URL_PATTERN.test(url) ? url : undefined});
  }
  output += template.slice(cursor);

  return {text: output, pending};
}

// Phase 2: run after the caller's bare-placeholder substitution pass has completed on
// Phase 1's output text. Replaces each marker with its already-resolved display text and
// computes byte offsets against the growing final string - safe now because no further
// length-changing mutation happens to the text after this point (only truncation, which
// the caller handles separately by dropping any facet whose byteEnd falls outside it).
export function finalizeMarkdownLinks(
  text: string,
  pending: PendingMarkdownLink[],
): MarkdownLinkResult {
  const facets: MarkdownFacet[] = [];
  let output = text;
  for (const link of pending) {
    const markerIndex = output.indexOf(link.marker);
    if (markerIndex === -1) continue; // defensive: marker should always be present
    const before = output.slice(0, markerIndex);
    const after = output.slice(markerIndex + link.marker.length);
    if (link.uri) {
      const byteStart = Buffer.byteLength(before, 'utf8');
      const byteEnd = byteStart + Buffer.byteLength(link.displayText, 'utf8');
      facets.push({byteStart, byteEnd, uri: link.uri});
    }
    output = before + link.displayText + after;
  }
  return {text: output, facets};
}
