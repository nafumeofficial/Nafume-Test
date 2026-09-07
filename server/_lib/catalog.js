/*
 * api/_lib/catalog.js  —  server-side product catalogue, pricing and quiz logic
 * ============================================================================
 * THE authoritative price list. The browser can send whatever it likes; the
 * amount a customer is actually charged is always recomputed from this file.
 *
 * Kept in sync BY HAND with:
 *   js/launch.js            LAUNCH_PRODUCTS / LAUNCH_CONFIG   (names, price)
 *   js/commerce/config.js   COMMERCE_CONFIG.offers            (offer rules)
 * If pricing or offers change there, change OFFER_RULES / PRODUCTS here too —
 * create-order.js rejects any order whose client total disagrees with the total
 * computed here, so drift fails safe (payment blocked) rather than silently
 * charging the wrong amount.
 *
 * The fragrance-quiz scoring also lives here so that the recommendation shown
 * to the visitor and the recommendation stored in the database are produced by
 * exactly one piece of code, on the server, and cannot be tampered with.
 */
"use strict";

/* ── products ────────────────────────────────────────────────────────────────
   `price` is the selling price in whole rupees. `name` is what gets stored on
   the order line, so it matches what the customer saw in the cart.           */

const PRODUCTS = {
  "seduction": {
    id: "seduction",
    name: "SEDUCTION 50ML",
    shortName: "Seduction",
    price: 799,
    url: "/pages/products/seduction",
    image: "/assets/images/products/seduction/01.jpg",
    family: ["floral", "oriental"],
    gender: "her",
    strength: "strong",
    moods: ["romantic", "magnetic", "sensual"],
    occasions: ["date-night", "evening", "festive"],
    blurb: "A radiant burst of red berries softened by musk and vanilla — romantic, magnetic, and impossible to forget."
  },
  "dark-oud": {
    id: "dark-oud",
    name: "DARK OUD 50ML",
    shortName: "Dark Oud",
    price: 799,
    url: "/pages/products/dark-oud",
    image: "/assets/images/products/dark-oud/01.jpg",
    family: ["woody", "oud"],
    gender: "him",
    strength: "strong",
    moods: ["mysterious", "powerful", "luxurious"],
    occasions: ["evening", "festive", "date-night"],
    blurb: "Aged agarwood, tobacco and dark leather. Extrait-level richness that speaks before you do."
  },
  "red-spirit": {
    id: "red-spirit",
    name: "RED SPIRIT 50ML",
    shortName: "Red Spirit",
    price: 799,
    url: "/pages/products/red-spirit",
    image: "/assets/images/products/red-spirit/01.jpg",
    family: ["spicy", "aromatic"],
    gender: "him",
    strength: "balanced",
    moods: ["bold", "confident", "energetic"],
    occasions: ["evening", "office", "date-night"],
    blurb: "Blood orange and absinthe over smoky amber — spicy without being harsh, and built for a room you want to own."
  },
  "aqua-manthan": {
    id: "aqua-manthan",
    name: "AQUA MANTHAN 50ML",
    shortName: "Aqua Manthan",
    price: 799,
    url: "/pages/products/aqua-manthan",
    image: "/assets/images/products/aqua-manthan/01.jpg",
    family: ["fresh", "aquatic"],
    gender: "unisex",
    strength: "subtle",
    moods: ["fresh", "clean", "energetic"],
    occasions: ["office", "everyday", "summer"],
    blurb: "Mandarin, cardamom and upcycled oakwood — crisp, clean and effortless in Indian heat."
  },
  "all-day-misfit": {
    id: "all-day-misfit",
    name: "ALL DAY 50ML",
    shortName: "All Day",
    price: 799,
    url: "/pages/products/all-day-misfit",
    image: "/assets/images/products/all-day-misfit/01.jpg",
    family: ["gourmand", "woody"],
    gender: "unisex",
    strength: "balanced",
    moods: ["warm", "carefree", "unique"],
    occasions: ["everyday", "office", "evening"],
    blurb: "Lavender and bergamot melting into tonka, patchouli and tolu balsam — warm, unusual, and quietly addictive."
  }
};

