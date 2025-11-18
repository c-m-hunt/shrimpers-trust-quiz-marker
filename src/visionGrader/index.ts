import { readFile } from "node:fs/promises";
import OpenAI from "openai";
import { createContextLogger } from "../logger.js";

const logger = createContextLogger("visionGrader");

export type VisionQuestionGrade = {
  question_number: string;
  actual_answer: string;
  user_answer: string;
  is_correct: boolean;
  confidence: number;
  notes?: string;
};

export type VisionGradingResult = {
  totalQuestions: number;
  correctAnswers: number;
  incorrectAnswers: number;
  grades: VisionQuestionGrade[];
  processingNotes?: string;
};

let openaiClient: OpenAI | null = null;

export function initializeVisionGrader(apiKey?: string) {
  const key = apiKey || process.env.OPENAI_API_KEY;
  if (!key) {
    logger.error("OpenAI API key not found");
    throw new Error(
      "OpenAI API key not found. Set OPENAI_API_KEY environment variable or pass it to initializeVisionGrader()",
    );
  }
  openaiClient = new OpenAI({ apiKey: key });
  logger.info("Vision grader initialized successfully");
}

function getClient(): OpenAI {
  if (!openaiClient) {
    initializeVisionGrader();
  }
  return openaiClient!;
}

/**
 * Convert image file to base64 data URL
 */
async function imageToBase64DataUrl(imagePath: string): Promise<string> {
  const imageBuffer = await readFile(imagePath);
  const base64 = imageBuffer.toString("base64");

  // Detect image type from extension
  const ext = imagePath.toLowerCase().split(".").pop();
  const mimeType = ext === "png" ? "image/png" : "image/jpeg";

  return `data:${mimeType};base64,${base64}`;
}

/**
 * Build the improved vision grading prompt
 */
function buildVisionPrompt(answerKey: Record<string, string>): string {
  return `You are an expert quiz grader analyzing handwritten answer sheets. Your task is to accurately read and grade answers, being LENIENT with spelling mistakes and handwriting variations.

ANSWER SHEET STRUCTURE:
- The sheet has 6 columns arranged as: Q# | Question | Answer | Q# | Question | Answer
- Columns 1 & 4: Question numbers (Q1, Q2, etc.)
- Columns 2 & 5: Question text (you can ignore these)
- Columns 3 & 6: Handwritten answers (FOCUS HERE)

YOUR TASK:
1. **Read all handwritten answers** from columns 3 and 6
2. **Compare each answer** against the master answer key provided below
3. **Be LENIENT** - Accept answers with:
   - Spelling mistakes (e.g., "Parris" for "Paris")
   - Missing or extra letters (e.g., "Portsmoth" for "Portsmouth")
   - Capitalization errors (e.g., "cruel summer" for "CRUEL SUMMER")
   - Minor word variations (e.g., "Ms. Jackson" for "MS JACKSON")
   - Phonetic spellings (e.g., "Lester" for "Leicester")
4. **Assess confidence** - How certain are you about what was written? (0-100%)

GRADING PHILOSOPHY:
✅ Mark as CORRECT if:
- The answer clearly matches the intent, even with spelling errors
- You can reasonably interpret what they meant to write
- The core concept is correct (e.g., abbreviations, partial names when unambiguous)

❌ Mark as INCORRECT only if:
- The answer is completely different from the expected answer
- The answer is blank or unclear
- The answer is clearly about a different subject

CONFIDENCE SCORING:
- 95-100: Perfect or near-perfect match
- 80-94: Clear match despite spelling/handwriting issues
- 60-79: Answer is interpretable but has significant variations
- 40-59: Uncertain about what was written but best guess matches
- 0-39: Very unclear or doesn't match expected answer

MASTER ANSWER KEY:
${JSON.stringify(answerKey, null, 2)}

RESPONSE FORMAT:
Return a JSON object with this structure:
{
  "grades": [
    {
      "question_number": "Q1",
      "actual_answer": "CRUEL SUMMER",
      "user_answer": "cruel sumer",
      "is_correct": true,
      "confidence": 85,
      "notes": "Spelling variation accepted"
    }
  ],
  "processing_notes": "Optional overall notes about the grading process"
}

IMPORTANT INSTRUCTIONS:
- Return ONLY valid JSON, no other text
- Grade ALL ${Object.keys(answerKey).length} questions from the answer key
- If you cannot read an answer clearly, note it in the "notes" field and give low confidence
- Focus on the CONTENT and MEANING, not perfect spelling
- Be GENEROUS with handwriting interpretation - students shouldn't be penalized for unclear writing
- When in doubt between correct/incorrect, prefer CORRECT with lower confidence`;
}

