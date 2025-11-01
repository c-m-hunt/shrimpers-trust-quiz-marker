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
      "OpenAI API key not found. Set OPENAI_API_KEY environment variable or pass it to initializeOpenAI()"
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
  } = {}
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

  const prompt = `You are an expert exam grader. Your task is to grade student answers with fairness and understanding, especially considering OCR errors from scanned documents.

For each question, you will receive:
1. The question text
2. The expected correct answer
3. The student's submitted answer (from OCR, may have spelling errors)

Your job is to:
- Determine if the answer is correct, considering:
  * Spelling variations and OCR errors
  * Capitalization and spacing errors
  * Synonyms and alternative phrasings
  * Partial correctness
- Identify potentially valid alternative answers that weren't in the answer key
- Provide confidence level: "high" (clearly correct/incorrect), "medium" (correct but with minor OCR/formatting issues), "low" (alternative answer that may be valid)

Return a JSON array with this structure for each question:
{
  "question": "Q1",
  "isCorrect": true/false,
  "confidence": "high"/"medium"/"low",
  "notes": "Optional explanation, especially for OCR errors or alternative answers"
}

Guidelines for Grading:

**ALWAYS MARK AS CORRECT (isCorrect: true) with MEDIUM confidence** if the answer is clearly recognizable despite:
  * Minor spelling errors: "Parris" = "Paris", "Portsmonth" = "Portsmouth", "Huddersfeild" = "Huddersfield"
  * Missing/extra letters: "Portsmoth" = "Portsmouth", "Leceister" = "Leicester"
  * Capitalization errors: "milton keynes Dons" = "Milton Keynes Dons", "aston villa" = "Aston Villa"
  * Spacing errors: "Notting ham forest" = "Nottingham Forest", "photo synthesis" = "Photosynthesis"
  * Letter substitutions: "Portsmonth" = "Portsmouth" (o/ou confusion)
  * These should be marked as isCorrect: true, confidence: "medium" with a note like "Minor spelling/OCR error"

**MARK AS CORRECT (isCorrect: true) with HIGH confidence** for:
  * Exact matches or near-exact matches with only trivial differences
  * Synonyms: "H2O" = "water"
  * Partial names when unambiguous: "Shakespeare" = "William Shakespeare"

**MARK AS INCORRECT (isCorrect: false) with LOW confidence** for:
  * Different but possibly valid alternative answers or interpretations
  * Add detailed explanatory notes for human review
  * Example: Answer is "The Sun" when expecting "Nuclear fusion"

**MARK AS INCORRECT (isCorrect: false) with HIGH confidence** for:
  * Completely wrong answers with different meaning
  * Empty or "N/A" submitted answers
  * Answers that are clearly a different subject

CRITICAL RULE: If you can recognize what the student meant to write, even with spelling errors, mark it as CORRECT. The student demonstrated knowledge of the correct answer. Only mark as incorrect if it's genuinely wrong or ambiguous.

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
          "You are a precise exam grading assistant. Return only valid JSON arrays.",
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
    (g) => !g.isCorrect && g.confidence === "low" && g.notes
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
  } = {}
): Promise<GradingResult> {
  const maxRetries = options.maxRetries || 3;
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      logger.debug(`Grading attempt ${attempt}/${maxRetries}`);
      return await gradeAnswers(
        questions,
        correctAnswers,
        submittedAnswers,
        options
      );
    } catch (err) {
      lastError = err as Error;
      logger.warn(`Grading attempt ${attempt} failed`, {
        error: err,
        attempt,
        maxRetries,
      });
      if (attempt < maxRetries) {
        const delay = Math.min(1000 * Math.pow(2, attempt - 1), 5000);
        logger.info(`Retrying in ${delay}ms...`);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  logger.error("Grading failed after all retries", { maxRetries, lastError });
  throw lastError || new Error("Grading failed after all retries");
}