/* Deterministic tie-break order. When two products score identically the one
   earlier in this list wins, so the same answers always give the same result. */
const TIEBREAK_ORDER = ["seduction", "dark-oud", "aqua-manthan", "all-day-misfit", "red-spirit"];

function getProduct(id) {
  return Object.prototype.hasOwnProperty.call(PRODUCTS, String(id)) ? PRODUCTS[String(id)] : null;
}
function allProducts() { return TIEBREAK_ORDER.map(function (id) { return PRODUCTS[id]; }); }

/* ── offers ──────────────────────────────────────────────────────────────────
   Mirrors js/commerce/config.js COMMERCE_CONFIG.offers exactly.              */

const OFFER_RULES = {
  freeShippingThreshold: 999,
  shippingCost:           99,
  prepaidDiscount: { enabled: true, type: "percentage", value: 5 },
  buyAny3:         { enabled: true, requiredQuantity: 3, bundlePrice: 2199 },
  giftingAddOn:    { enabled: true, price: 99 }
};

const MAX_QTY_PER_ITEM = 20;
const MAX_TOTAL_ITEMS  = 50;

/* First-order discount offered by the email-capture popup. Single source of
   truth for the percentage, the code and the wording shown to the customer. */
const POPUP_OFFER = {
  code:       "NAFUME10",
  percentOff: 10,
  label:      "10% off your first order",
  terms:      "Valid on your first NAFUME order. Cannot be combined with other coupon codes."
};

/* Thank-you discount given after a post-delivery review is submitted.
   These codes are display-only until they are created in the payment/discount
   system — see docs/customer-data-system.md before promoting either offer. */
const REVIEW_OFFER = {
  code:       "NAFUMEREVIEW",
  percentOff: 10,
  label:      "10% off your next order",
  terms:      "Thank you for reviewing. Valid on your next NAFUME order."
};

/* Days after delivery before a review request becomes due. */
const REVIEW_REQUEST_DELAY_DAYS =
  Math.max(1, parseInt(process.env.REVIEW_REQUEST_DELAY_DAYS || "5", 10) || 5);

/* ── pricing ─────────────────────────────────────────────────────────────────
   All inputs are integers (₹799 unit price, fixed offer values), so plain
   integer arithmetic is exact — no floating-point rounding risk.             */

/* priceCart(items) -> { error, message } | { lines, subtotal, totalQty }
   Rejects unknown SKUs outright, so a fabricated product id can never be
   priced. Client-sent prices are ignored entirely. */
function priceCart(items) {
  if (!Array.isArray(items) || items.length === 0) {
    return { error: "empty_cart", message: "Your cart is empty." };
  }
  if (items.length > 20) {
    return { error: "too_many_items", message: "Order quantity is too large. Please contact support for bulk orders." };
  }

  const merged = new Map();      // collapse duplicate ids so qty caps can't be bypassed
  for (let i = 0; i < items.length; i++) {
    const it  = items[i] || {};
    const id  = String(it.id || "");
    const qty = parseInt(it.qty !== undefined ? it.qty : it.quantity, 10);

    if (!getProduct(id)) {
      return { error: "invalid_product",
               message: "One or more items in your cart are not recognised. Please refresh and try again." };
    }
    if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QTY_PER_ITEM) {
      return { error: "invalid_quantity", message: "Invalid item quantity." };
    }
    merged.set(id, (merged.get(id) || 0) + qty);
  }

  const lines = [];
  let subtotal = 0, totalQty = 0;

  merged.forEach(function (qty, id) {
    if (qty > MAX_QTY_PER_ITEM) qty = MAX_QTY_PER_ITEM;
    const p = PRODUCTS[id];
    const lineTotal = p.price * qty;
    lines.push({ productId: id, productName: p.name, unitPrice: p.price, quantity: qty, lineTotal: lineTotal });
    subtotal += lineTotal;
    totalQty += qty;
  });

  if (totalQty > MAX_TOTAL_ITEMS) {
    return { error: "too_many_items", message: "Order quantity is too large. Please contact support for bulk orders." };
  }
  return { lines: lines, subtotal: subtotal, totalQty: totalQty };
}

