import { access, readFile, writeFile, appendFile } from "fs/promises";
import { constants } from "fs";

let appConfig: any = null;

async function readLast() {
  const filePath = __dirname + "/../../data/last.txt";
  try {
    await access(filePath, constants.F_OK);
    const data = await readFile(filePath, "utf8");
    return data;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      await writeFile(filePath, "", "utf8");
      return "";
    }
    throw error;
  }
}

async function writeDate(date: Date) {
  await writeFile(
    __dirname + "/../../data/last.txt",
    date.toISOString(),
    "utf8"
  );
  return date;
}

async function readPersistData() {
  const filePath = __dirname + "/../../data/persist.json";
  try {
    await access(filePath, constants.F_OK);
    const data = await readFile(filePath, "utf8");
    return JSON.parse(data);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      await writeFile(filePath, JSON.stringify({}), "utf8");
      return {};
    }
    throw error;
  }
}

async function writePersistDate(persistData: any) {
  await writeFile(
    __dirname + "/../../data/persist.json",
    JSON.stringify(persistData),
    "utf8"
  );
  return persistData;
}

async function initConfig() {
  try {
    const data = await readFile(__dirname + "/../../data/config.json", "utf8");
    appConfig = JSON.parse(data);
    return JSON.parse(data);
  } catch (error: any) {
    if (error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error("Config file not found.");
    }
    throw new Error(`Failed to read config: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function readConfig() {
  if (!appConfig) throw new Error("Config not initialized.");
  return appConfig;
}

async function valueExists(value: string) {
  const filePath = __dirname + "/../../data/db.txt";
  try {
    await access(filePath, constants.F_OK);
    const fileContent = await readFile(filePath, "utf8");
    return fileContent.includes(value);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      await writeFile(filePath, "", "utf8");
      return false;
    }
    throw error;
  }
}

async function writeValue(value: string) {
  const currentDate = new Date();
  await appendFile(
    __dirname + "/../../data/db.txt",
    currentDate.toISOString() + "|" + value + "\n",
    "utf8"
  );
  return value;
}

// Automatically cleanup old values from the file after 96 hours
async function cleanupOldValues() {
  const filePath = __dirname + "/../../data/db.txt";

  try {
    await access(filePath, constants.F_OK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      await writeFile(filePath, "", "utf8");
      return false;
    }
    throw error;
  }

  const currentDate = new Date();
  const oldFileContent = await readFile(filePath, "utf8");
  const newLines: string[] = [];

  const fcLines: string[] = oldFileContent.split("\n");
  for (const line of fcLines) {
    if (!line) continue;

    const lineItems: string[] = line.split("|");
    if (lineItems.length >= 2 && lineItems[0]) {
      const lineDate = new Date(lineItems[0]);
      const diffHours = getHoursDiffBetweenDates(lineDate, currentDate);

      if (diffHours <= 96) {
        newLines.push(line);
      }
    }
  }

  await writeFile(filePath, newLines.join("\n") + (newLines.length > 0 ? "\n" : ""), "utf8");
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
