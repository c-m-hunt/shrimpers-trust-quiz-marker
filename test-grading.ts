#!/usr/bin/env bun

/**
 * Test script for AI grading module
 * 
 * This demonstrates the AI grading functionality without needing
 * actual Textract data or image files.
 */

import { initializeOpenAI, gradeAnswersWithRetry } from "./src/aiGrader.js";

// Example questions
const questions = {
  Q1: "What is the capital of France?",
  Q2: "What is the chemical formula for water?",
  Q3: "Who wrote Romeo and Juliet?",
  Q4: "What is the largest planet in our solar system?",
  Q5: "What year was the Declaration of Independence signed?",
};

// Correct answers
const correctAnswers = {
  Q1: "Paris",
  Q2: "H2O",
  Q3: "William Shakespeare",
  Q4: "Jupiter",
  Q5: "1776",
};

// Student submissions (with various types of errors and alternatives)
const studentAnswers = {
  Q1: "Parris", // Spelling error
  Q2: "water", // Synonym
  Q3: "Shakespeare", // Partial name
  Q4: "Jupiter", // Exact match
  Q5: "1775", // Wrong but close
};

console.log("🧪 Testing AI Grading Module\n");
console.log("Questions:", questions);
console.log("\nCorrect Answers:", correctAnswers);
console.log("\nStudent Answers:", studentAnswers);
console.log("\n" + "=".repeat(60));

try {
  initializeOpenAI();
  console.log("✓ OpenAI initialized\n");

  console.log("🤖 Grading in progress...\n");
  const result = await gradeAnswersWithRetry(
    questions,
    correctAnswers,
    studentAnswers,
    { model: "gpt-4o-mini" }
  );

  console.log("=".repeat(60));
  console.log("📊 GRADING RESULTS");
  console.log("=".repeat(60));
  console.log(`Score: ${result.correctAnswers}/${result.totalQuestions}`);
  console.log(
    `Percentage: ${((result.correctAnswers / result.totalQuestions) * 100).toFixed(1)}%`
  );
  console.log(`Possible alternatives: ${result.possibleAlternatives}\n`);

  console.log("Detailed Results:");
  console.log("-".repeat(60));

  for (const grade of result.grades) {
    const icon = grade.isCorrect ? "✅" : "❌";
    const confidence = grade.confidence.toUpperCase();
    console.log(`\n${icon} ${grade.question} [${confidence}]`);
    console.log(`   Question: ${questions[grade.question as keyof typeof questions]}`);
    console.log(`   Expected: "${grade.correctAnswer}"`);
    console.log(`   Submitted: "${grade.submittedAnswer}"`);
    if (grade.notes) {
      console.log(`   💡 Notes: ${grade.notes}`);
    }
  }

  console.log("\n" + "=".repeat(60));
  console.log("✨ Test completed successfully!");

  if (result.possibleAlternatives > 0) {
    console.log(
      "\n⚠️  Some answers were marked as potentially valid alternatives."
    );
    console.log("    Review the notes above for details.");
  }
} catch (err) {
  console.error("❌ Test failed:", err);
  process.exit(1);
}