/* Razorpay refuses an order below ₹1, so a discount can never take the payable
   amount to zero. */
const MIN_PAYABLE = 1;

/* calculateTotals(subtotal, totalQty, giftingRequested, { prepaid, discount })
   Mirrors js/commerce/offer-service.js getCartOfferSummary() using only
   server-trusted values. `prepaid` defaults to true because every Razorpay
   payment is by definition an online/prepaid payment.

   `discount` is an OPTIONAL promo code already validated by
   api/_lib/discounts.js — { code, type: "percentage"|"flat", value }. It is
   never taken from the browser; this function only does the arithmetic.

   Order of operations (fixed, and mirrored in the UI):
       subtotal
     − bundle discount        "buy any 3" price cap
     − prepaid discount       5%, on the post-bundle amount
     − promo discount         the code, on the post-prepaid amount
     + shipping               free above ₹999 of RAW subtotal
     + gift packaging
   Applying the promo last means the code discounts what the customer actually
   owes for the goods, and can never be inflated by stacking it on a pre-bundle
   figure. */
function calculateTotals(subtotal, totalQty, giftingRequested, opts) {
  opts = opts || {};
  const prepaid = opts.prepaid !== false;

  // Buy Any 3 × 50ml — price cap per group of 3 units. All five NAFUME products
  // are bundle-eligible and identically priced, so every group of 3 costs the same.
  let bundleDiscount = 0;
  const bundleCfg = OFFER_RULES.buyAny3;
  if (bundleCfg.enabled) {
    const groups = Math.floor(totalQty / bundleCfg.requiredQuantity);
    if (groups > 0) {
      const unitPrice  = PRODUCTS["seduction"].price;    // flat NAFUME selling price
      const groupTotal = unitPrice * bundleCfg.requiredQuantity;
      bundleDiscount = groups * Math.max(0, groupTotal - bundleCfg.bundlePrice);
    }
  }

  const discountedSubtotal = subtotal - bundleDiscount;

  let prepaidDiscount = 0;
  const prepaidCfg = OFFER_RULES.prepaidDiscount;
  if (prepaid && prepaidCfg.enabled && discountedSubtotal > 0) {
    prepaidDiscount = prepaidCfg.type === "flat"
      ? Math.min(discountedSubtotal, prepaidCfg.value)
      : Math.round(discountedSubtotal * (prepaidCfg.value / 100));
  }

  // Gifting add-on — boolean intent only; the price is always server-defined.
  let giftingAddOn = 0;
  if (OFFER_RULES.giftingAddOn.enabled && giftingRequested === true) {
    giftingAddOn = OFFER_RULES.giftingAddOn.price;
  }

  // Shipping threshold is measured on the RAW subtotal, matching offer-service.js.
  const shipping = subtotal === 0
    ? 0
    : (subtotal >= OFFER_RULES.freeShippingThreshold ? 0 : OFFER_RULES.shippingCost);

  // ── Promo code — applied to the goods value after bundle + prepaid ──
  const afterPrepaid = Math.max(0, discountedSubtotal - prepaidDiscount);
  let promoDiscount = 0;
  let promoCode = null;

  const promo = opts.discount;
  if (promo && promo.code && afterPrepaid > 0) {
    promoCode = promo.code;
    promoDiscount = promo.type === "flat"
      ? Math.min(afterPrepaid, Math.max(0, Math.round(promo.value)))
      : Math.round(afterPrepaid * (Math.max(0, Math.min(100, promo.value)) / 100));

    // Never discount below what the payment gateway will accept.
    const beforePromo = afterPrepaid + shipping + giftingAddOn;
    if (beforePromo - promoDiscount < MIN_PAYABLE) {
      promoDiscount = Math.max(0, beforePromo - MIN_PAYABLE);
    }
  }

  const total = Math.max(0, afterPrepaid - promoDiscount + shipping + giftingAddOn);

  return {
    subtotal:        subtotal,
    bundleDiscount:  bundleDiscount,
    prepaidDiscount: prepaidDiscount,
    promoCode:       promoCode,
    promoDiscount:   promoDiscount,
    giftingAddOn:    giftingAddOn,
    shipping:        shipping,
    total:           total
  };
}

