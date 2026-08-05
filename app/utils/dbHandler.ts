import fs from 'fs';

let appConfig: Config | null = null;

async function readLast() {
  if (!fs.existsSync(__dirname + '/../../data/last.txt')) {
    fs.writeFileSync(__dirname + '/../../data/last.txt', '', 'utf8');
    return '';
  } else {
    const data = fs.readFileSync(__dirname + '/../../data/last.txt', 'utf8');
    return data;
  }
}

async function writeDate(date: Date) {
  fs.writeFileSync(__dirname + '/../../data/last.txt', date.toISOString(), 'utf8');
  return date;
}

async function readPersistData() {
  if (!fs.existsSync(__dirname + '/../../data/persist.json')) {
    fs.writeFileSync(__dirname + '/../../data/persist.json', JSON.stringify({}), 'utf8');
    return {};
  } else {
    const data = fs.readFileSync(__dirname + '/../../data/persist.json', 'utf8');
    return JSON.parse(data);
  }
}

async function writePersistDate(persistData: object) {
  fs.writeFileSync(__dirname + '/../../data/persist.json', JSON.stringify(persistData), 'utf8');
  return persistData;
}

async function initConfig() {
  try {
    const data = fs.readFileSync(__dirname + '/../../data/config.json', 'utf8');
    appConfig = JSON.parse(data);
    return JSON.parse(data);
  } catch (e) {
    if (String(e).startsWith('Error: ENOENT: no such file or directory')) {
      throw new Error('Config file not found.');
    }
  }

  return '';
}

async function readConfig() {
  if (!appConfig) throw new Error('Config not initialized.');
  return appConfig;
}

async function valueExists(value: string) {
  if (!fs.existsSync(__dirname + '/../../data/db.txt')) {
    fs.writeFileSync(__dirname + '/../../data/db.txt', '', 'utf8');
    return false;
  } else {
    const fileContent = fs.readFileSync(__dirname + '/../../data/db.txt', 'utf8');
    return fileContent.includes(value);
  }
}

async function writeValue(value: string) {
  const currentDate = new Date();
  fs.appendFileSync(
    __dirname + '/../../data/db.txt',
    currentDate.toISOString() + '|' + value + '\n',
    'utf8',
  );
  return value;
}

// Automatically cleanup old values from the file after 96 hours
async function cleanupOldValues() {
  if (!fs.existsSync(__dirname + '/../../data/db.txt')) {
    fs.writeFileSync(__dirname + '/../../data/db.txt', '', 'utf8');
    return false;
  }

  const currentDate = new Date();
  const oldFileContent = fs.readFileSync(__dirname + '/../../data/db.txt', 'utf8');
  let newFileContent = '';

  const fcLines: string[] = oldFileContent.split('\n');
  if (fcLines !== undefined) {
    for (const i in fcLines) {
      const lineItems: string[] = (fcLines[i] || '').split('|');
      if (lineItems !== undefined) {
        const lineDate = new Date((lineItems[0] || '').toString());
        const diffHours = getHoursDiffBetweenDates(lineDate, currentDate);

        if (diffHours <= 96) {
          newFileContent = newFileContent + (fcLines[i] || '') + '\n';
        }
      }
    }
  }

  fs.writeFileSync(__dirname + '/../../data/db.txt', newFileContent, 'utf8');
  return true;
}

const getHoursDiffBetweenDates = (dateInitial: Date, dateFinal: Date) =>
  (dateFinal.getTime() - dateInitial.getTime()) / (1000 * 3600);

export default {
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
