/* ============================================================================
   NAFUME — Fragrance Finder
   ----------------------------------------------------------------------------
   A five-question quiz that recommends a real NAFUME fragrance, then offers to
   email the result in exchange for an address.

   Where the logic lives
     The questions AND the scoring are served by the backend
     (/api/quiz/questions, /api/quiz/recommend). There is deliberately no copy
     of the scoring rules in this file: the product a visitor is shown and the
     product stored against their answers are produced by the same code, so they
     can never disagree, and a tampered browser cannot store a result it did not
     earn.

   Flow
     one question per screen (no wall of form fields)
     → recommendation shown immediately, no email required to see it
     → optional "email me my result", which is what creates the lead

   Mount it by putting <div data-fragrance-quiz></div> anywhere on a page and
   loading this file; it takes care of the rest.
   ========================================================================== */
(function (global) {
  "use strict";

  var PROGRESS_KEY = "nafume_quiz_progress";

  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c];
    });
  }
  function money(n) { return "₹" + Number(n || 0).toLocaleString("en-IN"); }

  function createQuiz(root) {
    var questions = [];
    var answers   = {};
    var index     = 0;
    var result    = null;

    /* An abandoned quiz is resumable rather than lost — the visitor picks up
       where they left off instead of starting over. */
    function saveProgress() {
      try {
        global.sessionStorage.setItem(PROGRESS_KEY, JSON.stringify({ answers: answers, index: index }));
      } catch (e) {}
    }
    function loadProgress() {
      try {
        var raw = global.sessionStorage.getItem(PROGRESS_KEY);
        if (!raw) return;
        var saved = JSON.parse(raw);
        if (saved && saved.answers) {
          answers = saved.answers;
          index = Math.min(saved.index || 0, questions.length - 1);
        }
      } catch (e) {}
    }
    function clearProgress() {
      try { global.sessionStorage.removeItem(PROGRESS_KEY); } catch (e) {}
    }

    /* ── states ─────────────────────────────────────────────────────────── */

    function renderLoading(message) {
      root.innerHTML =
        '<div class="nf-quiz-state">' +
          '<span class="nf-quiz-spinner" aria-hidden="true"></span>' +
          '<p>' + escapeHtml(message || "Loading your fragrance finder…") + '</p>' +
        '</div>';
    }

    function renderError(message, retry) {
      root.innerHTML =
        '<div class="nf-quiz-state nf-quiz-state--error" role="alert">' +
          '<p>' + escapeHtml(message) + '</p>' +
          (retry ? '<button type="button" class="nf-quiz-btn" id="nf-quiz-retry">Try again</button>' : '') +
        '</div>';
      var btn = document.getElementById("nf-quiz-retry");
      if (btn) btn.addEventListener("click", start);
    }

    function renderQuestion() {
      var q = questions[index];
      if (!q) return;
      var pct = Math.round((index / questions.length) * 100);

      root.innerHTML =
        '<div class="nf-quiz-card">' +
          '<div class="nf-quiz-progress" role="progressbar" aria-valuemin="0" aria-valuemax="' + questions.length +
            '" aria-valuenow="' + (index + 1) + '" aria-label="Question ' + (index + 1) + ' of ' + questions.length + '">' +
            '<div class="nf-quiz-progress-fill" style="width:' + pct + '%"></div>' +
          '</div>' +
          '<p class="nf-quiz-step">Question ' + (index + 1) + ' of ' + questions.length + '</p>' +
          '<h3 class="nf-quiz-question">' + escapeHtml(q.question) + '</h3>' +
          '<div class="nf-quiz-options" role="radiogroup" aria-label="' + escapeHtml(q.question) + '">' +
            q.options.map(function (o, i) {
              var selected = answers[q.id] === o.value;
              return '<button type="button" class="nf-quiz-option' + (selected ? " is-selected" : "") + '" ' +
                'role="radio" aria-checked="' + (selected ? "true" : "false") + '" ' +
                'data-value="' + escapeHtml(o.value) + '" data-index="' + i + '">' +
                escapeHtml(o.label) + '</button>';
            }).join("") +
          '</div>' +
          '<div class="nf-quiz-nav">' +
            (index > 0 ? '<button type="button" class="nf-quiz-back" id="nf-quiz-back">← Back</button>' : '<span></span>') +
            '<button type="button" class="nf-quiz-skip" id="nf-quiz-skip">Skip</button>' +
          '</div>' +
        '</div>';

      root.querySelectorAll(".nf-quiz-option").forEach(function (btn) {
        btn.addEventListener("click", function () { choose(q.id, btn.dataset.value); });
      });
      var back = document.getElementById("nf-quiz-back");
      if (back) back.addEventListener("click", function () { index--; renderQuestion(); saveProgress(); });
      var skip = document.getElementById("nf-quiz-skip");
      if (skip) skip.addEventListener("click", function () { advance(); });

      var firstOption = root.querySelector(".nf-quiz-option");
      if (firstOption && index > 0) { try { firstOption.focus(); } catch (e) {} }
    }

    function choose(questionId, value) {
      answers[questionId] = value;
      saveProgress();
      advance();
    }

    function advance() {
      if (index < questions.length - 1) { index++; renderQuestion(); saveProgress(); return; }
      submitForRecommendation();
    }

    function submitForRecommendation() {
      renderLoading("Finding your match…");
      global.NafumeAPI.quizRecommend(answers).then(function (res) {
        if (!res.ok) {
          if (res.data && res.data.error === "incomplete_quiz") {
            // Not enough answered — send them back to the first blank question.
            var missing = questions.findIndex(function (q) { return !answers[q.id]; });
            index = missing >= 0 ? missing : 0;
            renderQuestion();
            var card = root.querySelector(".nf-quiz-card");
            if (card) {
              var note = document.createElement("p");
              note.className = "nf-quiz-inline-note";
              note.textContent = res.message;
              card.insertBefore(note, card.querySelector(".nf-quiz-options"));
            }
            return;
          }
          renderError(res.message || "We couldn't work out your match. Please try again.", true);
          return;
        }
        result = res.data;
        clearProgress();
        renderResult();
      });
    }

    function renderResult() {
      var p = result.product;
      var alt = result.alternate;

      root.innerHTML =
        '<div class="nf-quiz-card nf-quiz-result">' +
          '<p class="nf-quiz-step">Your match</p>' +
          '<div class="nf-quiz-product">' +
            '<img class="nf-quiz-product-img" src="' + escapeHtml(p.image) + '" alt="' + escapeHtml(p.shortName) + '" loading="lazy"/>' +
            '<div class="nf-quiz-product-info">' +
              '<h3 class="nf-quiz-product-name">' + escapeHtml(p.shortName) + '</h3>' +
              '<p class="nf-quiz-product-price">' + money(p.price) + '</p>' +
              '<p class="nf-quiz-product-blurb">' + escapeHtml(p.blurb) + '</p>' +
              '<div class="nf-quiz-tags">' +
                (result.tags || []).map(function (t) {
                  return '<span class="nf-quiz-tag">' + escapeHtml(t.replace(/-/g, " ")) + '</span>';
                }).join("") +
              '</div>' +
              '<div class="nf-quiz-actions">' +
                '<button type="button" class="nf-quiz-btn" id="nf-quiz-add">Add to cart</button>' +
                '<a class="nf-quiz-link" href="' + escapeHtml(p.url) + '">See the full story →</a>' +
              '</div>' +
            '</div>' +
          '</div>' +

          '<p class="nf-quiz-alt">You might also like <a href="' + escapeHtml(alt.url) + '">' +
            escapeHtml(alt.shortName) + '</a>.</p>' +

          '<div class="nf-quiz-save" id="nf-quiz-save">' +
            '<h4 class="nf-quiz-save-title">Email my fragrance recommendation</h4>' +
            '<p class="nf-quiz-save-sub">We\'ll send your match and keep you posted on scents like it.</p>' +
            '<form class="nf-quiz-save-form" id="nf-quiz-save-form" novalidate>' +
              '<label class="nf-quiz-save-label" for="nf-quiz-email">Email address</label>' +
              '<div class="nf-quiz-save-row">' +
                '<input class="nf-quiz-input" id="nf-quiz-email" type="email" inputmode="email" ' +
                  'autocomplete="email" placeholder="your@email.com" required/>' +
                '<button class="nf-quiz-btn" id="nf-quiz-save-btn" type="submit">Save my result</button>' +
              '</div>' +
              '<p class="nf-quiz-error" id="nf-quiz-save-error" role="alert"></p>' +
            '</form>' +
          '</div>' +

          '<button type="button" class="nf-quiz-restart" id="nf-quiz-restart">Retake the quiz</button>' +
        '</div>';

      var addBtn = document.getElementById("nf-quiz-add");
      if (addBtn) {
        addBtn.addEventListener("click", function () {
          if (typeof global.launchAddToCart === "function") {
            global.launchAddToCart(p.id, 1);
            addBtn.textContent = "Added ✓";
            setTimeout(function () { addBtn.textContent = "Add to cart"; }, 2000);
          } else {
            global.location.href = p.url;
          }
        });
      }

      var form = document.getElementById("nf-quiz-save-form");
      if (form) form.addEventListener("submit", saveResult);

      var restart = document.getElementById("nf-quiz-restart");
      if (restart) restart.addEventListener("click", function () {
        answers = {}; index = 0; result = null; clearProgress(); renderQuestion();
      });
    }

    function saveResult(e) {
      e.preventDefault();
      var input = document.getElementById("nf-quiz-email");
      var btn   = document.getElementById("nf-quiz-save-btn");
      var err   = document.getElementById("nf-quiz-save-error");
      var email = (input.value || "").trim();

      err.textContent = "";
      input.classList.remove("has-error");

      if (!/^[^\s@]+@[^\s@]+\.[A-Za-z]{2,}$/.test(email)) {
        input.classList.add("has-error");
        err.textContent = "Please enter a valid email address.";
        input.focus();
        return;
      }

      btn.disabled = true;
      btn.textContent = "Saving…";

      global.NafumeAPI.quizSubmit(email, answers, true).then(function (res) {
        btn.disabled = false;
        btn.textContent = "Save my result";

        if (!res.ok) {
          input.classList.add("has-error");
          err.textContent = res.message || "We couldn't save your result. Please try again.";
          return;
        }

        var box = document.getElementById("nf-quiz-save");
        box.classList.add("is-done");
        box.innerHTML =
          '<h4 class="nf-quiz-save-title">Saved ✓</h4>' +
          '<p class="nf-quiz-save-sub">' +
            (res.data.emailed
              ? "Your recommendation is on its way to " + escapeHtml(email) + "."
              : "Your result is saved. We'll be in touch at " + escapeHtml(email) + ".") +
          '</p>';

        try {
          if (global.OperationsService) {
            global.OperationsService.recordAnalyticsEvent("quiz_completed", {
              product: result.product.id, tags: (result.tags || []).join(",")
            });
          }
        } catch (e2) {}
      });
    }

    /* ── boot ───────────────────────────────────────────────────────────── */

    function start() {
      renderLoading();
      if (!global.NafumeAPI) {
        renderError("The fragrance finder could not load on this page.", false);
        return;
      }
      global.NafumeAPI.quizQuestions().then(function (res) {
        if (!res.ok || !res.data.questions || !res.data.questions.length) {
          renderError(res.message || "The fragrance finder is unavailable right now. Please try again shortly.", true);
          return;
        }
        questions = res.data.questions;
        loadProgress();
        renderQuestion();
      });
    }

    return { start: start };
  }

  function mountAll() {
    document.querySelectorAll("[data-fragrance-quiz]").forEach(function (root) {
      if (root.dataset.quizMounted) return;
      root.dataset.quizMounted = "1";
      createQuiz(root).start();
    });
  }

  global.NafumeQuiz = { mount: mountAll };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mountAll);
  } else {
    mountAll();
  }
})(window);
