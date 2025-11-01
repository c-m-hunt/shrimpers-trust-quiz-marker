# st-quiz-marker

A tool to process quiz answer sheets using AWS Textract.

## Installation

```bash
bun install
```

## Usage

### Process all subdirectories in a folder

```bash
bun run index.ts --folder ./answerSheets
```

### Save Textract API responses as mock data

On the first run, save the Textract API responses to avoid repeated API calls:

```bash
bun run index.ts --folder ./answerSheets --save-mock
```

This will create `.textract/` folders in each subdirectory with JSON files containing the raw Textract responses.

### Use saved mock data

After saving mock data, you can work offline and iterate on your logic without calling the API:

```bash
bun run index.ts --folder ./answerSheets --use-mock
```

### AI-Powered Grading

Grade answers with tolerance for spelling errors and identify valid alternative answers:

```bash
bun run index.ts --folder ./answerSheets --use-mock --grade --answer-key ./answer-key.json
```

With question texts for better context:

```bash
bun run index.ts --folder ./answerSheets --use-mock --grade --answer-key ./answer-key.json --questions ./questions.json
```

The AI grader will:
- ✅ Accept spelling variations (e.g., "Parris" = "Paris")
- ✅ Recognize synonyms and equivalent answers (e.g., "H2O" = "water")
- 💡 Flag potentially valid alternative answers with notes
- 📊 Provide confidence levels (high/medium/low)

**Setup:**
1. Set your OpenAI API key: `export OPENAI_API_KEY=sk-...`
2. Create an `answer-key.json` with correct answers (see `answer-key.example.json`)
3. Optionally create a `questions.json` with question texts (see `questions.example.json`)

**Test the AI grading:**
```bash
bun run test-grading.ts
```
This will run a standalone test without needing any image files or Textract data.

### Additional options

- `--pages <file1> <file2> ...` - Explicitly specify the order of page files
- `--maxQ <number>` - Maximum question number to parse (default: 100)
- `--grade` - Enable AI grading (requires `--answer-key`)
- `--answer-key <path>` - Path to JSON file with correct answers
- `--questions <path>` - Path to JSON file with question texts (optional)

## Directory Structure

```
answerSheets/
  1/
    page-1.jpg
    page-2.jpg
    .textract/          # Created with --save-mock
      page-1.json
      page-2.json
  2/
    page-1.jpg
    page-2.jpg
    .textract/
      page-1.json
      page-2.json
```

## Logging

The application uses Winston for structured logging:
- **Console output**: Colored, timestamped logs for monitoring progress
- **Log files**: JSON-formatted logs stored in `logs/` directory
  - `logs/combined.log` - All log messages (info level and above)
  - `logs/error.log` - Error messages only

### Log Levels
Set the log level using the `LOG_LEVEL` environment variable:
```bash
LOG_LEVEL=debug bun run index.ts --folder ./2025/answerSheets --use-mock
```

Available levels: `error`, `warn`, `info` (default), `debug`

## Development

This project was created using `bun init` in bun v1.3.1. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.
# shrimpers-trust-quiz-marker
