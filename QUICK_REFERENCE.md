# Quick Reference Card

## Common Commands

### First Time Setup
```bash
# 1. Install dependencies
bun install

# 2. Set OpenAI key
export OPENAI_API_KEY=sk-your-key-here

# 3. Process images and save Textract data
bun run index.ts --folder ./answerSheets --save-mock

# 4. Create answer-key.json (see answer-key.example.json)
```

### Daily Usage
```bash
# Grade all students with AI
bun run index.ts --folder ./answerSheets --use-mock --grade --answer-key ./answer-key.json

# Grade with question context (better results)
bun run index.ts --folder ./answerSheets --use-mock --grade \
  --answer-key ./answer-key.json --questions ./questions.json
```

### Testing
```bash
# Test AI grading without images
bun run test-grading.ts

# Process without grading
bun run index.ts --folder ./answerSheets --use-mock
```

## File Formats

### answer-key.json
```json
{
  "Q1": "Paris",
  "Q2": "Photosynthesis"
}
```

### questions.json (optional)
```json
{
  "Q1": "What is the capital of France?",
  "Q2": "How do plants make food?"
}
```

## Understanding Output

### Console
```
Processing: student-1...
  📊 Score: 8/10 (80.0%) | Possible alternatives: 1
  💡 Review these questions for alternative answers:
     - Q7: "The Sun" (Expected: "Nuclear fusion")
```

### JSON
```json
{
  "student-1": {
    "name": "John Doe",
    "email": "john@example.com",
    "answers": { "Q1": "Parris" },
    "grading": {
      "correctAnswers": 1,
      "totalQuestions": 1,
      "possibleAlternatives": 0,
      "grades": [
        {
          "question": "Q1",
          "submittedAnswer": "Parris",
          "correctAnswer": "Paris",
          "isCorrect": true,
          "confidence": "high",
          "notes": "Spelling variation accepted"
        }
      ]
    }
  }
}
```

## Flags Reference

| Flag | Description | Example |
|------|-------------|---------|
| `--folder` | Directory with subdirectories of images | `--folder ./answerSheets` |
| `--save-mock` | Save Textract responses for later | `--save-mock` |
| `--use-mock` | Use saved Textract data (no API calls) | `--use-mock` |
| `--grade` | Enable AI grading | `--grade` |
| `--answer-key` | Path to correct answers JSON | `--answer-key ./answer-key.json` |
| `--questions` | Path to questions JSON (optional) | `--questions ./questions.json` |
| `--maxQ` | Max question number (default: 100) | `--maxQ 50` |
| `--pages` | Explicit page order | `--pages page-1.jpg page-2.jpg` |

## Confidence Levels

| Level | Meaning | Action |
|-------|---------|--------|
| **HIGH** | Clearly correct or incorrect | Trust the grading |
| **MEDIUM** | Minor variations accepted | Trust the grading |
| **LOW** | Potentially valid alternative | **Review manually** |

## Tips

1. ✅ Always use `--use-mock` after first run to save API costs
2. ✅ Include `--questions` for better grading accuracy
3. ✅ Review low-confidence answers for valid alternatives
4. ✅ Update answer key when you find recurring alternatives
5. ✅ Test grading logic with `test-grading.ts` first

## Cost

- First run (Textract): ~$0.015 per page (AWS)
- AI grading: ~$0.001-0.003 per student (OpenAI)
- Mock mode: FREE (uses saved data)

## Troubleshooting

**OpenAI errors?**
- Check API key: `echo $OPENAI_API_KEY`
- Verify balance in OpenAI dashboard

**No subdirectories found?**
- Ensure folder structure: `answerSheets/1/page-1.jpg`, `answerSheets/2/page-1.jpg`

**Mock files not found?**
- Run with `--save-mock` first before using `--use-mock`