/* ── fragrance finder ────────────────────────────────────────────────────────
   Five short questions. Each option carries weights per product; the highest
   total wins, ties broken by TIEBREAK_ORDER. Deterministic and inspectable —
   the same answers always produce the same recommendation, on server and in
   the customer's confirmation email alike.

   `tags` on each option are the segmentation tags persisted with the response
   (e.g. oud, evening, strong, gifting) — these are what future targeted email /
   WhatsApp campaigns are built on.                                            */

const QUIZ = [
  {
    id: "mood",
    question: "What do you want your fragrance to say about you?",
    options: [
      { value: "romantic",  label: "Romantic & magnetic",  tags: ["romantic"],  weights: { "seduction": 3, "dark-oud": 1, "all-day-misfit": 1 } },
      { value: "powerful",  label: "Mysterious & powerful", tags: ["powerful"],  weights: { "dark-oud": 3, "red-spirit": 2 } },
      { value: "fresh",     label: "Fresh & effortless",    tags: ["fresh"],     weights: { "aqua-manthan": 3, "all-day-misfit": 1 } },
      { value: "bold",      label: "Bold & energetic",      tags: ["bold"],      weights: { "red-spirit": 3, "dark-oud": 1 } },
      { value: "warm",      label: "Warm & comforting",     tags: ["warm"],      weights: { "all-day-misfit": 3, "seduction": 1 } }
    ]
  },
  {
    id: "occasion",
    question: "Where will you wear it most?",
    options: [
      { value: "date-night", label: "Date nights & evenings",   tags: ["date-night", "evening"], weights: { "seduction": 3, "dark-oud": 2, "red-spirit": 1 } },
      { value: "office",     label: "Office & everyday",        tags: ["office", "daily"],       weights: { "aqua-manthan": 3, "all-day-misfit": 2 } },
      { value: "festive",    label: "Weddings & celebrations",  tags: ["festive"],               weights: { "dark-oud": 3, "seduction": 2 } },
      { value: "outdoors",   label: "Gym, travel & hot days",   tags: ["summer", "travel"],      weights: { "aqua-manthan": 3, "red-spirit": 1 } },
      { value: "allrounder", label: "A bit of everything",      tags: ["all-rounder"],           weights: { "all-day-misfit": 3, "aqua-manthan": 1, "red-spirit": 1 } }
    ]
  },
  {
    id: "strength",
    question: "How much presence do you like?",
    options: [
      { value: "subtle",   label: "Subtle — close to the skin",     tags: ["subtle"],   weights: { "aqua-manthan": 3, "all-day-misfit": 1 } },
      { value: "balanced", label: "Balanced — noticed, not loud",   tags: ["balanced"], weights: { "all-day-misfit": 2, "red-spirit": 2, "seduction": 1 } },
      { value: "strong",   label: "Strong — I want a trail",        tags: ["strong"],   weights: { "dark-oud": 3, "seduction": 2 } }
    ]
  },
  {
    id: "family",
    question: "Which of these sounds most like you?",
    options: [
      { value: "floral",   label: "Florals & soft musk",       tags: ["floral"],   weights: { "seduction": 3 } },
      { value: "oud",      label: "Oud, woods & leather",      tags: ["oud", "woody"], weights: { "dark-oud": 3, "all-day-misfit": 1 } },
      { value: "fresh",    label: "Citrus & sea air",          tags: ["fresh", "aquatic"], weights: { "aqua-manthan": 3 } },
      { value: "spicy",    label: "Spice & warm amber",        tags: ["spicy"],    weights: { "red-spirit": 3, "dark-oud": 1 } },
      { value: "gourmand", label: "Vanilla, tonka & sweetness", tags: ["gourmand"], weights: { "all-day-misfit": 3, "seduction": 1 } },
      { value: "unsure",   label: "Honestly, no idea",          tags: ["exploring"], weights: { "aqua-manthan": 1, "all-day-misfit": 1, "seduction": 1 } }
    ]
  },
  {
    id: "purpose",
    question: "Last one — who is this for?",
    options: [
      { value: "self",   label: "Myself",            tags: ["self-purchase"], weights: {} },
      { value: "gift",   label: "A gift for someone", tags: ["gifting"],      weights: { "seduction": 1, "dark-oud": 1 } },
      { value: "either", label: "Not sure yet",       tags: [],               weights: {} }
    ]
  }
];

