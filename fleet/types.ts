export interface BotWorkerConfig {
  botId: string;
  identifier: string;
  appPassword: string;
  instanceUrl: string;
  feedUrl: string;
  fetchIntervalMinutes: number;
  dbPath: string;
  postString: string;
  publishEmbed: boolean;
  embedType: string;
  languages: string[];
  truncate: boolean;
  runIntervalSeconds: number;
  removeDuplicate: boolean;
  titleClearHTML: boolean;
  descriptionClearHTML: boolean;
}
