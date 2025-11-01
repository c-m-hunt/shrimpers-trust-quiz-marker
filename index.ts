import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { processQuizFolder } from "./src/quizExtractor.js";
import { setMockMode, setSaveMockData } from "./src/textract.js";
import { initializeOpenAI, gradeAnswersWithRetry } from "./src/aiGrader.js";
import { readdir, stat, readFile } from "fs/promises";
import path from "path";
import logger, { createContextLogger } from "./src/logger.js";

const mainLogger = createContextLogger("main");

const argv = await yargs(hideBin(process.argv))
  .option("folder", {
    type: "string",
    demandOption: true,
    describe: "Path to folder containing subdirectories with quiz images",
  })
  .option("pages", {
    type: "array",
    describe: "Optional explicit list of page filenames in order",
  })
  .option("maxQ", {
    type: "number",
    default: 100,
    describe: "Max question number to parse (Q1..Qn)",
  })
  .option("save-mock", {
    type: "boolean",
    default: false,
    describe: "Save Textract API responses to .textract folders for later use",
  })
  .option("use-mock", {
    type: "boolean",
    default: false,
    describe: "Use saved mock data instead of calling Textract API",
  })
  .option("grade", {
    type: "boolean",
    default: false,
    describe: "Enable AI grading with OpenAI (requires answer key)",
  })
  .option("answer-key", {
    type: "string",
    describe: "Path to JSON file with correct answers and questions",
  })
  .option("questions", {
    type: "string",
    describe:
      "Path to JSON file with question texts (optional, for better grading)",
  })
  .help()
  .parse();

const pages = (argv.pages as string[] | undefined) ?? undefined;

mainLogger.info("Starting quiz marker application", {
  folder: argv.folder,
  saveMock: argv["save-mock"],
  useMock: argv["use-mock"],
  grade: argv.grade,
  maxQ: argv.maxQ,
});

// Configure mock mode
if (argv["save-mock"]) {
  setSaveMockData(true);
  console.log("💾 Mock save mode enabled - will save Textract responses\n");
}
if (argv["use-mock"]) {
  setMockMode(true);
  console.log("📁 Mock mode enabled - will use saved Textract data\n");
}

// Load answer key and questions if grading is enabled
let answerKey: Record<string, string> | null = null;
let questions: Record<string, string> | null = null;

if (argv.grade) {
  if (!argv["answer-key"]) {
    mainLogger.error("Grade mode requires answer key");
    console.error("❌ Error: --grade requires --answer-key to be specified");
    process.exit(1);
  }

  try {
    const answerKeyContent = await readFile(argv["answer-key"], "utf-8");
    answerKey = JSON.parse(answerKeyContent);
    mainLogger.info("Loaded answer key", {
      path: argv["answer-key"],
      questionCount: answerKey ? Object.keys(answerKey).length : 0,
    });
    console.log(`📝 Loaded answer key from: ${argv["answer-key"]}`);
  } catch (err) {
    mainLogger.error("Failed to load answer key", { error: err });
    console.error(`❌ Failed to load answer key:`, err);
    process.exit(1);
  }

  if (argv.questions) {
    try {
      const questionsContent = await readFile(argv.questions, "utf-8");
      questions = JSON.parse(questionsContent);
      mainLogger.info("Loaded questions file", {
        path: argv.questions,
        questionCount: questions ? Object.keys(questions).length : 0,
      });
      console.log(`📋 Loaded questions from: ${argv.questions}`);
    } catch (err) {
      mainLogger.warn("Failed to load questions file", { error: err });
      console.warn(`⚠️  Failed to load questions file:`, err);
    }
  }

  // Initialize OpenAI
  try {
    initializeOpenAI();
    console.log("🤖 OpenAI initialized for AI grading\n");
  } catch (err) {
    mainLogger.error("Failed to initialize OpenAI", { error: err });
    console.error(`❌ Failed to initialize OpenAI:`, err);
    process.exit(1);
  }
}

