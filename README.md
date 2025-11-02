# shrimpers-trust-quiz-marker

A tool to process quiz answer sheets using AWS Textract with AI-powered grading.

## Installation

```bash
bun install
```

## Quick Start

### 1. Create a Configuration File

Copy the example configuration:
```bash
cp config.example.yaml config.yaml
```

Edit `config.yaml` to match your setup:
```yaml
input:
  folder: "./2025/answerSheets"
  maxQuestions: 100

textract:
  useMock: true
  saveMock: false

grading:
  enabled: true
  answerKeyPath: "./2025/answer-key.json"
  questionsPath: "./2025/questions.json"

output:
  - type: "file"
    path: "./output/results.json"
```

### 2. Run with Configuration File

```bash
bun run index.ts --config config.yaml
```

## Usage

### Using Configuration File (Recommended)

```bash
bun run index.ts --config config.yaml
```

### Using CLI Arguments (Legacy)

Process all subdirectories in a folder:

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

### CLI Options

- `--config, -c <path>` - Path to YAML configuration file (recommended)
- `--folder <path>` - Path to folder containing subdirectories with quiz images (legacy)
- `--output, -o <path>` - Output file path for results (legacy)
- `--pages <file1> <file2> ...` - Explicitly specify the order of page files
- `--maxQ <number>` - Maximum question number to parse (default: 100)
- `--grade` - Enable AI grading (requires `--answer-key`)
- `--answer-key <path>` - Path to JSON file with correct answers
- `--questions <path>` - Path to JSON file with question texts (optional)
- `--use-mock` - Use saved mock data instead of calling Textract API
- `--save-mock` - Save Textract API responses for later use

## Configuration File Format

The configuration file uses YAML format. See `config.example.yaml` for a complete example.

### Input Configuration
```yaml
input:
  folder: "./2025/answerSheets"  # Required
  pages: ["page-1.jpg", "page-2.jpg"]  # Optional: explicit page order
  maxQuestions: 100  # Optional: default 100
```

### Textract Configuration
```yaml
textract:
  useMock: true   # Use saved mock data
  saveMock: false # Save API responses
```

### Grading Configuration
```yaml
grading:
  enabled: true
  answerKeyPath: "./answer-key.json"  # Required
  questionsPath: "./questions.json"   # Optional
  model: "gpt-4o-mini"  # Optional: default "gpt-4o-mini"
  temperature: 0.3      # Optional: default 0.3
```

### Output Configuration

Multiple outputs can be configured:

```yaml
output:
  # File output (JSON)
  - type: "file"
    path: "./output/results.json"
  
  # Google Sheets (coming soon)
  # - type: "googleSheets"
  #   spreadsheetId: "your-spreadsheet-id"
  #   sheetName: "Quiz Results"
  
  # Excel (coming soon)
  # - type: "excel"
  #   path: "./output/results.xlsx"
```

Currently supported output types:
- ✅ **file** - JSON file output
- 🚧 **googleSheets** - Google Sheets integration (coming soon)
- 🚧 **excel** - Excel file output (coming soon)

## Directory Structure

```
project/
├── config.yaml              # Configuration file
├── answerSheets/
│   ├── 1/
│   │   ├── page-1.jpg
│   │   ├── page-2.jpg
│   │   └── .textract/      # Mock data (if enabled)
│   │       ├── page-1.json
│   │       └── page-2.json
│   └── 2/
│       ├── page-1.jpg
│       ├── page-2.jpg
│       └── .textract/
│           ├── page-1.json
│           └── page-2.json
├── answer-key.json
├── questions.json (optional)
├── output/                  # Results output directory
│   └── results.json
└── logs/                    # Application logs
    ├── combined.log
    └── error.log
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

## Migration Guide: CLI Args → Config File

If you're currently using CLI arguments, you can easily migrate to the configuration file approach:

**Before (CLI args):**
```bash
bun run index.ts \
  --folder ./answerSheets \
  --use-mock \
  --grade \
  --answer-key ./answer-key.json \
  --questions ./questions.json \
  --output ./results.json
```

**After (Config file):**

1. Create `config.yaml`:
```yaml
input:
  folder: "./answerSheets"

textract:
  useMock: true

grading:
  enabled: true
  answerKeyPath: "./answer-key.json"
  questionsPath: "./questions.json"

output:
  - type: "file"
    path: "./output/results.json"
```

2. Run with config:
```bash
bun run index.ts --config config.yaml
```

**Benefits:**
- ✅ Single source of truth for all configuration
- ✅ Version control friendly
- ✅ Multiple outputs supported
- ✅ Better for CI/CD pipelines
- ✅ Easier to share configurations

**Note:** CLI arguments are still supported for backward compatibility!

## Development

This project was created using `bun init` in bun v1.3.1. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.

