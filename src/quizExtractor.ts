import path from "node:path";
import type { GradingResult } from "./aiGrader.js";
import { createContextLogger } from "./logger.js";
import {
  analyzeImageForForms,
  extractAnswers,
  extractKeyValues,
  extractTableAnswers,
  normaliseKV,
} from "./textract.js";

const logger = createContextLogger("quizExtractor");

export type QuizResult = {
  name?: string;
  email?: string;
  answers: Record<string, string>;
  grading?: GradingResult; // AI grading results if enabled
};

export async function processQuizFolder(
  folderPath: string,
  pageFiles?: string[], // if you want to control order; else we'll guess
  maxQuestions = 100,
  answerKey?: Record<string, string>,
): Promise<QuizResult> {
  logger.info(`Processing quiz folder: ${folderPath}`, { maxQuestions });

  const files = pageFiles
    ? pageFiles
    : (await import("node:fs/promises").then((fs) => fs.readdir(folderPath)))
        .filter((f) => /\.(jpg|jpeg|png|tiff|bmp)$/i.test(f))
        .sort();

  logger.info(`Found ${files.length} image files to process`, { files });

  const mergedAnswers: Record<string, string> = {};
  let name: string | undefined;
  let email: string | undefined;

  for (const f of files) {
    logger.debug(`Processing file: ${f}`);
    const full = path.join(folderPath, f);
    const blocks = await analyzeImageForForms(full);

    // Try table extraction first (for 6-column format)
    let answers = extractTableAnswers(blocks, maxQuestions, answerKey);

    // If no answers from table, fallback to key-value extraction
    if (Object.keys(answers).length === 0) {
      logger.debug(`No table answers found, falling back to KV extraction`);
      const kv = normaliseKV(extractKeyValues(blocks));

      // pick up name/email wherever they appear
      if (!name && kv.name) {
        name = kv.name;
        logger.info(`Found student name: ${name}`);
        delete kv.name; // Avoid it being processed as an answer
      }
      if (!email && kv.email) {
        email = kv.email;
        logger.info(`Found student email: ${email}`);
        delete kv.email; // Avoid it being processed as an answer
      }

      answers = extractAnswers(kv, maxQuestions);
    } else {
      // For table extraction, still try to get name/email from KV pairs
      const kv = normaliseKV(extractKeyValues(blocks));
      if (!name && kv.name) {
        name = kv.name;
        logger.info(`Found student name: ${name}`);
      }
      if (!email && kv.email) {
        email = kv.email;
        logger.info(`Found student email: ${email}`);
      }
    }

    Object.assign(mergedAnswers, answers);
    logger.debug(`Merged ${Object.keys(answers).length} answers from ${f}`);
  }

  logger.info(`Quiz processing complete`, {
    name,
    email,
    totalAnswers: Object.keys(mergedAnswers).length,
    pagesProcessed: files.length,
  });

  return {
    name,
    email,
    answers: mergedAnswers,
  };
}
