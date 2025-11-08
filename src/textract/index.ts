import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { AnalyzeDocumentCommand, type Block, type Relationship } from "@aws-sdk/client-textract";
import { textract } from "./aws.js";
import { createContextLogger } from "../logger.js";

const logger = createContextLogger("textract");

export type KVMap = Record<string, string>;

let useMockMode = false;
let saveMockData = false;

export function setMockMode(enabled: boolean) {
  useMockMode = enabled;
  logger.info(`Mock mode ${enabled ? "enabled" : "disabled"}`);
}

export function setSaveMockData(enabled: boolean) {
  saveMockData = enabled;
  logger.info(`Save mock data ${enabled ? "enabled" : "disabled"}`);
}

function getMockPath(imagePath: string): string {
  const dir = path.dirname(imagePath);
  const filename = path.basename(imagePath, path.extname(imagePath));
  const mockDir = path.join(dir, ".textract");
  return path.join(mockDir, `${filename}.json`);
}

export async function analyzeImageForForms(imagePath: string): Promise<Block[]> {
  const mockPath = getMockPath(imagePath);
  const fileName = path.basename(imagePath);

  // Try to load from mock if in mock mode
  if (useMockMode && existsSync(mockPath)) {
    logger.info(`Loading mock data for ${fileName}`, { mockPath });
    const mockData = await readFile(mockPath, "utf-8");
    const blocks = JSON.parse(mockData) as Block[];
    logger.debug(`Loaded ${blocks.length} blocks from mock`, { fileName });
    return blocks;
  }

  // Call real API
  logger.info(`Calling Textract API for ${fileName}`);
  try {
    const bytes = await readFile(imagePath);
    logger.debug(`Read ${bytes.length} bytes from ${fileName}`);

    const cmd = new AnalyzeDocumentCommand({
      Document: { Bytes: bytes },
      FeatureTypes: ["TABLES", "FORMS"], // Extract both tables and key-value pairs
    });
    const resp = await textract.send(cmd);
    const blocks = resp.Blocks ?? [];
    logger.info(`Textract returned ${blocks.length} blocks for ${fileName}`);

    // Save mock data if enabled
    if (saveMockData) {
      const mockDir = path.dirname(mockPath);
      await mkdir(mockDir, { recursive: true });
      await writeFile(mockPath, JSON.stringify(blocks, null, 2), "utf-8");
      logger.info(`Saved mock data for ${fileName}`, { mockPath });
    }

    return blocks;
  } catch (error) {
    logger.error(`Failed to analyze image ${fileName}`, { error });
    throw error;
  }
}

/**
 * Textract returns BLOCKs (KEY_VALUE_SET, WORD, LINE, etc) with relationships.
 * This collects KEY blocks and finds their VALUE partners, then joins the text.
 */
export function extractKeyValues(blocks: Block[]): KVMap {
  const blockMap = new Map<string, Block>();
  const keyBlocks: Block[] = [];
  const valueBlocks: Block[] = [];

  logger.debug(`Extracting key-values from ${blocks.length} blocks`);

  for (const b of blocks) {
    if (!b.Id) continue;
    blockMap.set(b.Id, b);
    if (b.BlockType === "KEY_VALUE_SET" && b.EntityTypes?.includes("KEY")) {
      keyBlocks.push(b);
    } else if (b.BlockType === "KEY_VALUE_SET" && b.EntityTypes?.includes("VALUE")) {
      valueBlocks.push(b);
    }
  }

  logger.debug(`Found ${keyBlocks.length} key blocks and ${valueBlocks.length} value blocks`);

  const getText = (block?: Block | null): string => {
    if (!block?.Relationships) return "";
    const textRuns: string[] = [];
    for (const rel of block.Relationships as Relationship[]) {
      if (rel.Type === "CHILD") {
        for (const cid of rel.Ids ?? []) {
          const child = blockMap.get(cid);
          if (child?.BlockType === "WORD" && child.Text) {
            textRuns.push(child.Text);
          } else if (child?.BlockType === "SELECTION_ELEMENT") {
            // If you had checkboxes, you'd inspect SelectionStatus here
            if (child.SelectionStatus === "SELECTED") textRuns.push("[X]");
          }
        }
      }
    }
    return textRuns.join(" ");
  };

  const findValueBlock = (keyBlock: Block): Block | undefined => {
    for (const rel of keyBlock.Relationships ?? []) {
      if (rel.Type === "VALUE") {
        for (const vid of rel.Ids ?? []) {
          const vb = blockMap.get(vid);
          if (vb && vb.BlockType === "KEY_VALUE_SET") return vb;
        }
      }
    }
    return undefined;
  };

  const kv: KVMap = {};
  for (const kb of keyBlocks) {
    const keyText = getText(kb).trim();
    const valueBlock = findValueBlock(kb);
    const valueText = getText(valueBlock).trim();
    if (keyText) {
      kv[keyText] = valueText;
      logger.debug(`Extracted KV pair: "${keyText}" = "${valueText}"`);
    }
  }
  logger.info(`Extracted ${Object.keys(kv).length} key-value pairs`);
  return kv;
}

