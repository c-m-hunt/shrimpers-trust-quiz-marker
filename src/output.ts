import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { OutputConfig } from "./config.js";
import { createContextLogger } from "./logger.js";
import type { QuizResult } from "./quizExtractor.js";

const logger = createContextLogger("output");

export type ProcessedResults = Record<string, QuizResult>;

/**
 * Sort answer keys numerically (Q1, Q2, ... Q10, Q11, etc.)
 */
function sortAnswersNumerically(answers: Record<string, string>): Record<string, string> {
  const sortedEntries = Object.entries(answers).sort((a, b) => {
    // Extract numeric part from keys like "Q1", "Q10", "1.", "10.", etc.
    const numA = parseInt(a[0].match(/\d+/)?.[0] || "0", 10);
    const numB = parseInt(b[0].match(/\d+/)?.[0] || "0", 10);
    return numA - numB;
  });

  return Object.fromEntries(sortedEntries);
}

/**
 * Sort grading results numerically by question number
 */
function sortGradingResults(grades: any[]): any[] {
  return grades.sort((a, b) => {
    // Extract numeric part from question keys like "Q1", "Q10", etc.
    const numA = parseInt(a.question.match(/\d+/)?.[0] || "0", 10);
    const numB = parseInt(b.question.match(/\d+/)?.[0] || "0", 10);
    return numA - numB;
  });
}

/**
 * Sort all answers in results numerically
 */
export function sortResultsAnswers(results: ProcessedResults): ProcessedResults {
  const sorted: ProcessedResults = {};

  for (const [key, result] of Object.entries(results)) {
    sorted[key] = {
      ...result,
      answers: sortAnswersNumerically(result.answers),
      // Also sort grading results if present
      ...(result.grading && {
        grading: {
          ...result.grading,
          grades: sortGradingResults(result.grading.grades),
        },
      }),
    };
  }

  return sorted;
}

/**
 * Base interface for output handlers
 */
export interface OutputHandler {
  write(results: ProcessedResults): Promise<void>;
}

/**
 * File output handler - writes results to a JSON file
 */
export class FileOutputHandler implements OutputHandler {
  constructor(private filePath: string) {}

  async write(results: ProcessedResults): Promise<void> {
    logger.info(`Writing results to file: ${this.filePath}`);

    try {
      const dir = path.dirname(this.filePath);
      // Ensure directory exists
      await import("node:fs/promises").then((fs) => fs.mkdir(dir, { recursive: true }));

      // Sort answers numerically before writing
      const sortedResults = sortResultsAnswers(results);
      const jsonContent = JSON.stringify(sortedResults, null, 2);
      await writeFile(this.filePath, jsonContent, "utf-8");

      logger.info(`Successfully wrote results to ${this.filePath}`, {
        entryCount: Object.keys(results).length,
        fileSize: jsonContent.length,
      });
    } catch (error) {
      logger.error(`Failed to write file output`, {
        error,
        filePath: this.filePath,
      });
      throw error;
    }
  }
}

/**
 * Google Sheets output handler (placeholder for future implementation)
 */
export class GoogleSheetsOutputHandler implements OutputHandler {
  constructor(
    private spreadsheetId: string,
    private sheetName: string,
  ) {}

  async write(_results: ProcessedResults): Promise<void> {
    logger.info(`Writing results to Google Sheets`, {
      spreadsheetId: this.spreadsheetId,
      sheetName: this.sheetName,
    });

    // TODO: Implement Google Sheets API integration
    logger.warn("Google Sheets output not yet implemented");
    throw new Error("Google Sheets output is not yet implemented");
  }
}

/**
 * Excel output handler (placeholder for future implementation)
 */
export class ExcelOutputHandler implements OutputHandler {
  constructor(private filePath: string) {}

  async write(_results: ProcessedResults): Promise<void> {
    logger.info(`Writing results to Excel: ${this.filePath}`);

    // TODO: Implement Excel file generation
    logger.warn("Excel output not yet implemented");
    throw new Error("Excel output is not yet implemented");
  }
}

