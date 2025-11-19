# Vision Grading

The vision grading feature allows you to grade quiz answer sheets by sending images directly to a vision-capable AI model (Google Gemini or OpenAI GPT-4o), bypassing the need for AWS Textract OCR processing.

## Benefits

- **Simpler**: Single API call instead of Textract + AI grading pipeline
- **More Accurate**: Vision models can understand document layout and context better
- **Cost Effective**: No AWS Textract charges
- **Better Handwriting Recognition**: Vision models are trained on diverse handwriting samples
- **Context Aware**: Understands the 6-column layout and can handle challenging layouts
- **Flexible**: Choose between Google Gemini (recommended) or OpenAI GPT-4o

## Configuration

In your `config.yaml`:

```yaml
grading:
  enabled: true
  strategy: "vision"       # Use vision grading (default)
  provider: "gemini"       # "gemini" (default, recommended) or "openai"
  answerKeyPath: "./2025/answer-key.json"
  model: "models/gemini-1.5-flash"  # See model options below
  temperature: 0.3
  maxTokens: 4096          # For OpenAI models only
```

### Environment Variables

Set the appropriate API key environment variable:

- **For Gemini**: Set `GEMINI_API_KEY` or `GOOGLE_API_KEY`
- **For OpenAI**: Set `OPENAI_API_KEY`

### Grading Strategies

1. **vision** (default): Direct image-to-AI grading
   - Sends images directly to vision model
   - No Textract required
   - Best for handwritten answer sheets
   - Supports both Gemini and OpenAI models

2. **textract-ai**: Legacy approach using AWS Textract + AI
   - Uses AWS Textract for OCR
   - Then uses AI to grade the OCR results
   - More complex pipeline
   - Uses OpenAI models for grading
   - Recommended models: `gpt-4o-mini`, `gpt-4o`

## Model Selection

### For Vision Strategy with Gemini (Recommended):
- **gemini-1.5-flash** (recommended): Fast, cost-effective, and reliable - best overall choice
- **gemini-1.5-pro**: Most accurate, best for complex documents
- **gemini-2.0-flash-exp**: Experimental model (may be unavailable)

**Why Gemini?**
- Excellent document understanding
- Very fast processing
- Cost-effective
- Great at handling handwriting variations
- Better context awareness for multi-column layouts

### For Vision Strategy with OpenAI:
- **gpt-4o** (recommended): Best balance of accuracy and cost
- **gpt-4o-mini**: Faster and cheaper, slightly less accurate

### For Textract-AI Strategy:
- **gpt-4o-mini** (recommended): Cost-effective for text grading
- **gpt-4o**: More accurate but more expensive

## How It Works

1. **Image Processing**: Reads all image files from the quiz folder
2. **Vision Analysis**: Sends images to the vision model with:
   - Answer key
   - Instructions to read handwritten answers
   - Grading criteria (lenient with spelling/handwriting)
3. **Grading**: Model returns grades with:
   - Question number
   - What the user wrote
   - Whether it's correct
   - Confidence score (0-100)
   - Notes on difficult-to-read answers

## Grading Philosophy

The vision grader is **LENIENT** with:
- Spelling mistakes (e.g., "Parris" for "Paris")
- Capitalization errors
- Missing or extra letters
- Phonetic spellings
- Handwriting variations

It focuses on whether the **concept/knowledge** is demonstrated, not perfect spelling.

## Confidence Scoring

- **95-100**: Perfect or near-perfect match
- **80-94**: Clear match despite spelling/handwriting issues
- **60-79**: Answer is interpretable but has significant variations
- **40-59**: Uncertain about what was written
- **0-39**: Very unclear or doesn't match

Answers with confidence < 60 are flagged for manual review.

## Example Output

```json
{
  "question_number": "Q1",
  "actual_answer": "CRUEL SUMMER",
  "user_answer": "cruel sumer",
  "is_correct": true,
  "confidence": 85,
  "notes": "Spelling variation accepted"
}
```

## Switching Between Providers

### To use Gemini (Recommended):
```yaml
grading:
  enabled: true
  strategy: "vision"
  provider: "gemini"
  model: "gemini-1.5-flash"  # or "gemini-1.5-pro"
  # Set GEMINI_API_KEY environment variable
```

### To use OpenAI:
```yaml
grading:
  enabled: true
  strategy: "vision"
  provider: "openai"
  model: "gpt-4o"  # or "gpt-4o-mini"
  maxTokens: 4096  # Gemini doesn't need this
  # Set OPENAI_API_KEY environment variable
```

### To use Textract-AI (Legacy):
```yaml
grading:
  enabled: true
  strategy: "textract-ai"  # Change from "vision"
  model: "gpt-4o-mini"     # Use cheaper model for text grading
  # Set OPENAI_API_KEY environment variable
```

## Cost Considerations

### Gemini (Recommended):
- **gemini-1.5-flash**: Most cost-effective option (recommended)
- **gemini-1.5-pro**: Very cost-effective, excellent value
- **gemini-2.0-flash-exp**: Experimental (may be unavailable)
- Typical: ~$0.001-0.01 per quiz

### OpenAI:
- Typical: ~$0.01-0.05 per quiz with gpt-4o
- More expensive than Gemini for similar quality

### Textract-AI:
- AWS Textract: ~$1.50 per 1000 pages
- AI Grading: ~$0.001-0.01 per quiz
- Most expensive overall due to Textract costs

## Getting API Keys

### Gemini API Key:
1. Go to [Google AI Studio](https://makersuite.google.com/app/apikey)
2. Create an API key
3. Set it as `GEMINI_API_KEY` or `GOOGLE_API_KEY` environment variable

### OpenAI API Key:
1. Go to [OpenAI API Keys](https://platform.openai.com/api-keys)
2. Create an API key
3. Set it as `OPENAI_API_KEY` environment variable

## Troubleshooting

### Low Confidence Answers
Check the logs for warnings about low confidence answers:
```
Found 3 answers with low confidence (<60%)
```
These may need manual review.

### Vision API Errors
- **Gemini**: Ensure `GEMINI_API_KEY` or `GOOGLE_API_KEY` is set
- **OpenAI**: Ensure `OPENAI_API_KEY` is set
- Check model availability
- Verify image files are in supported formats (jpg, jpeg, png)

### No Answers Detected
- Verify image quality is sufficient
- Check that images contain the expected 6-column layout
- Try adjusting the prompt in [src/visionGrader/index.ts](src/visionGrader/index.ts#L106) if needed
- Try switching providers (Gemini vs OpenAI) to compare results

### Rate Limiting
- Gemini has generous rate limits
- OpenAI may rate limit on high volumes
- The system automatically retries failed requests up to 3 times

## Performance Comparison

Based on testing with quiz answer sheets:

| Provider | Speed | Accuracy | Cost | Handwriting Recognition |
|----------|-------|----------|------|------------------------|
| Gemini 1.5 Flash | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐ |
| Gemini 1.5 Pro | ⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ |
| GPT-4o | ⭐⭐⭐⭐ | ⭐⭐⭐⭐ | ⭐⭐⭐ | ⭐⭐⭐⭐ |
| GPT-4o Mini | ⭐⭐⭐⭐⭐ | ⭐⭐⭐ | ⭐⭐⭐⭐ | ⭐⭐⭐ |

**Recommendation**: Use Gemini 1.5 Flash for the best overall balance of speed, accuracy, and cost.