/**
 * Grade quiz answers using vision model directly on the image
 */
export async function gradeQuizWithVision(
  imagePaths: string[],
  answerKey: Record<string, string>,
  options: {
    model?: string;
    temperature?: number;
    maxTokens?: number;
  } = {},
): Promise<VisionGradingResult> {
  const client = getClient();
  const model = options.model || "gpt-4o";
  const temperature = options.temperature || 0.3;
  const maxTokens = options.maxTokens || 4096;

  logger.info(`Starting vision-based grading for ${imagePaths.length} image(s)`, {
    model,
    temperature,
    questionCount: Object.keys(answerKey).length,
  });

  // Convert all images to base64
  const imageDataUrls = await Promise.all(
    imagePaths.map(async (path) => {
      logger.debug(`Converting image to base64: ${path}`);
      return await imageToBase64DataUrl(path);
    }),
  );

  // Build the messages with all images
  const imageMessages: OpenAI.Chat.ChatCompletionContentPart[] = imageDataUrls.map((url) => ({
    type: "image_url" as const,
    image_url: {
      url,
      detail: "high" as const,
    },
  }));

  const prompt = buildVisionPrompt(answerKey);

  logger.debug("Sending vision grading request to OpenAI", {
    model,
    imageCount: imagePaths.length,
    questionCount: Object.keys(answerKey).length,
  });

  const completion = await client.chat.completions.create({
    model,
    temperature,
    max_tokens: maxTokens,
    messages: [
      {
        role: "system",
        content:
          "You are an expert quiz grader who analyzes handwritten answer sheets. You are lenient with spelling and handwriting issues. Return only valid JSON responses.",
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: prompt,
          },
          ...imageMessages,
        ],
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
    logger.debug("Successfully parsed OpenAI vision response");
  } catch (err) {
    logger.error("Failed to parse OpenAI vision response", {
      responseText,
      error: err,
    });
    throw new Error(`Failed to parse OpenAI vision response: ${responseText}`);
  }

  // Extract grades from response
  const gradesArray: VisionQuestionGrade[] = parsedResponse.grades || [];

  if (gradesArray.length === 0) {
    logger.warn("No grades returned from vision model", { response: parsedResponse });
  }

  // Calculate statistics
  const correctCount = gradesArray.filter((g) => g.is_correct).length;
  const incorrectCount = gradesArray.length - correctCount;

  // Sort grades by question number for consistent output
  gradesArray.sort((a, b) => {
    const numA = Number.parseInt(a.question_number.replace(/\D/g, ""), 10);
    const numB = Number.parseInt(b.question_number.replace(/\D/g, ""), 10);
    return numA - numB;
  });

  logger.info(`Vision grading complete: ${correctCount}/${gradesArray.length} correct`, {
    correctCount,
    incorrectCount,
    totalQuestions: gradesArray.length,
  });

  // Log low confidence answers for review
  const lowConfidenceAnswers = gradesArray.filter((g) => g.confidence < 60);
  if (lowConfidenceAnswers.length > 0) {
    logger.warn(`Found ${lowConfidenceAnswers.length} answers with low confidence (<60%)`, {
      questions: lowConfidenceAnswers.map((g) => ({
        question: g.question_number,
        userAnswer: g.user_answer,
        confidence: g.confidence,
      })),
    });
  }

  return {
    totalQuestions: gradesArray.length,
    correctAnswers: correctCount,
    incorrectAnswers: incorrectCount,
    grades: gradesArray,
    processingNotes: parsedResponse.processing_notes,
  };
}

/**
 * Grade quiz with retry logic
 */
export async function gradeQuizWithVisionRetry(
  imagePaths: string[],
  answerKey: Record<string, string>,
  options: {
    model?: string;
    temperature?: number;
    maxTokens?: number;
    maxRetries?: number;
  } = {},
): Promise<VisionGradingResult> {
  const maxRetries = options.maxRetries || 3;
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      logger.debug(`Vision grading attempt ${attempt}/${maxRetries}`);
      return await gradeQuizWithVision(imagePaths, answerKey, options);
    } catch (err) {
      lastError = err as Error;
      logger.warn(`Vision grading attempt ${attempt} failed`, {
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

  logger.error("Vision grading failed after all retries", { maxRetries, lastError });
  throw lastError || new Error("Vision grading failed after all retries");
}