/**
 * HTML Report output handler - generates an interactive HTML report
 */
export class HtmlReportOutputHandler implements OutputHandler {
  constructor(private filePath: string) {}

  async write(results: ProcessedResults): Promise<void> {
    logger.info(`Writing HTML report to: ${this.filePath}`);

    try {
      const dir = path.dirname(this.filePath);
      // Ensure directory exists
      await import("node:fs/promises").then((fs) => fs.mkdir(dir, { recursive: true }));

      // Sort results numerically
      const sortedResults = sortResultsAnswers(results);

      // Generate HTML content
      const htmlContent = this.generateHtmlReport(sortedResults);
      await writeFile(this.filePath, htmlContent, "utf-8");

      logger.info(`Successfully wrote HTML report to ${this.filePath}`, {
        entryCount: Object.keys(results).length,
        fileSize: htmlContent.length,
      });
    } catch (error) {
      logger.error(`Failed to write HTML report`, {
        error,
        filePath: this.filePath,
      });
      throw error;
    }
  }

  private generateHtmlReport(results: ProcessedResults): string {
    // Embed the results data directly in the HTML
    const dataJson = JSON.stringify(results, null, 2);

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Quiz Results Report</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
            background: #f5f5f5;
            padding: 20px;
        }

        .container {
            max-width: 100%;
            background: white;
            border-radius: 8px;
            box-shadow: 0 2px 8px rgba(0,0,0,0.1);
            overflow: hidden;
        }

        .header {
            padding: 20px 30px;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
        }

        h1 {
            font-size: 24px;
            font-weight: 600;
            margin-bottom: 8px;
        }

        .summary {
            font-size: 14px;
            opacity: 0.9;
        }

        .table-wrapper {
            position: relative;
            overflow-x: auto;
            max-height: calc(100vh - 200px);
        }

        table {
            width: 100%;
            border-collapse: separate;
            border-spacing: 0;
            font-size: 13px;
        }

        th, td {
            padding: 12px 16px;
            text-align: left;
            border-bottom: 1px solid #e0e0e0;
        }

        thead th {
            position: sticky;
            top: 0;
            background: #f8f9fa;
            font-weight: 600;
            color: #333;
            z-index: 10;
            border-bottom: 2px solid #dee2e6;
        }

        /* Sticky first two columns */
        th:first-child,
        td:first-child {
            position: sticky;
            left: 0;
            background: #fff;
            z-index: 5;
            font-weight: 600;
            min-width: 80px;
            box-shadow: 2px 0 4px rgba(0,0,0,0.05);
        }

        thead th:first-child {
            z-index: 15;
            background: #f8f9fa;
        }

        th:nth-child(2),
        td:nth-child(2) {
            position: sticky;
            left: 80px;
            background: #fff;
            z-index: 5;
            min-width: 250px;
            max-width: 250px;
            font-weight: 500;
            box-shadow: 2px 0 4px rgba(0,0,0,0.05);
        }

        thead th:nth-child(2) {
            z-index: 15;
            background: #f8f9fa;
        }

        /* Entry columns */
        th:not(:first-child):not(:nth-child(2)),
        td:not(:first-child):not(:nth-child(2)) {
            min-width: 220px;
            max-width: 220px;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }

        /* Color coding based on correctness and confidence */
        .correct-high {
            background-color: #d4edda;
            color: #155724;
        }

        .correct-medium {
            background-color: #e7f3e7;
            color: #155724;
        }

        .incorrect-low {
            background-color: #f8d7da;
            color: #721c24;
        }

        .incorrect-high {
            background-color: #f8d7da;
            color: #721c24;
            font-weight: 600;
        }

        .no-grading {
            background-color: #e2e3e5;
            color: #383d41;
        }

