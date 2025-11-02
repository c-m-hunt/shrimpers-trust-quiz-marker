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
      FeatureTypes: ["FORMS"], // focus on key-value pairs
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

/** Normalise keys (e.g., 'Email Address' -> 'email') and trim values */
export function normaliseKV(kv: KVMap): KVMap {
  logger.debug(`Normalizing ${Object.keys(kv).length} key-value pairs`);
  const out: KVMap = {};
  for (const [k, v] of Object.entries(kv)) {
    const key = k.toLowerCase().replace(/\s+/g, " ").trim();
    if (/(^e-?mail|^email)/i.test(key)) {
      out.email = v.trim();
      logger.debug(`Found email: ${v.trim()}`);
    } else if (/^name\b/i.test(key)) {
      out.name = v.trim();
      logger.debug(`Found name: ${v.trim()}`);
    } else {
      out[key] = v.trim();
    }
  }
  return out;
}

/**
 * Heuristic: pull Q1..Q100 answers from keys like 'Q1', 'Question 1', '1.', or nearby fields.
 * If your form prints question labels near answer boxes, Textract usually captures them as keys.
 */
export function extractAnswers(kv: KVMap, maxQ = 100): Record<string, string> {
  logger.debug(`Extracting answers from ${Object.keys(kv).length} KV pairs (maxQ: ${maxQ})`);
  const answers: Record<string, string> = {};
  const qRegexes = Array.from({ length: maxQ }, (_, i) => {
    const q = i + 1;
    return [
      new RegExp(`^q\\s*${q}\\b`, "i"),
      new RegExp(`^question\\s*${q}\\b`, "i"),
      new RegExp(`^${q}\\.?$`), // Match "1." or "1"
    ];
  });

  for (const [k, v] of Object.entries(kv)) {
    for (let i = 0; i < qRegexes.length; i++) {
      const regexPair = qRegexes[i];
      if (!regexPair) continue;
      const [r1, r2, r3] = regexPair;
      if (r1 && r2 && r3 && (r1.test(k) || r2.test(k) || r3.test(k))) {
        answers[`Q${i + 1}`] = v;
        logger.debug(`Matched question Q${i + 1}: "${k}" = "${v}"`);
        break;
      }
    }
  }
  logger.info(`Extracted ${Object.keys(answers).length} answers`);
  return answers;
}
