import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { runApp } from "./src/app.js";
import { type Config, loadConfig, validateConfig } from "./src/config.js";
import { createContextLogger } from "./src/logger.js";

const logger = createContextLogger("main");

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
    describe:
      "Path to JSON file with question texts (optional, for better grading)",
  })
  .option("output", {
    type: "string",
    alias: "o",
    describe: "Output file path for results (default: console only)",
  })
  .help()
  .parse();

/**
 * Build configuration from CLI arguments (legacy mode)
 */
function buildConfigFromArgs(argv: any): Config {
  const pages = argv.pages as string[] | undefined;

  return {
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
}

async function main() {
  let config: Config;

  try {
    // Load configuration from file or CLI args
    if (argv.config) {
      logger.info("Using configuration file", { configPath: argv.config });
      config = await loadConfig(argv.config);
      validateConfig(config);
    } else {
      // Legacy mode: use CLI arguments
      if (!argv.folder) {
        logger.error("Either --config or --folder must be specified");
        console.error(
          "❌ Error: Either --config or --folder must be specified"
        );
        console.error("Try: bun run index.ts --config config.yaml");
        console.error("Or:  bun run index.ts --folder ./answerSheets");
        process.exit(1);
      }

      logger.info("Using CLI arguments (legacy mode)");
      config = buildConfigFromArgs(argv);

      if (argv.grade && !argv["answer-key"]) {
        logger.error("Grade mode requires answer key");
        console.error(
          "❌ Error: --grade requires --answer-key to be specified"
        );
        process.exit(1);
      }
    }

    // Run the application
    await runApp(config);
  } catch (err) {
    logger.error("Fatal error during quiz processing", { error: err });
    console.error("Failed to process quizzes:", err);
    process.exit(1);
  }
}

main();
