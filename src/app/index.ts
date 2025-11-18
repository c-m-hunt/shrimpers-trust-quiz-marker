import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { gradeAnswersWithRetry, initializeOpenAI } from "../aiGrader/index.js";
import type { Config } from "../config.js";
import { createContextLogger } from "../logger.js";
import type { ProcessedResults } from "../output/index.js";
import { sortResultsAnswers, writeResults } from "../output/index.js";
import type { QuizResult } from "../quizExtractor/index.js";
import { processQuizFolder } from "../quizExtractor/index.js";
import { setMockMode, setSaveMockData } from "../textract/index.js";
import {
  gradeQuizWithVisionRetry,
  initializeVisionGrader,
  type VisionGradingResult,
} from "../visionGrader/index.js";

const logger = createContextLogger("app");

/**
 * Get all subdirectories in a folder
 */
async function getSubdirectories(folderPath: string): Promise<string[]> {
  const entries = await readdir(folderPath);
  const subdirs: string[] = [];

  for (const entry of entries) {
    const fullPath = path.join(folderPath, entry);
    const stats = await stat(fullPath);
    if (stats.isDirectory()) {
      subdirs.push(fullPath);
    }
  }

  return subdirs.sort();
}

/**
 * Get all image files in a folder
 */
async function getImageFiles(folderPath: string): Promise<string[]> {
  const entries = await readdir(folderPath);
  const imageFiles = entries
    .filter((f) => /\.(jpg|jpeg|png|tiff|bmp)$/i.test(f))
    .sort()
    .map((f) => path.join(folderPath, f));

  return imageFiles;
}

/**
 * Load answer key from file
 */
async function loadAnswerKey(filePath: string): Promise<Record<string, string>> {
  try {
    const content = await readFile(filePath, "utf-8");
    const answerKey = JSON.parse(content);
    logger.info("Loaded answer key", {
      path: filePath,
      questionCount: Object.keys(answerKey).length,
    });
    return answerKey;
  } catch (err) {
    logger.error("Failed to load answer key", { error: err });
    throw err;
  }
}

/**
 * Load questions from file (optional)
 */
async function loadQuestions(filePath: string | undefined): Promise<Record<string, string> | null> {
  if (!filePath) {
    return null;
  }

  try {
    const content = await readFile(filePath, "utf-8");
    const questions = JSON.parse(content);
    logger.info("Loaded questions file", {
      path: filePath,
      questionCount: Object.keys(questions).length,
    });
    return questions;
  } catch (err) {
    logger.warn("Failed to load questions file", {
      path: filePath,
      error: err,
    });
    return null;
  }
}

/**
 * Configure Textract mock mode
 */
function configureMockMode(config: Config): void {
  if (config.textract.saveMock) {
    setSaveMockData(true);
    logger.info("Mock save mode enabled - will save Textract responses");
  }
  if (config.textract.useMock) {
    setMockMode(true);
    logger.info("Mock mode enabled - will use saved Textract data");
  }
}

/**
 * Initialize AI grading system and load answer key
 */
async function initializeGrading(config: Config): Promise<{
  answerKey: Record<string, string> | null;
  questions: Record<string, string> | null;
}> {
  // Always load answer key if path provided (used for OCR corrections even without grading)
  let answerKey: Record<string, string> | null = null;
  if (config.grading?.answerKeyPath) {
    try {
      answerKey = await loadAnswerKey(config.grading.answerKeyPath);
    } catch (err) {
      logger.warn("Answer key not loaded, OCR corrections will be skipped", {
        error: err,
      });
    }
  }

  if (!config.grading?.enabled) {
    return { answerKey, questions: null };
  }

  const strategy = config.grading.strategy || "vision";
  const questions = await loadQuestions(config.grading.questionsPath);

  try {
    if (strategy === "vision") {
      initializeVisionGrader();
      logger.info("Vision grader initialized", {
        model: config.grading.model || "gpt-4o",
      });
    } else {
      initializeOpenAI();
      logger.info("OpenAI initialized for textract-ai grading", {
        model: config.grading.model || "gpt-4o-mini",
      });
    }
  } catch (err) {
    logger.error("Failed to initialize grading system", { error: err });
    throw err;
  }

  return { answerKey, questions };
}

/**
 * Validate email format
 */
function validateEmail(email: string | undefined, subdirName: string): void {
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    logger.warn(`Suspicious email format for ${subdirName}`, {
      email,
      entry: subdirName,
    });
  }
}