/** Normalise keys and trim values */
export function normaliseKV(kv: KVMap): KVMap {
  logger.debug(`Normalizing ${Object.keys(kv).length} key-value pairs`);
  const out: KVMap = {};
  for (const [k, v] of Object.entries(kv)) {
    const key = k.trim();
    const value = v.trim();
    out[key] = value;

    // Also look for name/email in the values, as they might not be labelled
    if (/@/.test(value) && !out.email) {
      out.email = value;
      logger.debug(`Found email in value: ${value}`);
    } else if (/^[A-Za-z\s]+$/.test(value) && value.split(" ").length >= 2 && !out.name) {
      // Simple heuristic for a name: at least two words, all alphabetic.
      // This is not foolproof!
      // out.name = value;
      // logger.debug(`Found possible name in value: ${value}`);
    }
  }

  // Fallback for name/email if they still exist as keys
  for (const [k, v] of Object.entries(kv)) {
    const key = k.toLowerCase().replace(/\s+/g, " ").trim();
    if (/(^e-?mail|^email)/i.test(key)) {
      out.email = v.trim();
      logger.debug(`Found email in key: ${v.trim()}`);
    } else if (/^name\b/i.test(key)) {
      out.name = v.trim();
      logger.debug(`Found name in key: ${v.trim()}`);
    }
  }

  return out;
}

/**
 * Extract data from a 6-column table structure:
 * Column 1: Question number
 * Column 2: Question text
 * Column 3: Answer
 * Column 4: Question number
 * Column 5: Question text
 * Column 6: Answer
 */
