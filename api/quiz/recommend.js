/*
 * POST /api/quiz/recommend  —  compute a recommendation without saving anything
 * ============================================================================
 * The quiz shows the match BEFORE asking for an email ("no login required to
 * start"), so this endpoint exists to produce that result with no email and no
 * database write.
 *
 * Recommendation logic lives once, in api/_lib/catalog.js, and runs on the
 * server for both this preview and the saved submission — so the product shown
 * to the visitor is always exactly the product recorded against their answers,
 * and it always maps to a real NAFUME product.
 *
 * Body: { answers: { mood, occasion, strength, family, purpose } }
 */
"use strict";

const http    = require("../_lib/http");
const catalog = require("../_lib/catalog");

module.exports = async function handler(req, res) {
  if (!http.guard(req, res, "POST")) return;
  if (!http.rateLimit(req, res, { key: "quiz-recommend", limit: 60, windowMs: 10 * 60 * 1000 })) return;

  const body = await http.body(req, res);
  if (!body) return;

  const result = catalog.recommend(body.answers || body);
  if (!result.valid) {
    return http.fail(res, 400, "incomplete_quiz", result.message);
  }

  return http.ok(res, {
    product:   result.product,
    alternate: result.alternate,
    tags:      result.tags,
    answered:  result.answered
  });
};
