import OpenAI from "openai";
import { createContextLogger } from "./logger.js";

const logger = createContextLogger("aiGrader");

export type QuestionGrade = {
  question: string;
  submittedAnswer: string;
  correctAnswer: string;
  isCorrect: boolean;
  confidence: "high" | "medium" | "low";
  notes?: string;
};

export type GradingResult = {
  totalQuestions: number;
  correctAnswers: number;
  incorrectAnswers: number;
  possibleAlternatives: number;
  grades: QuestionGrade[];
};

let openaiClient: OpenAI | null = null;

export function initializeOpenAI(apiKey?: string) {
  const key = apiKey || process.env.OPENAI_API_KEY;
  if (!key) {
    logger.error("OpenAI API key not found");
    throw new Error(
      "OpenAI API key not found. Set OPENAI_API_KEY environment variable or pass it to initializeOpenAI()",
    );
  }
  openaiClient = new OpenAI({ apiKey: key });
  logger.info("OpenAI client initialized successfully");
}

function getClient(): OpenAI {
  if (!openaiClient) {
    initializeOpenAI();
  }
  return openaiClient!;
}

export async function gradeAnswers(
  questions: Record<string, string>, // Q1 -> "What is the capital of France?"
  correctAnswers: Record<string, string>, // Q1 -> "Paris"
  submittedAnswers: Record<string, string>, // Q1 -> "Parris"
  options: {
    model?: string;
    temperature?: number;
  } = {},
): Promise<GradingResult> {
  const client = getClient();
  const model = options.model || "gpt-4o-mini";
  const temperature = options.temperature || 0.3;

  // Build the grading request
  const questionList = Object.keys(questions).sort();
  const gradingData = questionList.map((q) => ({
    question: q,
    questionText: questions[q] || "Question text not available",
    correctAnswer: correctAnswers[q] || "",
    submittedAnswer: submittedAnswers[q] || "",
  }));

  logger.info(`Starting AI grading for ${gradingData.length} questions`, {
    model,
    temperature,
  });

  const prompt = `You are a compassionate and optimistic exam grader. Your PRIMARY GOAL is to recognize when entrants have demonstrated knowledge, even when OCR errors and handwriting make answers messy.

FUNDAMENTAL PRINCIPLE: DEFAULT TO MARKING ANSWERS AS CORRECT. Only mark incorrect when the answer is CLEARLY WRONG with no reasonable interpretation that matches the expected answer.

For each question, you will receive:
1. The question text
2. The expected correct answer
3. The entry's submitted answer (from OCR on handwriting - expect spelling errors, misplaced spaces, and character recognition issues)

GRADING PHILOSOPHY:
- Be GENEROUS with OCR and handwriting issues - entries shouldn't be penalized for technology limitations
- If you can reasonably interpret what the entry meant, mark it CORRECT
- When in doubt between correct/incorrect, choose CORRECT
- Spelling, spacing, and capitalization errors should almost NEVER cause an answer to be marked wrong
- Focus on whether the CONCEPT/KNOWLEDGE is demonstrated, not perfect spelling

Return a JSON array with this structure for each question:
{
  "question": "Q1",
  "isCorrect": true/false,
  "confidence": "high"/"medium"/"low",
  "notes": "Optional explanation, especially for OCR errors or alternative answers"
}

GRADING RULES (in order of priority):

🟢 **ALWAYS MARK AS CORRECT (isCorrect: true)** for:

1. **HIGH confidence** - Perfect or near-perfect answers:
   * Exact matches
   * Synonyms: "H2O" = "water", "automobile" = "car"
   * Partial names when unambiguous: "Shakespeare" = "William Shakespeare", "Obama" = "Barack Obama"
   * Abbreviations: "USA" = "United States", "UK" = "United Kingdom"

2. **MEDIUM confidence** - Answers with OCR/handwriting issues but CLEARLY recognizable:
   * Minor spelling errors: "Parris" = "Paris", "Portsmonth" = "Portsmouth", "Huddersfeild" = "Huddersfield"
   * Multiple spelling errors: "Manchster Untied" = "Manchester United"
   * Missing/extra letters: "Portsmoth" = "Portsmouth", "Leceister" = "Leicester", "Photosynthsis" = "Photosynthesis"
   * Capitalization errors: "milton keynes Dons" = "Milton Keynes Dons", "aston villa" = "Aston Villa"
   * Spacing errors: "Notting ham forest" = "Nottingham Forest", "photo synthesis" = "Photosynthesis"
   * Letter substitutions: "Portsmonth" = "Portsmouth" (o/ou), "Liverp00l" = "Liverpool" (0/o)
   * Phonetic spellings: "Lester" = "Leicester", "Portsmuth" = "Portsmouth"
   * Combined issues: "manchestr untied" = "Manchester United"
   * Add note like "Recognized despite OCR/spelling errors"

3. **MEDIUM confidence** - Alternative correct answers not in answer key:
   * Different but equally valid answers: "photosynthesis" when expecting "converts sunlight to energy"
   * More specific or more general answers that are technically correct
   * Add note explaining why this is also correct

⚠️ **MARK AS INCORRECT (isCorrect: false) with LOW confidence** ONLY for:
   * Answers that MIGHT be valid alternative interpretations but are quite different from expected
   * You're uncertain if the alternative interpretation is valid
   * Add detailed explanatory notes for human review
   * Example: Answer is "The Sun" when expecting "Nuclear fusion" - related but not the same

❌ **MARK AS INCORRECT (isCorrect: false) with HIGH confidence** ONLY for:
   * Answers that are COMPLETELY WRONG with a totally different meaning
   * Empty answers, "N/A", "I don't know", or no attempt
   * Answers that are clearly about a completely different subject
   * Even then, double-check if there could be an OCR misreading

🚨 CRITICAL RULES:
1. If you can recognize what the entrant meant to write (even with severe spelling errors), mark it CORRECT
2. OCR and handwriting issues should NEVER be the sole reason for marking incorrect
3. When uncertain, ALWAYS default to CORRECT
4. The entrant demonstrated knowledge if you can decode their answer - that's what matters
5. Be especially generous with proper nouns (names, places) which are often spelled phonetically

Here are the questions to grade:

${JSON.stringify(gradingData, null, 2)}

Return ONLY the JSON array, no other text.`;

  logger.debug("Sending request to OpenAI", {
    model,
    questionCount: gradingData.length,
  });

  const completion = await client.chat.completions.create({
    model,
    temperature,
    messages: [
      {
        role: "system",
        content:
          "You are a compassionate exam grading assistant who defaults to recognizing entrant's knowledge despite OCR and handwriting issues. Return only valid JSON arrays.",
      },
      {
        role: "user",
        content: prompt,
      },
    ],
    response_format: { type: "json_object" },
  });

  logger.debug("Received response from OpenAI", {
    finishReason: completion.choices[0]?.finish_reason,
    tokensUsed: completion.usage,
  });

  const responseText = completion.choices[0]?.message?.content || "{}";
  let parsedResponse: any;

  try {
    parsedResponse = JSON.parse(responseText);
    logger.debug("Successfully parsed OpenAI response");
  } catch (err) {
    logger.error("Failed to parse OpenAI response", {
      responseText,
      error: err,
    });
    throw new Error(`Failed to parse OpenAI response: ${responseText}`);
  }

  // Handle different response formats
  const gradesArray = Array.isArray(parsedResponse)
    ? parsedResponse
    : parsedResponse.grades || parsedResponse.results || [];

  // Build the result
  const grades: QuestionGrade[] = gradesArray.map((grade: any, idx: number) => {
    const q = grade.question || questionList[idx];
    return {
      question: q,
      submittedAnswer: submittedAnswers[q] || "",
      correctAnswer: correctAnswers[q] || "",
      isCorrect: grade.isCorrect || false,
      confidence: grade.confidence || "medium",
      notes: grade.notes || undefined,
    };
  });

  const correctCount = grades.filter((g) => g.isCorrect).length;
  const possibleAlternatives = grades.filter(
    (g) => !g.isCorrect && g.confidence === "low" && g.notes,
  ).length;

  logger.info(`Grading complete: ${correctCount}/${grades.length} correct`, {
    possibleAlternatives,
    incorrectCount: grades.length - correctCount,
  });

  return {
    totalQuestions: grades.length,
    correctAnswers: correctCount,
    incorrectAnswers: grades.length - correctCount,
    possibleAlternatives,
    grades,
  };
}

export async function gradeAnswersWithRetry(
  questions: Record<string, string>,
  correctAnswers: Record<string, string>,
  submittedAnswers: Record<string, string>,
  options: {
    model?: string;
    temperature?: number;
    maxRetries?: number;
  } = {},
): Promise<GradingResult> {
  const maxRetries = options.maxRetries || 3;
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      logger.debug(`Grading attempt ${attempt}/${maxRetries}`);
      return await gradeAnswers(questions, correctAnswers, submittedAnswers, options);
    } catch (err) {
      lastError = err as Error;
      logger.warn(`Grading attempt ${attempt} failed`, {
        error: err,
        attempt,
        maxRetries,
      });
      if (attempt < maxRetries) {
        const delay = Math.min(1000 * 2 ** (attempt - 1), 5000);
        logger.info(`Retrying in ${delay}ms...`);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  logger.error("Grading failed after all retries", { maxRetries, lastError });
  throw lastError || new Error("Grading failed after all retries");
}