function quizQuestions() {
  // Public shape — weights stay server-side so the "right" answer isn't guessable.
  return QUIZ.map(function (q) {
    return {
      id: q.id,
      question: q.question,
      options: q.options.map(function (o) { return { value: o.value, label: o.label }; })
    };
  });
}

/* recommend(answers) -> { valid, message } | { valid:true, product, alternate, tags, answers, scores }
   `answers` is { mood, occasion, strength, family, purpose }. Unknown or
   missing values are ignored rather than rejected, so an abandoned-then-resumed
   quiz still produces a sensible result — but at least three of the five
   questions must be answered for a recommendation to mean anything. */
function recommend(answers) {
  answers = answers || {};
  const scores = {};
  const tags   = [];
  const clean  = {};
  let answered = 0;

  TIEBREAK_ORDER.forEach(function (id) { scores[id] = 0; });

  QUIZ.forEach(function (q) {
    const given = String(answers[q.id] || "").trim().toLowerCase();
    if (!given) return;
    const opt = q.options.find(function (o) { return o.value === given; });
    if (!opt) return;

    answered++;
    clean[q.id] = opt.value;
    opt.tags.forEach(function (t) { if (tags.indexOf(t) === -1) tags.push(t); });
    Object.keys(opt.weights).forEach(function (pid) { scores[pid] += opt.weights[pid]; });
  });

  if (answered < 3) {
    return { valid: false, message: "Please answer at least three questions to get a recommendation." };
  }

  const ranked = TIEBREAK_ORDER.slice().sort(function (a, b) {
    if (scores[b] !== scores[a]) return scores[b] - scores[a];
    return TIEBREAK_ORDER.indexOf(a) - TIEBREAK_ORDER.indexOf(b);
  });

  const winner = PRODUCTS[ranked[0]];
  const runner = PRODUCTS[ranked[1]];

  return {
    valid: true,
    answered: answered,
    answers: clean,
    tags: tags,
    scores: scores,
    product: {
      id: winner.id, name: winner.name, shortName: winner.shortName, price: winner.price,
      url: winner.url, image: winner.image, blurb: winner.blurb, family: winner.family
    },
    alternate: {
      id: runner.id, name: runner.name, shortName: runner.shortName, price: runner.price,
      url: runner.url, image: runner.image, blurb: runner.blurb
    }
  };
}

module.exports = {
  PRODUCTS, OFFER_RULES, POPUP_OFFER, REVIEW_OFFER, REVIEW_REQUEST_DELAY_DAYS, QUIZ,
  MIN_PAYABLE,
  getProduct, allProducts,
  priceCart, calculateTotals,
  quizQuestions, recommend,
  MAX_QTY_PER_ITEM, MAX_TOTAL_ITEMS
};
