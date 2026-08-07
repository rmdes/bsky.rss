interface Config {
  string: string;
  publishEmbed?: boolean;
  embedType?: string;
  languages: string[];
  truncate?: boolean;
  runInterval: number;
  dateField?: string;
  publishDate?: boolean;
  imageField?: string;
  mappedValues?: Array<{key: string; value: string}>;
  ogUserAgent: string;
  descriptionClearHTML?: boolean;
  forceDescriptionEmbed?: boolean;
  imageAlt?: string;
  removeDuplicate?: boolean;
  titleClearHTML?: boolean;
  adaptiveSpacing?: boolean;
  spacingWindow?: number;
  minSpacing?: number;
  maxSpacing?: number;
}

interface ParseResult {
  text: string;
}

interface Embed {
  uri: string;
  title: string;
  description?: string;
  image?: Buffer;
  imageAlt?: string;
  type?: string;
}

interface QueueItems {
  content: string;
  embed: Embed | undefined;
  languages: string[] | undefined;
  title: string;
  date: string;
}
