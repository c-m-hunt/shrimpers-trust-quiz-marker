import { readFile } from "fs/promises";
import yaml from "js-yaml";
import { createContextLogger } from "./logger.js";

const logger = createContextLogger("config");

export type OutputConfig = {
  type: "file" | "googleSheets" | "excel";
  path?: string; // For file and excel outputs
  spreadsheetId?: string; // For Google Sheets
  sheetName?: string; // For Google Sheets
};

export type Config = {
  input: {
    folder: string;
    pages?: string[];
    maxQuestions?: number;
  };
  textract: {
    useMock?: boolean;
    saveMock?: boolean;
  };
  grading?: {
    enabled: boolean;
    answerKeyPath: string;
    questionsPath?: string;
    model?: string;
    temperature?: number;
  };
  output: OutputConfig[];
};

const defaultConfig = {
  input: {
    maxQuestions: 100,
  },
  textract: {
    useMock: false,
    saveMock: false,
  },
};

export async function loadConfig(configPath: string): Promise<Config> {
  logger.info(`Loading configuration from: ${configPath}`);

  try {
    const fileContent = await readFile(configPath, "utf-8");
    const config = yaml.load(fileContent) as Config;

    // Merge with defaults
    const mergedConfig: Config = {
      input: {
        ...defaultConfig.input,
        ...config.input,
      },
      textract: {
        ...defaultConfig.textract,
        ...config.textract,
      },
      grading: config.grading,
      output: config.output || [],
    };

    logger.info("Configuration loaded successfully", {
      inputFolder: mergedConfig.input.folder,
      useMock: mergedConfig.textract.useMock,
      gradingEnabled: mergedConfig.grading?.enabled || false,
      outputCount: mergedConfig.output.length,
    });

    return mergedConfig;
  } catch (error) {
    logger.error("Failed to load configuration", { error, configPath });
    throw new Error(`Failed to load config from ${configPath}: ${error}`);
  }
}

export function validateConfig(config: Config): void {
  logger.debug("Validating configuration");

  if (!config.input.folder) {
    throw new Error("config.input.folder is required");
  }

  if (config.grading?.enabled && !config.grading.answerKeyPath) {
    throw new Error("config.grading.answerKeyPath is required when grading is enabled");
  }

  if (config.output.length === 0) {
    logger.warn("No output configurations specified");
  }

  for (const output of config.output) {
    if (output.type === "file" && !output.path) {
      throw new Error("output.path is required for file output type");
    }
    if (output.type === "googleSheets" && (!output.spreadsheetId || !output.sheetName)) {
      throw new Error("output.spreadsheetId and output.sheetName are required for googleSheets output type");
    }
    if (output.type === "excel" && !output.path) {
      throw new Error("output.path is required for excel output type");
    }
  }

  logger.info("Configuration validated successfully");
}