/**
 * Convert vision grading result to standard grading result format
 */
function convertVisionGradingResult(visionResult: VisionGradingResult): QuizResult["grading"] {
  return {
    totalQuestions: visionResult.totalQuestions,
    correctAnswers: visionResult.correctAnswers,
    incorrectAnswers: visionResult.incorrectAnswers,
    possibleAlternatives: visionResult.grades.filter((g) => !g.is_correct && g.confidence < 60)
      .length,
    grades: visionResult.grades.map((g) => ({
      question: g.question_number,
      submittedAnswer: g.user_answer,
      correctAnswer: g.actual_answer,
      isCorrect: g.is_correct,
      confidence: g.confidence >= 80 ? "high" : g.confidence >= 60 ? "medium" : ("low" as const),
      notes: g.notes,
    })),
  };
}

/**
 * Process quiz using vision grading (direct image to AI)
 */
async function processQuizWithVision(
  subdirName: string,
  imagePaths: string[],
  answerKey: Record<string, string>,
  config: Config,
): Promise<QuizResult> {
  logger.info(`Processing ${subdirName} with vision grading`, {
    imageCount: imagePaths.length,
  });

  try {
    const visionResult = await gradeQuizWithVisionRetry(imagePaths, answerKey, {
      model: config.grading?.model || "gpt-4o",
      temperature: config.grading?.temperature || 0.3,
      maxTokens: config.grading?.maxTokens || 4096,
    });

    // Convert vision grades to answers format
    const answers: Record<string, string> = {};
    for (const grade of visionResult.grades) {
      answers[grade.question_number] = grade.user_answer;
    }

    const result: QuizResult = {
      answers,
      grading: convertVisionGradingResult(visionResult),
    };

    const score = `${visionResult.correctAnswers}/${visionResult.totalQuestions}`;
    const percentage = ((visionResult.correctAnswers / visionResult.totalQuestions) * 100).toFixed(
      1,
    );

    logger.info(`Vision grading complete for ${subdirName}`, {
      score,
      percentage: `${percentage}%`,
      lowConfidenceCount: visionResult.grades.filter((g) => g.confidence < 60).length,
    });

    // Highlight low confidence answers
    const lowConfidenceAnswers = visionResult.grades.filter((g) => g.confidence < 60);
    if (lowConfidenceAnswers.length > 0) {
      logger.warn(
        `Found ${lowConfidenceAnswers.length} answers with low confidence (<60%) for ${subdirName}`,
        {
          questions: lowConfidenceAnswers.map((g) => ({
            question: g.question_number,
            userAnswer: g.user_answer,
            confidence: g.confidence,
            notes: g.notes,
          })),
        },
      );
    }

    return result;
  } catch (err) {
    logger.error(`Vision grading failed for ${subdirName}`, { error: err });
    return {
      answers: {},
      grading: {
        error: String(err),
        totalQuestions: 0,
        correctAnswers: 0,
        incorrectAnswers: 0,
        possibleAlternatives: 0,
        grades: [],
      },
    };
  }
}

/**
 * Grade quiz answers using AI (textract-ai strategy)
 */
async function gradeQuiz(
  subdirName: string,
  result: QuizResult,
  questions: Record<string, string> | null,
  answerKey: Record<string, string>,
  config: Config,
): Promise<void> {
  if (!config.grading?.enabled) {
    return;
  }

  logger.info(`Starting textract-ai grading for ${subdirName}`);

  try {
    const grading = await gradeAnswersWithRetry(questions || {}, answerKey, result.answers, {
      model: config.grading.model || "gpt-4o-mini",
      temperature: config.grading.temperature || 0.3,
    });

    result.grading = grading;

    const score = `${grading.correctAnswers}/${grading.totalQuestions}`;
    const percentage = ((grading.correctAnswers / grading.totalQuestions) * 100).toFixed(1);

    logger.info(`Textract-ai grading complete for ${subdirName}`, {
      score,
      percentage: `${percentage}%`,
      possibleAlternatives: grading.possibleAlternatives,
    });

    // Highlight potential alternatives
    if (grading.possibleAlternatives > 0) {
      const questionsToReview = grading.grades
        .filter((g) => !g.isCorrect && g.confidence === "low")
        .map((g) => ({
          question: g.question,
          submittedAnswer: g.submittedAnswer,
          correctAnswer: g.correctAnswer,
          notes: g.notes,
        }));

      logger.info(
        `Found ${grading.possibleAlternatives} possible alternative answers for ${subdirName}`,
        { questionsToReview },
      );
    }
  } catch (err) {
    logger.error(`Textract-ai grading failed for ${subdirName}`, { error: err });
    result.grading = {
      error: String(err),
      totalQuestions: 0,
      correctAnswers: 0,
      incorrectAnswers: 0,
      possibleAlternatives: 0,
      grades: [],
    };
  }
}