        tbody tr:hover td:not(:first-child):not(:nth-child(2)) {
            opacity: 0.8;
        }

        .entry-header {
            text-align: center;
            font-weight: 600;
        }

        .score {
            display: block;
            font-size: 11px;
            font-weight: normal;
            margin-top: 4px;
            opacity: 0.8;
        }

        /* Tooltip */
        .has-tooltip {
            cursor: help;
            position: relative;
        }

        .question-number {
            color: #666;
            font-size: 12px;
        }

        .correct-answer {
            color: #333;
            font-size: 13px;
        }

        .legend {
            padding: 20px 30px;
            background: #f8f9fa;
            border-top: 1px solid #dee2e6;
            display: flex;
            gap: 20px;
            flex-wrap: wrap;
            align-items: center;
            font-size: 12px;
        }

        .legend-item {
            display: flex;
            align-items: center;
            gap: 8px;
        }

        .legend-color {
            width: 20px;
            height: 20px;
            border-radius: 3px;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>Quiz Results Report</h1>
            <div class="summary" id="summary"></div>
        </div>

        <div class="table-wrapper">
            <table id="resultsTable">
                <thead>
                    <tr id="headerRow"></tr>
                </thead>
                <tbody id="tableBody"></tbody>
            </table>
        </div>

        <div class="legend">
            <strong>Legend:</strong>
            <div class="legend-item">
                <div class="legend-color correct-high"></div>
                <span>Correct (High Confidence)</span>
            </div>
            <div class="legend-item">
                <div class="legend-color correct-medium"></div>
                <span>Correct (Medium Confidence)</span>
            </div>
            <div class="legend-item">
                <div class="legend-color incorrect-low"></div>
                <span>Incorrect (Low Confidence)</span>
            </div>
            <div class="legend-item">
                <div class="legend-color incorrect-high"></div>
                <span>Incorrect (High Confidence)</span>
            </div>
            <div class="legend-item">
                <div class="legend-color no-grading"></div>
                <span>No Grading Data</span>
            </div>
        </div>
    </div>

    <script>
        // Embedded data
        const data = ${dataJson};

        function renderReport(data) {
            const entries = Object.keys(data).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

            // Get all questions (Q1-Q50)
            const questions = [];
            for (let i = 1; i <= 50; i++) {
                questions.push(\`Q\${i}\`);
            }

            // Build answer key from first entrant's grading data
            const answerKey = {};
            const firstentry = data[entries[0]];
            if (firstentry.grading) {
                firstentry.grading.grades.forEach(grade => {
                    answerKey[grade.question] = grade.correctAnswer;
                });
            }

            // Render header
            const headerRow = document.getElementById('headerRow');
            headerRow.innerHTML = \`
                <th class="question-number">Q#</th>
                <th class="correct-answer">Correct Answer</th>
                \${entries.map(entryId => {
                    const entry = data[entryId];
                    const score = entry.grading
                        ? \`\${entry.grading.correctAnswers}/\${entry.grading.totalQuestions}\`
                        : 'N/A';
                    const percentage = entry.grading
                        ? Math.round((entry.grading.correctAnswers / entry.grading.totalQuestions) * 100)
                        : 0;
                    return \`<th class="entry-header">
                        Entry \${entryId}
                        <span class="score">\${score} (\${percentage}%)</span>
                    </th>\`;
                }).join('')}
            \`;

            // Render table body
            const tbody = document.getElementById('tableBody');
            tbody.innerHTML = questions.map(qNum => {
                const correctAnswer = answerKey[qNum] || 'N/A';

                return \`
                    <tr>
                        <td class="question-number">\${qNum}</td>
                        <td class="correct-answer">\${correctAnswer}</td>
                        \${entries.map(entryId => {
                            const entry = data[entryId];
                            const submittedAnswer = entry.answers[qNum] || '';

                            // Find grading info for this question
                            let gradeInfo = null;
                            if (entry.grading && entry.grading.grades) {
                                gradeInfo = entry.grading.grades.find(g => g.question === qNum);
                            }

                            let cssClass = 'no-grading';
                            let title = submittedAnswer;

                            if (gradeInfo) {
                                if (gradeInfo.isCorrect) {
                                    cssClass = gradeInfo.confidence === 'high' ? 'correct-high' : 'correct-medium';
                                } else {
                                    cssClass = gradeInfo.confidence === 'high' ? 'incorrect-high' : 'incorrect-low';
                                }

                                // Build tooltip
                                title = \`Submitted: \${gradeInfo.submittedAnswer}\\nCorrect: \${gradeInfo.correctAnswer}\\nConfidence: \${gradeInfo.confidence}\`;
                                if (gradeInfo.notes) {
                                    title += \`\\nNotes: \${gradeInfo.notes}\`;
                                }
                            }

                            return \`<td class="\${cssClass} has-tooltip" title="\${title}">\${submittedAnswer}</td>\`;
                        }).join('')}
                    </tr>
                \`;
            }).join('');

            // Update summary
            const totalentries = entries.length;
            const avgScores = entries
                .filter(id => data[id].grading)
                .map(id => (data[id].grading.correctAnswers / data[id].grading.totalQuestions) * 100);
            const avgScore = avgScores.length > 0
                ? (avgScores.reduce((a, b) => a + b, 0) / avgScores.length).toFixed(1)
                : 0;

            document.getElementById('summary').innerHTML = \`
                \${totalentries} \${totalentries !== 1 ? 'entries' : 'entry'} |
                \${questions.length} questions |
                Average score: \${avgScore}%
            \`;
        }

        // Render on load
        renderReport(data);
    </script>
</body>
</html>
`;
  }
}

/**
 * Factory function to create output handlers from configuration
 */
export function createOutputHandler(config: OutputConfig): OutputHandler {
  logger.debug(`Creating output handler`, { type: config.type });

  switch (config.type) {
    case "file":
      if (!config.path) {
        throw new Error("File output requires 'path' configuration");
      }
      return new FileOutputHandler(config.path);

    case "htmlReport":
      if (!config.path) {
        throw new Error("HTML Report output requires 'path' configuration");
      }
      return new HtmlReportOutputHandler(config.path);

    case "googleSheets":
      if (!config.spreadsheetId || !config.sheetName) {
        throw new Error("Google Sheets output requires 'spreadsheetId' and 'sheetName'");
      }
      return new GoogleSheetsOutputHandler(config.spreadsheetId, config.sheetName);

    case "excel":
      if (!config.path) {
        throw new Error("Excel output requires 'path' configuration");
      }
      return new ExcelOutputHandler(config.path);

    default:
      throw new Error(`Unknown output type: ${(config as any).type}`);
  }
}

/**
 * Write results to all configured outputs
 */
export async function writeResults(
  results: ProcessedResults,
  outputConfigs: OutputConfig[],
): Promise<void> {
  logger.info(`Writing results to ${outputConfigs.length} output(s)`);

  const handlers = outputConfigs.map(createOutputHandler);
  const errors: Error[] = [];

  for (let i = 0; i < handlers.length; i++) {
    const handler = handlers[i];
    const config = outputConfigs[i];

    if (!handler || !config) continue;

    try {
      await handler.write(results);
      logger.info(`Output ${i + 1}/${handlers.length} completed successfully`, {
        type: config.type,
      });
    } catch (error) {
      logger.error(`Output ${i + 1}/${handlers.length} failed`, {
        type: config.type,
        error,
      });
      errors.push(error as Error);
    }
  }

  if (errors.length > 0) {
    logger.error(`${errors.length} output(s) failed`, {
      totalOutputs: handlers.length,
    });
    throw new Error(
      `${errors.length} output(s) failed: ${errors.map((e) => e.message).join(", ")}`,
    );
  }

  logger.info("All outputs completed successfully");
}
