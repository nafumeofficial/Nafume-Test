/*
 * POST /api/quiz/submit  —  save a fragrance-finder result against an email
 * ============================================================================
 * Persists three things, which is the whole point of the quiz:
 *   1. a LEAD row  (source: fragrance_quiz) — the email itself
 *   2. a QUIZ_RESPONSES row — the answers, the recommended product, and the
 *      preference tags
 *   3. the link between them (quiz_responses.lead_id)
 *
 * The recommendation is RECOMPUTED here from the submitted answers rather than
 * trusted from the request, so what's stored always matches what the scoring
 * rules actually say and can never be a product that doesn't exist.
 *
 * The tags (oud, evening, strong, floral, subtle, gifting, …) are the
 * segmentation key: `SELECT ... FROM quiz_responses WHERE preference_tags ? 'oud'`
 * is what makes a later campaign targeted instead of generic.
 *
 * Body: { email, answers, marketingOptIn? }
 */
"use strict";

const http      = require("../_lib/http");
const validate  = require("../_lib/validate");
const catalog   = require("../_lib/catalog");
const messaging = require("../_lib/messaging");
const repo      = require("../_lib/repo");
const auth      = require("../_lib/auth");
const db        = require("../_lib/db");

module.exports = async function handler(req, res) {
  if (!http.guard(req, res, "POST")) return;
  if (!http.rateLimit(req, res, { key: "quiz-submit", limit: 15, windowMs: 10 * 60 * 1000 })) return;
  if (!http.requireStorage(res)) return;
  if (!await http.durableLimit(req, res, { key: "quiz-submit-ip", limit: 20, windowMs: 30 * 60 * 1000 })) return;

  const body = await http.body(req, res);
  if (!body) return;

  const emailNorm = validate.normalizeEmail(body.email);
  if (!emailNorm) {
    return http.fail(res, 400, "invalid_email", "Please enter a valid email address to save your result.",
      { fields: { email: "Please enter a valid email address." } });
  }

  const result = catalog.recommend(body.answers || {});
  if (!result.valid) {
    return http.fail(res, 400, "incomplete_quiz", result.message);
  }

  try {
    const now = db.nowISO();
    const emailDisp = validate.displayEmail(body.email);

    /* ── 1. lead ────────────────────────────────────────────────────────── */
    let lead = await db.selectOne("leads", { email_normalized: emailNorm, source: "fragrance_quiz" });
    if (lead) {
      await db.update("leads", {
        where: { id: lead.id },
        set:   { updated_at: now,
                 metadata: Object.assign({}, lead.metadata, { lastTags: result.tags }) }
      });
    } else {
      const row = {
        id:               db.newId(),
        email:            emailDisp,
        email_normalized: emailNorm,
        source:           "fragrance_quiz",
        discount_code:    null,
        discount_label:   null,
        metadata:         { lastTags: result.tags },
        converted_at:     null,
        created_at:       now,
        updated_at:       now
      };
      try {
        const inserted = await db.insert("leads", row);
        lead = (inserted && inserted[0]) || row;
      } catch (err) {
        if (err instanceof db.UniqueViolationError) {
          lead = await db.selectOne("leads", { email_normalized: emailNorm, source: "fragrance_quiz" });
        } else { throw err; }
      }
    }

    /* ── 2. link to a customer when this email already belongs to one ───── */
    // A logged-in visitor's own session takes priority; otherwise match by email.
    let customerId = null;
    const session = await auth.getSession(req);
    if (session) {
      customerId = session.customer.id;
    } else {
      const existing = await repo.findCustomer(emailNorm, null);
      if (existing) customerId = existing.id;
    }

    /* ── 3. the response itself ─────────────────────────────────────────── */
    // Every submission is kept as its own row — retaking the quiz is a genuine
    // signal (tastes change), and the newest row is simply the current one.
    const response = {
      id:                       db.newId(),
      email:                    emailDisp,
      email_normalized:         emailNorm,
      customer_id:              customerId,
      lead_id:                  lead ? lead.id : null,
      answers:                  result.answers,
      recommended_product_id:   result.product.id,
      recommended_product_name: result.product.name,
      alternate_product_id:     result.alternate.id,
      preference_tags:          result.tags,
      source:                   "fragrance_quiz",
      created_at:               now
    };
    await db.insert("quiz_responses", response);

    /* ── 4. optional marketing consent ──────────────────────────────────── */
    if (customerId && body.marketingOptIn !== undefined) {
      await repo.setMarketingConsent(customerId, "email", body.marketingOptIn === true, "quiz");
    }

    /* ── 5. email the result (best effort, reported honestly) ───────────── */
    const mail = await messaging.send({
      channel: "email",
      to: emailDisp,
      subject: "Your NAFUME fragrance match: " + result.product.shortName,
      body: messaging.quizResultEmail(result),
      relatedType: "quiz",
      relatedId: response.id
    });

    return http.ok(res, {
      product:   result.product,
      alternate: result.alternate,
      tags:      result.tags,
      emailed:   mail.sent === true,
      message:   "Your fragrance match is saved."
    });

  } catch (err) {
    return http.handleError(res, err, "quiz/submit");
  }
};
