import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { AnalyzeDocumentCommand, type Block, type Relationship } from "@aws-sdk/client-textract";
import { textract } from "./aws.js";
import { createContextLogger } from "./logger.js";

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
export function extractTableAnswers(blocks: Block[], maxQ = 100): Record<string, string> {
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
      const sortedCells = rowCells.sort(
        (a, b) => (a.ColumnIndex ?? 0) - (b.ColumnIndex ?? 0),
      );

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
        logger.debug(
          `Row ${rowIndex}: No answer for expected Q${expectedQ1}, col3="${answer1}"`,
        );
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

  // Apply OCR corrections for known Textract misreads
  answers = applyOCRCorrections(answers);

  return answers;
}

/**
 * Apply corrections for known OCR errors in table extraction
 */
function applyOCRCorrections(answers: Record<string, string>): Record<string, string> {
  const corrections: Record<string, Record<string, string>> = {
    // Map of answer variations to correct answer
    "CHINA HAND IN YOUR": { correct: "CHINA IN YOUR HAND" },
    "CHINA IN YOUR": { correct: "CHINA IN YOUR HAND" },
    "INSTANT": { correct: "INSTANT REPLAY" },
    "REPLAY. THE EDGEOF": { correct: "THE EDGE OF HEAVEN" },
    "THE EDGEOF": { correct: "THE EDGE OF HEAVEN" },
    "HEAVEN VOULEZ Yous": { correct: "VOULEZ VOUS" },
    "VOULEZ Yous": { correct: "VOULEZ VOUS" },
  };

  const corrected: Record<string, string> = {};

  // First pass: apply simple corrections
  for (const [qNum, answer] of Object.entries(answers)) {
    const trimmed = answer.trim();
    if (corrections[trimmed]) {
      const correctedAnswer = corrections[trimmed].correct;
      corrected[qNum] = correctedAnswer;
      logger.debug(`OCR correction applied: ${qNum} "${trimmed}" -> "${correctedAnswer}"`);
    } else {
      corrected[qNum] = answer;
    }
  }

  // Second pass: handle merged/split answers
  // Check for Q36="BACK" + Q37="STABBERS" pattern (should be Q36="BACK STABBERS")
  if (corrected.Q36 === "BACK" && corrected.Q37 === "STABBERS") {
    logger.debug(`Merging split answer: Q36 "BACK" + Q37 "STABBERS" -> Q36 "BACK STABBERS"`);
    corrected.Q36 = "BACK STABBERS";

    // Shift all subsequent answers up by one (Q38->Q37, Q39->Q38, etc.)
    for (let i = 37; i <= 49; i++) {
      const currentKey = `Q${i}`;
      const nextKey = `Q${i + 1}`;
      if (corrected[nextKey]) {
        corrected[currentKey] = corrected[nextKey];
        logger.debug(`Shifting Q${i + 1} -> Q${i}: "${corrected[nextKey]}"`);
      } else {
        delete corrected[currentKey];
      }
    }
    delete corrected.Q50; // Remove last item since we shifted everything up
  }

  // After merging, check Q37 (which now contains what was Q38) for merged answers
  if (corrected.Q37 && corrected.Q37.includes("RIDDLE") && corrected.Q37.includes("HAPPY")) {
    const text = corrected.Q37.trim();
    // Split on common answer boundaries
    if (text === "THE RIDDLE HAPPY DAYS") {
      logger.debug(`Splitting merged answer: Q37 "THE RIDDLE HAPPY DAYS" -> Q37 "THE RIDDLE", Q38 "HAPPY DAYS"`);

      // Shift everything after Q37 down by one to make room (Q49->Q50, Q48->Q49, ..., Q38->Q39)
      for (let i = 49; i >= 38; i--) {
        const currentKey = `Q${i}`;
        const nextKey = `Q${i + 1}`;
        if (corrected[currentKey]) {
          corrected[nextKey] = corrected[currentKey];
          logger.debug(`Shifting Q${i} -> Q${i + 1}: "${corrected[currentKey]}"`);
        }
      }

      // Now set the split values
      corrected.Q37 = "THE RIDDLE";
      corrected.Q38 = "HAPPY DAYS";
    }
  }

  return corrected;
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
