import path from "node:path";
import type { GradingResult } from "./aiGrader.js";
import { createContextLogger } from "./logger.js";
import { analyzeImageForForms, extractAnswers, extractKeyValues, normaliseKV } from "./textract.js";

const logger = createContextLogger("quizExtractor");

export type QuizResult = {
  name?: string;
  email?: string;
  answers: Record<string, string>;
  raw: Array<Record<string, string>>; // KV per page (for debugging)
  grading?: GradingResult; // AI grading results if enabled
};

export async function processQuizFolder(
  folderPath: string,
  pageFiles?: string[], // if you want to control order; else we'll guess
  maxQuestions = 100,
): Promise<QuizResult> {
  logger.info(`Processing quiz folder: ${folderPath}`, { maxQuestions });

  const files = pageFiles
    ? pageFiles
    : (await import("node:fs/promises").then((fs) => fs.readdir(folderPath)))
        .filter((f) => /\.(jpg|jpeg|png|tiff|bmp)$/i.test(f))
        .sort();

  logger.info(`Found ${files.length} image files to process`, { files });

  const rawPages: Array<Record<string, string>> = [];
  const mergedAnswers: Record<string, string> = {};
  let name: string | undefined;
  let email: string | undefined;

  for (const f of files) {
    logger.debug(`Processing file: ${f}`);
    const full = path.join(folderPath, f);
    const blocks = await analyzeImageForForms(full);
    const kv = normaliseKV(extractKeyValues(blocks));
    rawPages.push(kv);

    // pick up name/email wherever they appear (usually page 1)
    if (!name && kv.name) {
      name = kv.name;
      logger.info(`Found student name: ${name}`);
    }
    if (!email && kv.email) {
      email = kv.email;
      logger.info(`Found student email: ${email}`);
    }

    const answers = extractAnswers(kv, maxQuestions);
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
    raw: rawPages,
  };
}
