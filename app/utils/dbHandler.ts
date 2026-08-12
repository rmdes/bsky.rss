import {readFile, writeFile, appendFile, access} from 'fs/promises';
import {constants} from 'fs';

export function createDbHandler(dataRoot: string) {
  let appConfig: Config | null = null;

  async function readLast() {
    try {
      await access(`${dataRoot}/last.txt`, constants.F_OK);
      const data = await readFile(`${dataRoot}/last.txt`, 'utf8');
      return data;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        await writeFile(`${dataRoot}/last.txt`, '', 'utf8');
        return '';
      }
      throw error;
    }
  }

  async function writeDate(date: Date) {
    await writeFile(`${dataRoot}/last.txt`, date.toISOString(), 'utf8');
    return date;
  }

  async function readPersistData() {
    try {
      await access(`${dataRoot}/persist.json`, constants.F_OK);
      const data = await readFile(`${dataRoot}/persist.json`, 'utf8');
      return JSON.parse(data);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        await writeFile(`${dataRoot}/persist.json`, JSON.stringify({}), 'utf8');
        return {};
      }
      throw error;
    }
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
    try {
      await access(`${dataRoot}/db.txt`, constants.F_OK);
      const fileContent = await readFile(`${dataRoot}/db.txt`, 'utf8');
      return fileContent.includes(value);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        await writeFile(`${dataRoot}/db.txt`, '', 'utf8');
        return false;
      }
      throw error;
    }
  }

  async function writeValue(value: string) {
    const currentDate = new Date();
    await appendFile(`${dataRoot}/db.txt`, currentDate.toISOString() + '|' + value + '\n', 'utf8');
    return value;
  }

  // Automatically cleanup old values from the file after 96 hours
  async function cleanupOldValues() {
    try {
      await access(`${dataRoot}/db.txt`, constants.F_OK);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        await writeFile(`${dataRoot}/db.txt`, '', 'utf8');
        return false;
      }
      throw error;
    }

    const currentDate = new Date();
    const oldFileContent = await readFile(`${dataRoot}/db.txt`, 'utf8');
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