/**
 * Process a single quiz subdirectory
 */
async function processQuizSubdirectory(
  subdir: string,
  config: Config,
  answerKey: Record<string, string> | null,
  questions: Record<string, string> | null,
): Promise<QuizResult> {
  const subdirName = path.basename(subdir);
  const strategy = config.grading?.strategy || "vision";

  logger.info("Starting processing", {
    entry: subdirName,
    path: subdir,
    strategy,
  });

  try {
    let result: QuizResult;

    // Choose processing strategy
    if (strategy === "vision" && config.grading?.enabled && answerKey) {
      // Vision strategy: Process images directly with vision model
      const imagePaths = await getImageFiles(subdir);
      if (imagePaths.length === 0) {
        throw new Error(`No image files found in ${subdir}`);
      }
      result = await processQuizWithVision(subdirName, imagePaths, answerKey, config);
    } else {
      // Textract-AI strategy: Use Textract OCR + AI grading
      result = await processQuizFolder(
        subdir,
        config.input.pages,
        config.input.maxQuestions || 100,
        answerKey || undefined,
      );

      validateEmail(result.email, subdirName);

      if (config.grading?.enabled && answerKey) {
        await gradeQuiz(subdirName, result, questions, answerKey, config);
      }
    }

    logger.info(`Completed processing for ${subdirName}`, {
      name: result.name,
      email: result.email,
      answerCount: Object.keys(result.answers).length,
      strategy,
    });

    return result;
  } catch (err) {
    logger.error(`Failed to process ${subdirName}`, { error: err });
    // Return a minimal valid QuizResult with error info
    return {
      answers: {},
      grading: {
        totalQuestions: 0,
        correctAnswers: 0,
        incorrectAnswers: 0,
        possibleAlternatives: 0,
        grades: [],
      },
    };
  }
}

/**
 * Process all quiz subdirectories
 */
async function processAllQuizzes(
  config: Config,
  answerKey: Record<string, string> | null,
  questions: Record<string, string> | null,
): Promise<ProcessedResults> {
  const subdirectories = await getSubdirectories(config.input.folder);

  if (subdirectories.length === 0) {
    logger.warn("No subdirectories found", {
      folder: config.input.folder,
    });
    return {};
  }

  logger.info("Found subdirectories", {
    count: subdirectories.length,
    subdirs: subdirectories.map((d) => path.basename(d)),
  });

  const results: ProcessedResults = {};

  for (const subdir of subdirectories) {
    const subdirName = path.basename(subdir);
    results[subdirName] = await processQuizSubdirectory(subdir, config, answerKey, questions);
  }

  logger.info("All processing complete", {
    totalProcessed: Object.keys(results).length,
    successful: Object.values(results).filter((r) => Object.keys(r.answers).length > 0).length,
    failed: Object.values(results).filter((r) => Object.keys(r.answers).length === 0).length,
  });

  return results;
}

/**
 * Output results to configured destinations
 */
async function outputResults(results: ProcessedResults, config: Config): Promise<void> {
  if (config.output.length > 0) {
    logger.info("Writing results to configured outputs");
    await writeResults(results, config.output);
    logger.info("All outputs completed successfully");
  }

  // Always show results output (sorted numerically)
  const sortedResults = sortResultsAnswers(results);
  const separator = "=".repeat(50);
  logger.info(
    `\n${separator}\nALL RESULTS:\n${separator}\n${JSON.stringify(sortedResults, null, 2)}`,
  );
}

/**
 * Main application entry point
 */
export async function runApp(config: Config): Promise<void> {
  logger.info("Starting quiz marker application", {
    folder: config.input.folder,
    useMock: config.textract.useMock,
    saveMock: config.textract.saveMock,
    gradingEnabled: config.grading?.enabled || false,
    outputCount: config.output.length,
  });

  configureMockMode(config);

  const { answerKey, questions } = await initializeGrading(config);

  const results = await processAllQuizzes(config, answerKey, questions);

  if (Object.keys(results).length === 0) {
    process.exit(0);
  }

  await outputResults(results, config);
}