async function getSubdirectories(folderPath: string): Promise<string[]> {
  mainLogger.debug(`Scanning for subdirectories in: ${folderPath}`);
  const entries = await readdir(folderPath);
  const subdirs: string[] = [];

  for (const entry of entries) {
    const fullPath = path.join(folderPath, entry);
    const stats = await stat(fullPath);
    if (stats.isDirectory()) {
      subdirs.push(fullPath);
    }
  }

  const sorted = subdirs.sort();
  mainLogger.info(`Found ${sorted.length} subdirectories`, {
    subdirs: sorted.map((s) => path.basename(s)),
  });
  return sorted;
}

try {
  const subdirectories = await getSubdirectories(argv.folder);

  if (subdirectories.length === 0) {
    mainLogger.warn("No subdirectories found", { folder: argv.folder });
    console.warn("⚠️  No subdirectories found in:", argv.folder);
    process.exit(0);
  }

  console.log(`Found ${subdirectories.length} subdirectories to process\n`);

  const results: Record<string, any> = {};

  for (const subdir of subdirectories) {
    const subdirName = path.basename(subdir);
    mainLogger.info(`Starting processing for ${subdirName}`, { path: subdir });
    console.log(`Processing: ${subdirName}...`);

    try {
      const result = await processQuizFolder(subdir, pages, argv.maxQ);

      // Basic email sanity check
      if (result.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result.email)) {
        mainLogger.warn(`Suspicious email format for ${subdirName}`, {
          email: result.email,
        });
        console.warn(`  ⚠️  Email looks suspicious: ${result.email}`);
      }

      // AI Grading if enabled
      if (argv.grade && answerKey) {
        mainLogger.info(`Starting AI grading for ${subdirName}`);
        console.log(`  🤖 AI Grading in progress...`);
        try {
          const grading = await gradeAnswersWithRetry(
            questions || {}, // Use empty object if no questions provided
            answerKey,
            result.answers,
            { model: "gpt-4o-mini" }
          );

          result.grading = grading;

          const score = `${grading.correctAnswers}/${grading.totalQuestions}`;
          const percentage = (
            (grading.correctAnswers / grading.totalQuestions) *
            100
          ).toFixed(1);

          console.log(
            `  📊 Score: ${score} (${percentage}%) | Possible alternatives: ${grading.possibleAlternatives}`
          );

          // Highlight potential alternatives
          if (grading.possibleAlternatives > 0) {
            mainLogger.info(
              `Found ${grading.possibleAlternatives} possible alternative answers for ${subdirName}`
            );
            console.log(`  💡 Review these questions for alternative answers:`);
            grading.grades
              .filter((g) => !g.isCorrect && g.confidence === "low")
              .forEach((g) => {
                console.log(
                  `     - ${g.question}: "${g.submittedAnswer}" (Expected: "${g.correctAnswer}")`
                );
                if (g.notes) console.log(`       Note: ${g.notes}`);
              });
          }
        } catch (err) {
          mainLogger.error(`AI grading failed for ${subdirName}`, {
            error: err,
          });
          console.error(`  ❌ AI grading failed:`, err);
          result.grading = {
            error: String(err),
          } as any;
        }
      }

      results[subdirName] = result;
      mainLogger.info(`Completed processing for ${subdirName}`, {
        name: result.name,
        email: result.email,
        answerCount: Object.keys(result.answers).length,
      });
      console.log(`  ✓ Completed: ${subdirName}\n`);
    } catch (err) {
      mainLogger.error(`Failed to process ${subdirName}`, { error: err });
      console.error(`  ✗ Failed to process ${subdirName}:`, err);
      results[subdirName] = { error: String(err) };
    }
  }

  mainLogger.info("All processing complete", {
    totalProcessed: Object.keys(results).length,
    successful: Object.values(results).filter((r) => !r.error).length,
    failed: Object.values(results).filter((r) => r.error).length,
  });

  console.log("\n" + "=".repeat(50));
  console.log("ALL RESULTS:");
  console.log("=".repeat(50));
  console.log(JSON.stringify(results, null, 2));
} catch (err) {
  mainLogger.error("Fatal error during quiz processing", { error: err });
  console.error("Failed to process quizzes:", err);
  process.exit(1);
}
