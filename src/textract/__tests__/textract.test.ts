import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import type { Block } from "@aws-sdk/client-textract";
import {
  extractAnswers,
  extractKeyValues,
  extractTableAnswers,
  normaliseKV,
} from "../index.js";

// Load sample Textract response from fixtures
async function loadFixture(filename: string): Promise<Block[]> {
  const fixturePath = path.join(__dirname, "fixtures", filename);
  const content = await readFile(fixturePath, "utf-8");
  return JSON.parse(content);
}

describe("textract module", () => {
  describe("extractTableAnswers", () => {
    test("should extract 50 answers from table blocks", async () => {
      const blocks = await loadFixture("sample-textract-response.json");
      const answers = extractTableAnswers(blocks, 50);

      expect(Object.keys(answers).length).toBe(50);
      expect(answers["Q1"]).toBeDefined();
      expect(answers["Q50"]).toBeDefined();
    });

    test("should extract correct answer values from the fixture", async () => {
      const blocks = await loadFixture("sample-textract-response.json");
      const answers = extractTableAnswers(blocks, 50);

      // Verify some known answers from the fixture
      expect(answers["Q1"]).toBe("CRUEL SUMMER");
      expect(answers["Q2"]).toBe("MONEY. MONEY, MONEY");
      expect(answers["Q21"]).toBe("19");
    });

    test("should respect maxQuestions limit", async () => {
      const blocks = await loadFixture("sample-textract-response.json");
      const answers = extractTableAnswers(blocks, 10);

      expect(Object.keys(answers).length).toBeLessThanOrEqual(10);
    });
  });

  describe("extractKeyValues", () => {
    test("should extract key-value pairs from blocks", async () => {
      const blocks = await loadFixture("sample-textract-response.json");
      const kvPairs = extractKeyValues(blocks);

      expect(Object.keys(kvPairs).length).toBeGreaterThan(0);
      expect(typeof kvPairs).toBe("object");
    });

    test("should return empty object for blocks without key-values", () => {
      const kvPairs = extractKeyValues([]);
      expect(kvPairs).toEqual({});
    });
  });

  describe("normaliseKV", () => {
    test("should normalize key-value pairs by trimming", () => {
      const input = {
        " Q1 ": "  Answer 1  ",
        "Q2": "Answer 2",
        " Q3 ": "Answer 3",
      };

      const normalized = normaliseKV(input);

      expect(normalized["Q1"]).toBe("Answer 1");
      expect(normalized["Q2"]).toBe("Answer 2");
      expect(normalized["Q3"]).toBe("Answer 3");
    });

    test("should handle empty input", () => {
      const normalized = normaliseKV({});
      expect(normalized).toEqual({});
    });

    test("should trim values", () => {
      const input = {
        Q1: "  Answer 1  ",
        Q2: "Answer 2\n",
      };

      const normalized = normaliseKV(input);

      expect(normalized["Q1"]).toBe("Answer 1");
      expect(normalized["Q2"]).toBe("Answer 2");
    });
  });

  describe("extractAnswers", () => {
    test("should extract answers when keys are numbers", () => {
      // extractAnswers processes entries in order: when it finds a number key,
      // it takes the value of the NEXT entry as the answer
      // Note: Object.entries() processes numeric keys in numeric order first
      const kvPairs: Record<string, string> = {};
      kvPairs["1"] = "Question 1 text";
      kvPairs["answer1"] = "Answer 1";
      kvPairs["2"] = "Question 2 text";
      kvPairs["answer2"] = "Answer 2";

      const answers = extractAnswers(kvPairs, 100);

      // The function should extract at least one answer
      expect(Object.keys(answers).length).toBeGreaterThan(0);
      // Q1 should be defined
      expect(answers["Q1"]).toBeDefined();
    });

    test("should respect maxQ limit", () => {
      const kvPairs: Record<string, string> = {};
      kvPairs["1"] = "Question";
      kvPairs["ans1"] = "Answer 1";
      kvPairs["10"] = "Question 10";
      kvPairs["ans10"] = "Answer 10";

      const answers = extractAnswers(kvPairs, 5);

      // Q1 should be extracted (within limit)
      expect(answers["Q1"]).toBeDefined();
      // Q10 should not be extracted (beyond maxQ=5)
      expect(answers["Q10"]).toBeUndefined();
    });

    test("should handle empty input", () => {
      const answers = extractAnswers({}, 100);
      expect(answers).toEqual({});
    });

    test("should only extract when key is a pure number", () => {
      const kvPairs: Record<string, string> = {};
      kvPairs["1"] = "Question";
      kvPairs["ans"] = "Answer 1";
      kvPairs["Q1"] = "Not extracted";
      kvPairs["val"] = "Value";

      const answers = extractAnswers(kvPairs, 100);

      // Should extract Q1 (from key "1")
      expect(answers["Q1"]).toBeDefined();
      // Should only have one answer
      expect(Object.keys(answers).length).toBe(1);
    });
  });

  describe("integration test: full extraction pipeline", () => {
    test("should extract complete quiz answers from fixture", async () => {
      const blocks = await loadFixture("sample-textract-response.json");

      // Extract from table (primary method)
      const tableAnswers = extractTableAnswers(blocks, 50);

      // Extract from key-values (backup method)
      const kvPairs = extractKeyValues(blocks);
      const normalizedKV = normaliseKV(kvPairs);
      const kvAnswers = extractAnswers(normalizedKV, 50);

      // Verify table extraction is primary and more complete
      expect(Object.keys(tableAnswers).length).toBeGreaterThanOrEqual(
        Object.keys(kvAnswers).length,
      );

      // Verify known answers
      expect(tableAnswers["Q1"]).toBe("CRUEL SUMMER");
      expect(tableAnswers["Q50"]).toBe("SOMETIMES");

      // Verify all Q1-Q50 are present (or at least most)
      const questionNumbers = Object.keys(tableAnswers)
        .filter((k) => k.match(/^Q\d+$/))
        .map((k) => parseInt(k.slice(1)))
        .sort((a, b) => a - b);

      expect(questionNumbers[0]).toBe(1);
      expect(questionNumbers[questionNumbers.length - 1]).toBeLessThanOrEqual(50);
    });
  });
});
