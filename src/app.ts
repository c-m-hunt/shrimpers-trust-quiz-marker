import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { gradeAnswersWithRetry, initializeOpenAI } from "./aiGrader.js";
import type { Config } from "./config.js";
import { createContextLogger } from "./logger.js";
import type { ProcessedResults } from "./output.js";
import { sortResultsAnswers, writeResults } from "./output.js";
import type { QuizResult } from "./quizExtractor.js";
import { processQuizFolder } from "./quizExtractor.js";
import { setMockMode, setSaveMockData } from "./textract.js";

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
 * Load answer key from file
 */
async function loadAnswerKey(
  filePath: string
): Promise<Record<string, string>> {
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
async function loadQuestions(
  filePath: string | undefined
): Promise<Record<string, string> | null> {
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
      error: err
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
 * Initialize AI grading system
 */
async function initializeGrading(config: Config): Promise<{
  answerKey: Record<string, string> | null;
  questions: Record<string, string> | null;
}> {
  if (!config.grading?.enabled) {
    return { answerKey: null, questions: null };
  }

  const answerKey = await loadAnswerKey(config.grading.answerKeyPath);
  const questions = await loadQuestions(config.grading.questionsPath);

  try {
    initializeOpenAI();
    logger.info("OpenAI initialized for AI grading");
  } catch (err) {
    logger.error("Failed to initialize OpenAI", { error: err });
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
      student: subdirName
    });
  }
}

/**
 * Grade quiz answers using AI
 */
async function gradeQuiz(
  subdirName: string,
  result: QuizResult,
  questions: Record<string, string> | null,
  answerKey: Record<string, string>,
  config: Config
): Promise<void> {
  if (!config.grading?.enabled) {
    return;
  }

  logger.info(`Starting AI grading for ${subdirName}`);

  try {
    const grading = await gradeAnswersWithRetry(
      questions || {},
      answerKey,
      result.answers,
      {
        model: config.grading.model || "gpt-4o-mini",
        temperature: config.grading.temperature || 0.3,
      }
    );

    result.grading = grading;

    const score = `${grading.correctAnswers}/${grading.totalQuestions}`;
    const percentage = (
      (grading.correctAnswers / grading.totalQuestions) *
      100
    ).toFixed(1);

    logger.info(`AI grading complete for ${subdirName}`, {
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
        { questionsToReview }
      );
    }
  } catch (err) {
    logger.error(`AI grading failed for ${subdirName}`, { error: err });
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
  questions: Record<string, string> | null
): Promise<QuizResult> {
  const subdirName = path.basename(subdir);
  logger.info("Starting processing", {
    student: subdirName,
    path: subdir,
  });

  try {
    const result = await processQuizFolder(
      subdir,
      config.input.pages,
      config.input.maxQuestions || 100
    );

    validateEmail(result.email, subdirName);

    if (config.grading?.enabled && answerKey) {
      await gradeQuiz(subdirName, result, questions, answerKey, config);
    }

    logger.info(`Completed processing for ${subdirName}`, {
      name: result.name,
      email: result.email,
      answerCount: Object.keys(result.answers).length,
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
  questions: Record<string, string> | null
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
    results[subdirName] = await processQuizSubdirectory(
      subdir,
      config,
      answerKey,
      questions
    );
  }

  logger.info("All processing complete", {
    totalProcessed: Object.keys(results).length,
    successful: Object.values(results).filter(
      (r) => Object.keys(r.answers).length > 0
    ).length,
    failed: Object.values(results).filter(
      (r) => Object.keys(r.answers).length === 0
    ).length,
  });

  return results;
}

/**
 * Output results to configured destinations
 */
async function outputResults(
  results: ProcessedResults,
  config: Config
): Promise<void> {
  if (config.output.length > 0) {
    logger.info("Writing results to configured outputs");
    await writeResults(results, config.output);
    logger.info("All outputs completed successfully");
  }

  // Always show results output (sorted numerically)
  const sortedResults = sortResultsAnswers(results);
  const separator = "=".repeat(50);
  logger.info(`\n${separator}\nALL RESULTS:\n${separator}\n${JSON.stringify(sortedResults, null, 2)}`);
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
