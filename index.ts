import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { gradeAnswersWithRetry, initializeOpenAI } from "./src/aiGrader.js";
import { type Config, loadConfig, validateConfig } from "./src/config.js";
import { createContextLogger } from "./src/logger.js";
import { sortResultsAnswers, writeResults } from "./src/output.js";
import { processQuizFolder } from "./src/quizExtractor.js";
import { setMockMode, setSaveMockData } from "./src/textract.js";

const mainLogger = createContextLogger("main");

const argv = await yargs(hideBin(process.argv))
  .option("config", {
    type: "string",
    alias: "c",
    describe: "Path to YAML configuration file",
  })
  // Legacy CLI options (for backwards compatibility)
  .option("folder", {
    type: "string",
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
    describe: "Path to JSON file with question texts (optional, for better grading)",
  })
  .option("output", {
    type: "string",
    alias: "o",
    describe: "Output file path for results (default: console only)",
  })
  .help()
  .parse();

async function main() {
  let config: Config;
  let pages: string[] | undefined;
  let answerKey: Record<string, string> | null = null;
  let questions: Record<string, string> | null = null;

  // Load configuration from file or CLI args
  if (argv.config) {
    mainLogger.info("Using configuration file", { configPath: argv.config });
    config = await loadConfig(argv.config);
    validateConfig(config);
  } else {
    // Legacy mode: use CLI arguments
    if (!argv.folder) {
      mainLogger.error("Either --config or --folder must be specified");
      console.error("❌ Error: Either --config or --folder must be specified");
      console.error("Try: bun run index.ts --config config.yaml");
      console.error("Or:  bun run index.ts --folder ./answerSheets");
      process.exit(1);
    }

    mainLogger.info("Using CLI arguments (legacy mode)");
    pages = argv.pages as string[] | undefined;

    config = {
      input: {
        folder: argv.folder,
        pages,
        maxQuestions: argv.maxQ,
      },
      textract: {
        useMock: argv["use-mock"],
        saveMock: argv["save-mock"],
      },
      grading: argv.grade
        ? {
            enabled: true,
            answerKeyPath: argv["answer-key"] || "",
            questionsPath: argv.questions,
          }
        : undefined,
      output: argv.output ? [{ type: "file" as const, path: argv.output }] : [],
    };

    if (argv.grade && !argv["answer-key"]) {
      mainLogger.error("Grade mode requires answer key");
      console.error("❌ Error: --grade requires --answer-key to be specified");
      process.exit(1);
    }
  }

  mainLogger.info("Starting quiz marker application", {
    folder: config.input.folder,
    useMock: config.textract.useMock,
    saveMock: config.textract.saveMock,
    gradingEnabled: config.grading?.enabled || false,
    outputCount: config.output.length,
  });

  // Configure mock mode
  if (config.textract.saveMock) {
    setSaveMockData(true);
    console.log("💾 Mock save mode enabled - will save Textract responses\n");
  }
  if (config.textract.useMock) {
    setMockMode(true);
    console.log("📁 Mock mode enabled - will use saved Textract data\n");
  }

  // Load answer key and questions if grading is enabled
  if (config.grading?.enabled) {
    try {
      const answerKeyContent = await readFile(config.grading.answerKeyPath, "utf-8");
      answerKey = JSON.parse(answerKeyContent);
      mainLogger.info("Loaded answer key", {
        path: config.grading.answerKeyPath,
        questionCount: answerKey ? Object.keys(answerKey).length : 0,
      });
      console.log(`📝 Loaded answer key from: ${config.grading.answerKeyPath}`);
    } catch (err) {
      mainLogger.error("Failed to load answer key", { error: err });
      console.error(`❌ Failed to load answer key:`, err);
      process.exit(1);
    }

    if (config.grading.questionsPath) {
      try {
        const questionsContent = await readFile(config.grading.questionsPath, "utf-8");
        questions = JSON.parse(questionsContent);
        mainLogger.info("Loaded questions file", {
          path: config.grading.questionsPath,
          questionCount: questions ? Object.keys(questions).length : 0,
        });
        console.log(`📋 Loaded questions from: ${config.grading.questionsPath}`);
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

  // Get subdirectories
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

  try {
    const subdirectories = await getSubdirectories(config.input.folder);

    if (subdirectories.length === 0) {
      mainLogger.warn("No subdirectories found", {
        folder: config.input.folder,
      });
      console.warn("⚠️  No subdirectories found in:", config.input.folder);
      process.exit(0);
    }

    mainLogger.info("Found subdirectories", {
      count: subdirectories.length,
      subdirs: subdirectories.map((d) => path.basename(d)),
    });
    console.log(`Found ${subdirectories.length} subdirectories to process\n`);

    const results: Record<string, any> = {};

    for (const subdir of subdirectories) {
      const subdirName = path.basename(subdir);
      mainLogger.info("Starting processing", {
        student: subdirName,
        path: subdir,
      });
      console.log(`Processing: ${subdirName}...`);

      try {
        const result = await processQuizFolder(
          subdir,
          config.input.pages,
          config.input.maxQuestions || 100,
        );

        // Basic email sanity check
        if (result.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result.email)) {
          mainLogger.warn(`Suspicious email format for ${subdirName}`, {
            email: result.email,
          });
          console.warn(`  ⚠️  Email looks suspicious: ${result.email}`);
        }

        // AI Grading if enabled
        if (config.grading?.enabled && answerKey) {
          mainLogger.info(`Starting AI grading for ${subdirName}`);
          console.log(`  🤖 AI Grading in progress...`);
          try {
            const grading = await gradeAnswersWithRetry(
              questions || {},
              answerKey,
              result.answers,
              {
                model: config.grading.model || "gpt-4o-mini",
                temperature: config.grading.temperature || 0.3,
              },
            );

            result.grading = grading;

            const score = `${grading.correctAnswers}/${grading.totalQuestions}`;
            const percentage = ((grading.correctAnswers / grading.totalQuestions) * 100).toFixed(1);

            console.log(
              `  📊 Score: ${score} (${percentage}%) | Possible alternatives: ${grading.possibleAlternatives}`,
            );

            // Highlight potential alternatives
            if (grading.possibleAlternatives > 0) {
              mainLogger.info(
                `Found ${grading.possibleAlternatives} possible alternative answers for ${subdirName}`,
              );
              console.log(`  💡 Review these questions for alternative answers:`);
              grading.grades
                .filter((g) => !g.isCorrect && g.confidence === "low")
                .forEach((g) => {
                  console.log(
                    `     - ${g.question}: "${g.submittedAnswer}" (Expected: "${g.correctAnswer}")`,
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

    // Output results
    if (config.output.length > 0) {
      console.log("\n📤 Writing results to configured outputs...");
      await writeResults(results, config.output);
      console.log("✅ All outputs completed successfully\n");
    }

    // Always show console output (sorted numerically)
    console.log(`\n${"=".repeat(50)}`);
    console.log("ALL RESULTS:");
    console.log("=".repeat(50));
    const sortedResults = sortResultsAnswers(results);
    console.log(JSON.stringify(sortedResults, null, 2));
  } catch (err) {
    mainLogger.error("Fatal error during quiz processing", { error: err });
    console.error("Failed to process quizzes:", err);
    process.exit(1);
  }
}

main();
