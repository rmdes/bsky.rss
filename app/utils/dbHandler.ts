import {readFile, writeFile, appendFile} from 'fs/promises';

// Reads filePath, returning the result of onRead(content). If the file doesn't
// exist yet, writes defaultContent and returns initResult instead - callers don't
// need their own access()-then-readFile()-then-catch-ENOENT boilerplate, and
// readFile's own ENOENT (rather than a separate existence check) is what triggers it.
async function readOrInit<T>(
  filePath: string,
  defaultContent: string,
  initResult: T,
  onRead: (content: string) => T | Promise<T>,
): Promise<T> {
  try {
    const content = await readFile(filePath, 'utf8');
    return await onRead(content);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      await writeFile(filePath, defaultContent, 'utf8');
      return initResult;
    }
    throw error;
  }
}

export function createDbHandler(dataRoot: string) {
  let appConfig: Config | null = null;

  async function readLast() {
    return readOrInit(`${dataRoot}/last.txt`, '', '', content => content);
  }

  async function writeDate(date: Date) {
    await writeFile(`${dataRoot}/last.txt`, date.toISOString(), 'utf8');
    return date;
  }

  async function readPersistData() {
    return readOrInit(`${dataRoot}/persist.json`, JSON.stringify({}), {}, content =>
      JSON.parse(content),
    );
  }

  async function writePersistDate(persistData: object) {
    await writeFile(`${dataRoot}/persist.json`, JSON.stringify(persistData), 'utf8');
    return persistData;
  }

  async function initConfig() {
    try {
      const data = await readFile(`${dataRoot}/config.json`, 'utf8');
      appConfig = JSON.parse(data);
      return JSON.parse(data);
    } catch (error) {
      if (error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error('Config file not found.');
      }
      throw new Error(
        `Failed to read config: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async function readConfig() {
    if (!appConfig) throw new Error('Config not initialized.');
    return appConfig;
  }

  async function valueExists(value: string) {
    return readOrInit(`${dataRoot}/db.txt`, '', false, fileContent => fileContent.includes(value));
  }

  async function writeValue(value: string) {
    const currentDate = new Date();
    await appendFile(`${dataRoot}/db.txt`, currentDate.toISOString() + '|' + value + '\n', 'utf8');
    return value;
  }

  // Automatically cleanup old values from the file after 96 hours
  async function cleanupOldValues() {
    return readOrInit(`${dataRoot}/db.txt`, '', false, async oldFileContent => {
      const currentDate = new Date();
      const newLines: string[] = [];

      const fcLines: string[] = oldFileContent.split('\n');
      for (const line of fcLines) {
        if (!line) continue;
        const lineItems: string[] = line.split('|');
        if (lineItems[0]) {
          const lineDate = new Date(lineItems[0]);
          const diffHours = getHoursDiffBetweenDates(lineDate, currentDate);

          if (diffHours <= 96) {
            newLines.push(line);
          }
        }
      }

      await writeFile(
        `${dataRoot}/db.txt`,
        newLines.length > 0 ? newLines.join('\n') + '\n' : '',
        'utf8',
      );
      return true;
    });
  }

  return {
    readLast,
    writeDate,
    readConfig,
    initConfig,
    writePersistDate,
    readPersistData,
    valueExists,
    writeValue,
    cleanupOldValues,
  };
}

export type DbHandler = ReturnType<typeof createDbHandler>;

const getHoursDiffBetweenDates = (dateInitial: Date, dateFinal: Date) =>
  (dateFinal.getTime() - dateInitial.getTime()) / (1000 * 3600);
