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

export interface MarkdownFacet {
  byteStart: number;
  byteEnd: number;
  uri: string;
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

export function resolveMarkdownLinks(
  template: string,
  resolve: (placeholder: string) => string | undefined,
): MarkdownLinkResult {
  const facets: MarkdownFacet[] = [];
  let output = '';
  let cursor = 0;
  MARKDOWN_LINK_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = MARKDOWN_LINK_PATTERN.exec(template)) !== null) {
    output += template.slice(cursor, match.index);
    cursor = MARKDOWN_LINK_PATTERN.lastIndex;

    const displayText = resolveTokens(match[1] ?? '', resolve);
    const url = resolveTokens(match[2] ?? '', resolve);

    if (displayText.length === 0) continue; // span vanishes, no zero-length facet

    if (URL_PATTERN.test(url)) {
      const byteStart = Buffer.byteLength(output, 'utf8');
      output += displayText;
      const byteEnd = Buffer.byteLength(output, 'utf8');
      facets.push({byteStart, byteEnd, uri: url});
    } else {
      output += displayText; // degrade to plain, non-clickable text
    }
  }
  output += template.slice(cursor);

  return {text: output, facets};
}