export function extractTableAnswers(
  blocks: Block[],
  maxQ = 100,
  answerKey?: Record<string, string>,
): Record<string, string> {
  logger.debug(`Extracting answers from table structure (maxQ: ${maxQ})`);
  let answers: Record<string, string> = {};

  // Build a map of all blocks by ID
  const blockMap = new Map<string, Block>();
  for (const b of blocks) {
    if (b.Id) {
      blockMap.set(b.Id, b);
    }
  }

  // Helper function to get text from a block
  const getText = (block?: Block | null): string => {
    if (!block?.Relationships) return "";
    const textRuns: string[] = [];
    for (const rel of block.Relationships as Relationship[]) {
      if (rel.Type === "CHILD") {
        for (const cid of rel.Ids ?? []) {
          const child = blockMap.get(cid);
          if (child?.BlockType === "WORD" && child.Text) {
            textRuns.push(child.Text);
          }
        }
      }
    }
    return textRuns.join(" ").trim();
  };

  // Find all TABLE blocks
  const tables = blocks.filter((b) => b.BlockType === "TABLE");
  logger.debug(`Found ${tables.length} table(s)`);

  for (const table of tables) {
    // Find all CELL blocks that belong to this table
    const cellIds = new Set<string>();
    for (const rel of table.Relationships ?? []) {
      if (rel.Type === "CHILD") {
        for (const id of rel.Ids ?? []) {
          cellIds.add(id);
        }
      }
    }

    // Organize cells by row and column
    const cells = Array.from(cellIds)
      .map((id) => blockMap.get(id))
      .filter((b) => b?.BlockType === "CELL") as Block[];

    // Group cells by row
    const rowMap = new Map<number, Block[]>();
    for (const cell of cells) {
      const rowIndex = cell.RowIndex ?? 0;
      if (!rowMap.has(rowIndex)) {
        rowMap.set(rowIndex, []);
      }
      rowMap.get(rowIndex)?.push(cell);
    }

    // Sort rows and process each row
    const sortedRows = Array.from(rowMap.entries()).sort((a, b) => a[0] - b[0]);

    // Track expected question numbers for sequential inference
    let expectedQ1 = 1; // For columns 1-3 (Q1-Q25)
    let expectedQ2 = 26; // For columns 4-6 (Q26-Q50)

    for (const [rowIndex, rowCells] of sortedRows) {
      // Sort cells by column index
      const sortedCells = rowCells.sort((a, b) => (a.ColumnIndex ?? 0) - (b.ColumnIndex ?? 0));

      // Skip if not 6 columns
      if (sortedCells.length !== 6) {
        continue;
      }

      // Skip header row (check if column 3 or 6 contains "ANSWER")
      const col3 = getText(sortedCells[2]).toUpperCase();
      const col6 = getText(sortedCells[5]).toUpperCase();
      if (col3.includes("ANSWER") || col6.includes("ANSWER")) {
        continue;
      }

      // Extract first set (columns 1-3) - Questions 1-25
      const answer1 = getText(sortedCells[2]);
      let qNum1: number | undefined;

      // Try to get question number from column 1
      const qNum1Text = getText(sortedCells[0]).trim();
      const parsed1 = parseInt(qNum1Text, 10);

      // If column 1 has a valid number in range 1-25 and we haven't filled it yet, use it
      if (!isNaN(parsed1) && parsed1 > 0 && parsed1 <= 25 && !answers[`Q${parsed1}`]) {
        qNum1 = parsed1;
      } else if (!isNaN(parsed1) && parsed1 > 0 && parsed1 <= 25 && answers[`Q${parsed1}`]) {
        // Number is already filled - this might be OCR error or duplicate, use sequence
        qNum1 = undefined;
      } else {
        // Try to extract from start of column 2
        const col2Text = getText(sortedCells[1]).trim();
        const match = col2Text.match(/^(\d+)\s/);
        if (match) {
          const extracted = parseInt(match[1], 10);
          if (extracted > 0 && extracted <= 25 && !answers[`Q${extracted}`]) {
            qNum1 = extracted;
          }
        }
      }

      // If we still don't have a number and have an answer, use sequential inference
      if (!qNum1 && answer1 && expectedQ1 <= 25) {
        qNum1 = expectedQ1;
        logger.debug(`Row ${rowIndex}: Inferring Q${qNum1} from sequence`);
      }

      // Store the answer if we have a valid question number and it's not already set
      if (qNum1 && qNum1 <= maxQ && answer1 && !answers[`Q${qNum1}`]) {
        answers[`Q${qNum1}`] = answer1;
        logger.debug(`Row ${rowIndex}: Q${qNum1} = "${answer1}"`);
        expectedQ1 = qNum1 + 1;
      } else if (answer1) {
        expectedQ1++;
      } else if (!answer1 && expectedQ1 >= 19 && expectedQ1 <= 22) {
        // Debug missing Q19-22
        logger.debug(`Row ${rowIndex}: No answer for expected Q${expectedQ1}, col3="${answer1}"`);
        expectedQ1++;
      }

      // Extract second set (columns 4-6) - Questions 26-50
      const answer2 = getText(sortedCells[5]);
      let qNum2: number | undefined;

      const qNum2Text = getText(sortedCells[3]).trim();
      const parsed2 = parseInt(qNum2Text, 10);

      // If column 4 has a valid number in range 26-50, use it
      if (!isNaN(parsed2) && parsed2 >= 26 && parsed2 <= 50) {
        qNum2 = parsed2;
      }

      // If we still don't have a number and have an answer, use sequential inference
      if (!qNum2 && answer2 && expectedQ2 <= 50) {
        qNum2 = expectedQ2;
        logger.debug(`Row ${rowIndex}: Inferring Q${qNum2} from sequence`);
      }

      // Store the answer if we have a valid question number and it's not already set
      if (qNum2 && qNum2 <= maxQ && answer2 && !answers[`Q${qNum2}`]) {
        answers[`Q${qNum2}`] = answer2;
        logger.debug(`Row ${rowIndex}: Q${qNum2} = "${answer2}"`);
        expectedQ2 = qNum2 + 1;
      } else if (answer2) {
        expectedQ2++;
      }
    }
  }

  logger.info(`Extracted ${Object.keys(answers).length} answers from table`);

  // Apply generic OCR corrections using answer key if provided
  if (answerKey) {
    answers = applyOCRCorrections(answers, answerKey);
    logger.info(`Applied OCR corrections, final count: ${Object.keys(answers).length} answers`);
  }

  return answers;
}

/**
 * Calculate Levenshtein distance between two strings (for fuzzy matching)
 */
