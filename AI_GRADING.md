# AI Grading Module

## Overview

The AI grading module uses OpenAI's GPT models to intelligently grade quiz answers with tolerance for:
- Spelling errors and OCR mistakes
- Synonyms and alternative phrasings
- Valid alternative answers not in the answer key

## Setup

1. Install dependencies (already done):
   ```bash
   bun install
   ```

2. Set your OpenAI API key:
   ```bash
   export OPENAI_API_KEY=sk-your-key-here
   ```

## Usage

### Basic Grading

```bash
bun run index.ts --folder ./answerSheets --grade --answer-key ./answer-key.json
```

### With Mock Data (Recommended for Development)

```bash
# First run: Save Textract data
bun run index.ts --folder ./answerSheets --save-mock

# Subsequent runs: Use saved data + grade
bun run index.ts --folder ./answerSheets --use-mock --grade --answer-key ./answer-key.json
```

### With Question Context

```bash
bun run index.ts --folder ./answerSheets --use-mock --grade \
  --answer-key ./answer-key.json \
  --questions ./questions.json
```

## File Formats

### answer-key.json
```json
{
  "Q1": "Paris",
  "Q2": "Photosynthesis",
  "Q3": "William Shakespeare"
}
```

### questions.json (optional but recommended)
```json
{
  "Q1": "What is the capital of France?",
  "Q2": "What is the process by which plants make their food?",
  "Q3": "Who wrote Romeo and Juliet?"
}
```

## Output Format

The grading results are included in the JSON output:

```json
{
  "1": {
    "name": "John Doe",
    "email": "john@example.com",
    "answers": {
      "Q1": "Parris",
      "Q2": "photo synthesis",
      "Q3": "Shakespeare"
    },
    "grading": {
      "totalQuestions": 3,
      "correctAnswers": 3,
      "incorrectAnswers": 0,
      "possibleAlternatives": 0,
      "grades": [
        {
          "question": "Q1",
          "submittedAnswer": "Parris",
          "correctAnswer": "Paris",
          "isCorrect": true,
          "confidence": "high",
          "notes": "Spelling variation accepted"
        },
        {
          "question": "Q2",
          "submittedAnswer": "photo synthesis",
          "correctAnswer": "Photosynthesis",
          "isCorrect": true,
          "confidence": "high",
          "notes": "Spacing variation accepted"
        },
        {
          "question": "Q3",
          "submittedAnswer": "Shakespeare",
          "correctAnswer": "William Shakespeare",
          "isCorrect": true,
          "confidence": "medium",
          "notes": "Partial name accepted as correct"
        }
      ]
    }
  }
}
```

## Confidence Levels

- **high**: Clearly correct or clearly incorrect
- **medium**: Mostly correct with minor variations
- **low**: Potentially valid alternative answer - requires human review

## Cost Estimation

Using `gpt-4o-mini` (default):
- ~$0.15 per 1M input tokens
- ~$0.60 per 1M output tokens
- Typical cost per student: $0.001-0.003 (less than a penny)

For 100 students: ~$0.10-0.30

## Examples of Tolerance

The AI grader handles:

1. **Spelling Errors**: "Parris" → "Paris" ✅
2. **OCR Mistakes**: "H20" → "H2O" ✅
3. **Synonyms**: "water" → "H2O" ✅
4. **Spacing**: "photo synthesis" → "Photosynthesis" ✅
5. **Partial Names**: "Shakespeare" → "William Shakespeare" ✅
6. **Alternative Answers**: "The Sun" for "What produces light in our solar system?" 💡

## Alternative Answers

When the AI detects a potentially valid alternative answer, it will:
- Mark it as incorrect with **low confidence**
- Add detailed notes explaining why it might be valid
- Increment the `possibleAlternatives` counter
- Highlight it in the console output for human review

Example:
```json
{
  "question": "Q7",
  "submittedAnswer": "The Sun",
  "correctAnswer": "Nuclear fusion",
  "isCorrect": false,
  "confidence": "low",
  "notes": "Alternative answer: The student answered with the location rather than the process. While not the expected answer, 'The Sun' is where nuclear fusion occurs and produces light. Consider partial credit."
}
```

## Tips

1. **Use mock mode** during development to avoid repeated API calls
2. **Include question texts** for better grading context
3. **Review low-confidence answers** - these may be valid alternatives
4. **Adjust answer key** based on recurring valid alternatives
5. **Use with real data first** to save Textract responses, then iterate on grading logic
