# Winston Logging Implementation

## Overview

Winston logger has been integrated throughout the application for better debugging, monitoring, and audit trails.

## Features

### 1. Structured Logging
- All logs include contextual metadata (timestamps, module names, metadata objects)
- JSON format in log files for easy parsing and analysis
- Human-readable colored output in console

### 2. Multiple Transports
- **Console**: Colored, timestamped output for development
- **combined.log**: All logs (info level and above)
- **error.log**: Error logs only for quick troubleshooting

### 3. Context-Based Loggers
Each module has its own context logger:
- `main` - Main application flow
- `textract` - Textract API calls and data extraction
- `aiGrader` - AI grading operations
- `quizExtractor` - Quiz processing logic

## Usage

### Setting Log Level
```bash
# Default (info)
bun run index.ts --folder ./2025/answerSheets --use-mock

# Debug mode (verbose)
LOG_LEVEL=debug bun run index.ts --folder ./2025/answerSheets --use-mock

# Errors only
LOG_LEVEL=error bun run index.ts --folder ./2025/answerSheets --use-mock
```

### Log Levels
1. **error**: Fatal errors and exceptions
2. **warn**: Warning messages (suspicious data, retries)
3. **info**: General progress information (default)
4. **debug**: Detailed debugging information

## Examples

### Console Output
```
21:20:57 [info] Starting quiz marker application {"context":"main","folder":"./2025/answerSheets"}
21:20:57 [info] Mock mode enabled {"context":"textract"}
21:20:57 [info] Found 1 subdirectories {"context":"main","subdirs":["1"]}
21:20:57 [info] Processing quiz folder: 2025/answerSheets/1 {"context":"quizExtractor"}
```

### Log File (JSON)
```json
{
  "context": "main",
  "folder": "./2025/answerSheets",
  "grade": false,
  "level": "info",
  "maxQ": 100,
  "message": "Starting quiz marker application",
  "saveMock": false,
  "timestamp": "2025-11-01 21:20:57",
  "useMock": true
}
```

## What's Logged

### Main Application (`main`)
- Application startup with configuration
- Subdirectory discovery
- Processing start/completion for each student
- Final summary statistics
- Fatal errors

### Textract Module (`textract`)
- Mock mode configuration
- File loading (mock vs API)
- Block extraction counts
- Key-value pair extraction
- Answer extraction with question matching
- API errors

### AI Grader (`aiGrader`)
- OpenAI initialization
- Grading requests (model, temperature, question count)
- OpenAI API responses (tokens used, finish reason)
- Grading results (correct/incorrect counts)
- Retry attempts and failures

### Quiz Extractor (`quizExtractor`)
- Folder processing start
- Image file discovery
- Name/email extraction
- Answer merging from multiple pages
- Processing completion with statistics

## Benefits

1. **Debugging**: Detailed logs help track down issues
2. **Monitoring**: Real-time progress tracking
3. **Audit Trail**: Complete history of operations
4. **Performance**: Track timing and API usage
5. **Production**: Error logs for troubleshooting

## Log File Management

Logs are stored in the `logs/` directory and are automatically rotated by Winston.

To clean up logs:
```bash
rm -rf logs/
```

To analyze logs:
```bash
# View all errors
grep '"level":"error"' logs/combined.log | jq .

# View specific context
grep '"context":"aiGrader"' logs/combined.log | jq .

# Count log entries
wc -l logs/combined.log
```

## Adding Logging to New Code

```typescript
import { createContextLogger } from "./logger.js";

const logger = createContextLogger("myModule");

// Info level
logger.info("Processing started", { itemCount: 5 });

// Debug level
logger.debug("Processing item", { item: data });

// Warning
logger.warn("Unexpected value", { value, expected });

// Error
logger.error("Processing failed", { error, item });
```

## Configuration

The logger is configured in `src/logger.ts`:
- Format
- Transports (console, file)
- Log levels
- Output paths

Modify this file to customize logging behavior.