function levenshteinDistance(str1: string, str2: string): number {
  const len1 = str1.length;
  const len2 = str2.length;
  const matrix: number[][] = [];

  for (let i = 0; i <= len1; i++) {
    matrix[i] = [i];
  }
  for (let j = 0; j <= len2; j++) {
    matrix[0]![j] = j;
  }

  for (let i = 1; i <= len1; i++) {
    for (let j = 1; j <= len2; j++) {
      const cost = str1[i - 1] === str2[j - 1] ? 0 : 1;
      matrix[i]![j] = Math.min(
        matrix[i - 1]![j]! + 1, // deletion
        matrix[i]![j - 1]! + 1, // insertion
        matrix[i - 1]![j - 1]! + cost, // substitution
      );
    }
  }

  return matrix[len1]![len2]!;
}

/**
 * Normalize string for comparison (remove punctuation, spaces, lowercase)
 */
function normalizeForComparison(text: string): string {
  return text
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .trim();
}

/**
 * Calculate similarity score between two strings (0-1, where 1 is identical)
 * Handles alternate answers separated by / in the expected string
 */
function calculateSimilarity(str1: string, str2: string): number {
  const norm1 = normalizeForComparison(str1);

  // Handle alternate answers (e.g., "GLORY/HAPPY DAYS" means either is correct)
  const alternatives = str2.split("/").map((alt) => normalizeForComparison(alt.trim()));

  // Calculate similarity against all alternatives and return the best match
  let bestSimilarity = 0;
  for (const norm2 of alternatives) {
    if (norm1 === norm2) return 1.0;
    if (norm1.length === 0 || norm2.length === 0) continue;

    const distance = levenshteinDistance(norm1, norm2);
    const maxLen = Math.max(norm1.length, norm2.length);
    const similarity = 1 - distance / maxLen;

    if (similarity > bestSimilarity) {
      bestSimilarity = similarity;
    }
  }

  return bestSimilarity;
}

/**
 * Apply generic OCR corrections using fuzzy matching against an optional answer key
 */
