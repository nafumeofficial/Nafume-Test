/*
 * GET /api/quiz/questions  —  the fragrance-finder questionnaire
 * ============================================================================
 * Serves the questions and options from api/_lib/catalog.js so the quiz UI has
 * no copy of its own to drift out of sync. Scoring weights are deliberately NOT
 * included in the response — the recommendation is computed server-side.
 *
 * Needs no database, so the quiz still starts even if storage is down; only
 * saving the result requires persistence.
 */
"use strict";

const http    = require("../_lib/http");
const catalog = require("../_lib/catalog");

module.exports = async function handler(req, res) {
  if (!http.guard(req, res, "GET")) return;

  return http.ok(res, {
    questions: catalog.quizQuestions(),
    totalQuestions: catalog.QUIZ.length
  });
};
