import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { OutputConfig } from "./config.js";
import { createContextLogger } from "./logger.js";
import type { QuizResult } from "./quizExtractor.js";

const logger = createContextLogger("output");

export type ProcessedResults = Record<string, QuizResult>;

/**
 * Sort answer keys numerically (Q1, Q2, ... Q10, Q11, etc.)
 */
function sortAnswersNumerically(answers: Record<string, string>): Record<string, string> {
  const sortedEntries = Object.entries(answers).sort((a, b) => {
    // Extract numeric part from keys like "Q1", "Q10", "1.", "10.", etc.
    const numA = parseInt(a[0].match(/\d+/)?.[0] || "0", 10);
    const numB = parseInt(b[0].match(/\d+/)?.[0] || "0", 10);
    return numA - numB;
  });

  return Object.fromEntries(sortedEntries);
}

/**
 * Sort grading results numerically by question number
 */
function sortGradingResults(grades: any[]): any[] {
  return grades.sort((a, b) => {
    // Extract numeric part from question keys like "Q1", "Q10", etc.
    const numA = parseInt(a.question.match(/\d+/)?.[0] || "0", 10);
    const numB = parseInt(b.question.match(/\d+/)?.[0] || "0", 10);
    return numA - numB;
  });
}

/**
 * Sort all answers in results numerically
 */
export function sortResultsAnswers(results: ProcessedResults): ProcessedResults {
  const sorted: ProcessedResults = {};

  for (const [key, result] of Object.entries(results)) {
    sorted[key] = {
      ...result,
      answers: sortAnswersNumerically(result.answers),
      // Also sort grading results if present
      ...(result.grading && {
        grading: {
          ...result.grading,
          grades: sortGradingResults(result.grading.grades),
        },
      }),
    };
  }

  return sorted;
}

/**
 * Base interface for output handlers
 */
export interface OutputHandler {
  write(results: ProcessedResults): Promise<void>;
}

/**
 * File output handler - writes results to a JSON file
 */
export class FileOutputHandler implements OutputHandler {
  constructor(private filePath: string) {}

  async write(results: ProcessedResults): Promise<void> {
    logger.info(`Writing results to file: ${this.filePath}`);

    try {
      const dir = path.dirname(this.filePath);
      // Ensure directory exists
      await import("node:fs/promises").then((fs) => fs.mkdir(dir, { recursive: true }));

      // Sort answers numerically before writing
      const sortedResults = sortResultsAnswers(results);
      const jsonContent = JSON.stringify(sortedResults, null, 2);
      await writeFile(this.filePath, jsonContent, "utf-8");

      logger.info(`Successfully wrote results to ${this.filePath}`, {
        studentCount: Object.keys(results).length,
        fileSize: jsonContent.length,
      });
    } catch (error) {
      logger.error(`Failed to write file output`, {
        error,
        filePath: this.filePath,
      });
      throw error;
    }
  }
}

/**
 * Google Sheets output handler (placeholder for future implementation)
 */
export class GoogleSheetsOutputHandler implements OutputHandler {
  constructor(
    private spreadsheetId: string,
    private sheetName: string,
  ) {}

  async write(_results: ProcessedResults): Promise<void> {
    logger.info(`Writing results to Google Sheets`, {
      spreadsheetId: this.spreadsheetId,
      sheetName: this.sheetName,
    });

    // TODO: Implement Google Sheets API integration
    logger.warn("Google Sheets output not yet implemented");
    throw new Error("Google Sheets output is not yet implemented");
  }
}

/**
 * Excel output handler (placeholder for future implementation)
 */
export class ExcelOutputHandler implements OutputHandler {
  constructor(private filePath: string) {}

  async write(_results: ProcessedResults): Promise<void> {
    logger.info(`Writing results to Excel: ${this.filePath}`);

    // TODO: Implement Excel file generation
    logger.warn("Excel output not yet implemented");
    throw new Error("Excel output is not yet implemented");
  }
}

/**
 * Factory function to create output handlers from configuration
 */
export function createOutputHandler(config: OutputConfig): OutputHandler {
  logger.debug(`Creating output handler`, { type: config.type });

  switch (config.type) {
    case "file":
      if (!config.path) {
        throw new Error("File output requires 'path' configuration");
      }
      return new FileOutputHandler(config.path);

    case "googleSheets":
      if (!config.spreadsheetId || !config.sheetName) {
        throw new Error("Google Sheets output requires 'spreadsheetId' and 'sheetName'");
      }
      return new GoogleSheetsOutputHandler(config.spreadsheetId, config.sheetName);

    case "excel":
      if (!config.path) {
        throw new Error("Excel output requires 'path' configuration");
      }
      return new ExcelOutputHandler(config.path);

    default:
      throw new Error(`Unknown output type: ${(config as any).type}`);
  }
}

/**
 * Write results to all configured outputs
 */
export async function writeResults(
  results: ProcessedResults,
  outputConfigs: OutputConfig[],
): Promise<void> {
  logger.info(`Writing results to ${outputConfigs.length} output(s)`);

  const handlers = outputConfigs.map(createOutputHandler);
  const errors: Error[] = [];

  for (let i = 0; i < handlers.length; i++) {
    const handler = handlers[i];
    const config = outputConfigs[i];

    if (!handler || !config) continue;

    try {
      await handler.write(results);
      logger.info(`Output ${i + 1}/${handlers.length} completed successfully`, {
        type: config.type,
      });
    } catch (error) {
      logger.error(`Output ${i + 1}/${handlers.length} failed`, {
        type: config.type,
        error,
      });
      errors.push(error as Error);
    }
  }

  if (errors.length > 0) {
    logger.error(`${errors.length} output(s) failed`, {
      totalOutputs: handlers.length,
    });
    throw new Error(
      `${errors.length} output(s) failed: ${errors.map((e) => e.message).join(", ")}`,
    );
  }

  logger.info("All outputs completed successfully");
}