function applyOCRCorrections(
  answers: Record<string, string>,
  answerKey?: Record<string, string>,
): Record<string, string> {
  if (!answerKey) {
    // No answer key provided, return as-is
    logger.debug("No answer key provided, skipping OCR corrections");
    return answers;
  }

  const corrected: Record<string, string> = {};
  const usedAnswers = new Set<string>(); // Track which correct answers we've already assigned

  // Convert answers to array for easier manipulation
  const answerEntries = Object.entries(answers);

  // First pass: detect merged answers (one cell contains multiple correct answers)
  for (const [qNum, extractedAnswer] of answerEntries) {
    const normalized = normalizeForComparison(extractedAnswer);

    // Check if this extracted answer contains multiple correct answers concatenated
    let foundMerge = false;
    for (let i = 1; i <= 50 && !foundMerge; i++) {
      const correctKey = `Q${i}`;
      const correctAnswer = answerKey[correctKey];
      if (!correctAnswer || usedAnswers.has(correctKey)) continue;

      const normalizedCorrect = normalizeForComparison(correctAnswer);

      // Check if extracted answer starts with this correct answer
      if (
        normalized.startsWith(normalizedCorrect) &&
        normalized.length > normalizedCorrect.length
      ) {
        const remainder = normalized.substring(normalizedCorrect.length);

        // Check if remainder matches another correct answer
        for (let j = 1; j <= 50; j++) {
          const nextKey = `Q${j}`;
          const nextAnswer = answerKey[nextKey];
          if (!nextAnswer || usedAnswers.has(nextKey) || j <= i) continue;

          const normalizedNext = normalizeForComparison(nextAnswer);
          if (
            remainder === normalizedNext ||
            calculateSimilarity(remainder, normalizedNext) > 0.8
          ) {
            // Found a merge! This cell contains answers for both Q{i} and Q{j}
            logger.debug(
              `Detected merge in ${qNum}: "${extractedAnswer}" contains "${correctAnswer}" + "${nextAnswer}"`,
            );

            // Assign the first part to current question
            corrected[qNum] = correctAnswer;
            usedAnswers.add(correctKey);

            // Store the second part for reassignment in second pass
            foundMerge = true;
            break;
          }
        }
      }
    }

    if (!foundMerge) {
      // No merge detected, keep for second pass
      corrected[qNum] = extractedAnswer;
    }
  }

  // Second pass: fuzzy match each extracted answer to the best correct answer
  for (const [qNum, extractedAnswer] of Object.entries(corrected)) {
    const questionNum = parseInt(qNum.match(/\d+/)?.[0] || "0", 10);
    const expectedKey = `Q${questionNum}`;
    const expectedAnswer = answerKey[expectedKey];

    if (!expectedAnswer) {
      logger.debug(`No expected answer for ${qNum}, keeping extracted: "${extractedAnswer}"`);
      continue;
    }

    const normalized = normalizeForComparison(extractedAnswer);
    const normalizedExpected = normalizeForComparison(expectedAnswer);

    // Calculate similarity to expected answer
    const similarity = calculateSimilarity(extractedAnswer, expectedAnswer);

    if (similarity >= 0.85) {
      // Very close match, likely just minor OCR errors
      if (normalized !== normalizedExpected) {
        logger.debug(
          `High similarity (${similarity.toFixed(2)}) for ${qNum}: "${extractedAnswer}" -> "${expectedAnswer}"`,
        );
        corrected[qNum] = expectedAnswer;
      }
    } else if (similarity < 0.5) {
      // Poor match, might be wrong answer or shifted
      // Check if extracted answer is a good match for a nearby correct answer
      let bestMatch = { key: "", answer: "", similarity: 0 };

      for (let offset = -3; offset <= 3; offset++) {
        if (offset === 0) continue;
        const nearbyNum = questionNum + offset;
        if (nearbyNum < 1 || nearbyNum > 50) continue;

        const nearbyKey = `Q${nearbyNum}`;
        const nearbyAnswer = answerKey[nearbyKey];
        if (!nearbyAnswer || usedAnswers.has(nearbyKey)) continue;

        const nearbySimilarity = calculateSimilarity(extractedAnswer, nearbyAnswer);
        if (nearbySimilarity > bestMatch.similarity) {
          bestMatch = { key: nearbyKey, answer: nearbyAnswer, similarity: nearbySimilarity };
        }
      }

      if (bestMatch.similarity > 0.85) {
        logger.debug(
          `Found better match (${bestMatch.similarity.toFixed(2)}) for ${qNum}: "${extractedAnswer}" matches ${bestMatch.key} "${bestMatch.answer}"`,
        );
        // Don't reassign here, just log - we'll handle shifts in third pass
      } else {
        logger.debug(
          `Low similarity (${similarity.toFixed(2)}) for ${qNum}: "${extractedAnswer}" vs expected "${expectedAnswer}"`,
        );
      }
    }
  }

  // Third pass: detect splits and reassign all affected answers
  const finalCorrected: Record<string, string> = { ...corrected };
  const shifts: Map<number, number> = new Map(); // Track where answers shifted from

  for (let qNum = 1; qNum <= 50; qNum++) {
    const key = `Q${qNum}`;
    const extracted = corrected[key];
    const expected = answerKey[key];

    if (!extracted || !expected) {
      continue;
    }

    const normalized = normalizeForComparison(extracted);
    const normalizedExpected = normalizeForComparison(expected);

    // Check if extracted is a prefix of expected (incomplete fragment)
    if (
      normalizedExpected.startsWith(normalized) &&
      normalized.length < normalizedExpected.length &&
      normalized.length > 3
    ) {
      // Check if next question has the remainder
      const nextKey = `Q${qNum + 1}`;
      const nextExtracted = corrected[nextKey];
      if (nextExtracted) {
        const normalizedNext = normalizeForComparison(nextExtracted);
        const remainder = normalizedExpected.substring(normalized.length);

        if (normalizedNext === remainder || normalizedNext.startsWith(remainder)) {
          logger.debug(
            `Detected split answer: ${key} "${extracted}" + ${nextKey} "${nextExtracted}" = "${expected}"`,
          );

          // Fix current question
          finalCorrected[key] = expected;

          // The next question's cell was stolen, so shift answers forward
          // Q(n+1) should get answer from Q(n+2), Q(n+2) from Q(n+3), etc.
          for (let shiftNum = qNum + 1; shiftNum < 50; shiftNum++) {
            const shiftKey = `Q${shiftNum}`;
            const shiftNextKey = `Q${shiftNum + 1}`;
            const shiftExpected = answerKey[shiftKey];
            const shiftNextExtracted = corrected[shiftNextKey];

            if (!shiftExpected || !shiftNextExtracted) {
              logger.debug(`Stopping shift at ${shiftKey}: missing expected or extracted`);
              break;
            }

            // Check if next cell's content matches current question's expected answer
            const similarity = calculateSimilarity(shiftNextExtracted, shiftExpected);
            const normalizedExtracted = normalizeForComparison(shiftNextExtracted);

            // Check if extracted starts with expected (handles merged answers like "THE RIDDLE HAPPY DAYS")
            const alternatives = shiftExpected
              .split("/")
              .map((alt) => normalizeForComparison(alt.trim()));
            const startsWithExpected = alternatives.some((alt) =>
              normalizedExtracted.startsWith(alt),
            );

            logger.debug(
              `Shift check ${shiftKey}: extracted="${shiftNextExtracted}" vs expected="${shiftExpected}" (similarity=${similarity.toFixed(2)}, startsWithExpected=${startsWithExpected})`,
            );

            if (similarity > 0.7 || startsWithExpected) {
              finalCorrected[shiftKey] = shiftExpected;
              shifts.set(shiftNum, shiftNum + 1);
              logger.debug(`Shifted ${shiftKey} = "${shiftExpected}" (from ${shiftNextKey})`);

              // If extracted text starts with expected, check if there's a remainder for the next question
              if (startsWithExpected) {
                const matchedAlt = alternatives.find((alt) => normalizedExtracted.startsWith(alt));
                if (matchedAlt && normalizedExtracted.length > matchedAlt.length) {
                  const remainder = shiftNextExtracted.substring(matchedAlt.length).trim();
                  const nextNextKey = `Q${shiftNum + 1}`;
                  const nextNextExpected = answerKey[nextNextKey];

                  if (remainder && nextNextExpected) {
                    const remainderSimilarity = calculateSimilarity(remainder, nextNextExpected);
                    logger.debug(
                      `Checking remainder "${remainder}" for ${nextNextKey} vs expected "${nextNextExpected}" (similarity=${remainderSimilarity.toFixed(2)})`,
                    );

                    if (remainderSimilarity > 0.7) {
                      finalCorrected[nextNextKey] = nextNextExpected;
                      logger.debug(
                        `Assigned ${nextNextKey} = "${nextNextExpected}" from remainder`,
                      );
                    }
                  }
                }
              }
            } else {
              // Stop shifting when similarity is too low and doesn't start with expected
              logger.debug(
                `Stopping shift at ${shiftKey}: similarity ${similarity.toFixed(2)} < 0.7 and doesn't start with expected`,
              );
              break;
            }
          }

          // Skip ahead past the consumed cell
          qNum++;
        }
      }
    }
  }

  return finalCorrected;
}

/**
 * Heuristic: pull Q1..Q100 answers from keys like 'Q1', 'Question 1', '1.', or nearby fields.
 * If your form prints question labels near answer boxes, Textract usually captures them as keys.
 */
export function extractAnswers(kv: KVMap, maxQ = 100): Record<string, string> {
  logger.debug(`Extracting answers from ${Object.keys(kv).length} KV pairs (maxQ: ${maxQ})`);
  const answers: Record<string, string> = {};

  // Convert the KV map to an array of [key, value] pairs to preserve order if possible
  const kvArray = Object.entries(kv);

  // We expect a 6-column structure. Let's process it in chunks.
  // This is a heuristic and might need adjustment based on Textract's output order.
  // The assumption is that items are read left-to-right, top-to-bottom.
  // A "row" would be [Q_Num, Question, Answer, Q_Num, Question, Answer]
  for (let i = 0; i < kvArray.length; i++) {
    const key = kvArray[i]?.[0];
    const value = kvArray[i]?.[1];

    // Simple heuristic: if a key is just a number, it's a question number.
    // The *next* item in the list is its answer.
    if (key && /^\d+$/.test(key.trim())) {
      const questionNumber = parseInt(key.trim(), 10);
      if (questionNumber > 0 && questionNumber <= maxQ) {
        // The key is the question number, e.g., "1". The value is the question text.
        // The actual answer is the value of the *next* key-value pair.
        const nextPair = kvArray[i + 1];
        if (nextPair) {
          const answerText = nextPair[1]; // The value of the next pair
          answers[`Q${questionNumber}`] = answerText;
          logger.debug(`Matched Q${questionNumber}: "${key}" -> Answer: "${answerText}"`);
          // We skip the next item since we've consumed it as the answer
          i++;
        }
      }
    }
  }

  logger.info(`Extracted ${Object.keys(answers).length} answers`);
  return answers;
}
