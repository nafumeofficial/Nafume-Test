/* ================================================================
   NAFUME Artisan Luxe — launch.js
   Flow: Product Page / pages/collections/shop.html → Cart → pages/order/shipping.html → WhatsApp
   ================================================================ */

// ── Path helper: makes root-relative links work on file:// and http:// ──
function nfPath(path) {
  var loc = (window.location.pathname || '').replace(/\\/g, '/');
  var depth = loc.indexOf('/pages/') !== -1 ? '../../' :
              loc.indexOf('/admin/')  !== -1 ? '../'    : '';
  if (path === '/' || path === '/index') return depth + 'index.html';
  if (path.startsWith('/#') || path.startsWith('/index#')) {
    return depth + 'index.html' + path.slice(path.indexOf('#'));
  }
  return depth + path.replace(/^\/+/, '');
}

// ── Auto-fix root-relative links/src when opened via file:// ────────────
(function () {
  if (window.location.protocol !== 'file:') return;
  function fixEl(el) {
    if (!el || !el.getAttribute) return;
    var tag = el.tagName;
    if (tag === 'A' || tag === 'AREA') {
      var h = el.getAttribute('href');
      if (h && h.charAt(0) === '/' && h.charAt(1) !== '/') el.setAttribute('href', nfPath(h));
    } else if (tag === 'IMG' || tag === 'VIDEO' || tag === 'SOURCE') {
      var s = el.getAttribute('src');
      if (s && s.charAt(0) === '/' && s.charAt(1) !== '/') {
        el.setAttribute('src', nfPath(s));
        if (tag === 'IMG') el.style.visibility = '';
      }
    }
  }
  function fixAll(root) {
    (root || document).querySelectorAll('a[href],area[href],img[src],video[src],source[src]').forEach(fixEl);
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { fixAll(); });
  } else {
    fixAll();
  }
  var obs = new MutationObserver(function (ms) {
    ms.forEach(function (m) {
      m.addedNodes.forEach(function (n) {
        if (n.nodeType !== 1) return;
        fixEl(n);
        if (n.querySelectorAll) n.querySelectorAll('a[href],area[href],img[src],video[src],source[src]').forEach(fixEl);
      });
    });
  });
  obs.observe(document.documentElement, { childList: true, subtree: true });
}());

// ─── Central config ──────────────────────────────────────────────
const LAUNCH_CONFIG = {
  brandName:             "NAFUME Artisan Luxe",
  whatsappNumber:        "918595862227",
  instagramUrl:          "https://www.instagram.com/nafume.official?igsh=djk0OHY0dnlmeXJ5",
  currency:              "₹",
  mrp:                   1299,
  sellingPrice:          799,
  discountLabel:         "38.5% OFF",
  saleLabel:             "Summer Sale",
  freeShippingThreshold: 999,
  shippingCost:          99,
  shippingNote:          "Free shipping above ₹999"
};
window.LAUNCH_CONFIG = LAUNCH_CONFIG;

// ─── Product catalogue ────────────────────────────────────────────
const LAUNCH_PRODUCTS = [
  {
    id:          "seduction",
    slug: "/pages/products/seduction.html",
    name:        "Seduction",
    displayName: "SEDUCTION 50ML",
    edp:         "Long-lasting Perfume",
    family:      "Floral | Oriental",
    notes:       ["Bergamot", "Red Fruits", "Musk"],
    topNotes:    "Bergamot, Pink Pepper",
    heartNotes:  "Red Fruits, Ambrette (Musk Mallow), Magnolia, Peach Blossom, Jasmine",
    baseNotes:   "Musk, Orris Root, White Woods, Vanilla",
    feelings:    ["Sensual", "Romantic", "Magnetic"],
    occasions:   ["Date Night", "Evening", "Special Occasions"],
    description: "Crafted for those who embrace confidence and charm, SEDUCTION is a signature fragrance designed to leave an unforgettable impression from day to night.",
    behindPerfume: "Inspired by the irresistible harmony of vibrant fruits and sensual musk, SEDUCTION is a fragrance that celebrates elegance with a playful edge. It opens with a radiant burst of juicy red berries, creating a bright and captivating first impression. As the fragrance unfolds, delicate floral nuances add softness and refinement, while the base reveals a luxurious blend of velvety musk, warm amber, and creamy woods that lingers with effortless sophistication.",
    whyLove:     "Rich yet wearable, the rose-amber harmony feels both classic and modern. A true signature scent that people will ask about.",
    usage:       "Apply to pulse points — wrists, neck, and behind ears. Best applied right after showering on warm skin for maximum longevity.",
    image:       "/assets/images/products/seduction/01.jpg",
    thumbnails: [
      "/assets/images/products/thumbnails/Seduction/image-1.jpg",
      "/assets/images/products/thumbnails/Seduction/image-2.jpg",
      "/assets/images/products/thumbnails/Seduction/image-3.jpg"
    ],
    gallery: [
      "/assets/images/products/seduction/01.jpg",
      "/assets/images/products/seduction/02.jpg",
      "/assets/images/products/seduction/03.jpg",
      "/assets/images/products/seduction/04.jpg",
      "/assets/images/products/seduction/05.jpg"
    ],
    galleryAlt: [
      "NAFUME Seduction 50ML perfume bottle",
      "NAFUME Seduction romantic fragrance for evening wear",
      "NAFUME Seduction perfume bottle and box",
      "NAFUME Seduction premium floral oriental fragrance",
      "NAFUME Seduction date night perfume set"
    ],
    // ── Shopify checkout mapping (Upgrade 2) ──
    // Replace null with the real Shopify Product ID after the product is created in Shopify.
    shopifyProductId: null,
    // Replace null with the real Shopify Variant ID / merchandise ID for Storefront API checkout.
    shopifyVariantId: null,
    // Fallback rating shown only if NO dynamic reviews exist (Upgrade 4).
    fallbackRating: 4.7,
    fallbackReviewCount: 42,
    // ── Collection & merchandising fields (Upgrade 6) ──
    collections:         ["new-launches", "best-sellers", "her", "date-night", "gifting", "discovery-set"],
    primaryCollection:   "best-sellers",
    gender:              "her",
    isBestSeller:        true,
    isNewLaunch:         true,
    isGiftable:          true,
    isBundleEligible:    true,
    isDiscoveryEligible: true,
    badges:              ["Bestseller", "Date Night Pick"]
  },
  {
    id:          "dark-oud",
    slug: "/pages/products/dark-oud.html",
    name:        "Dark Oud",
    displayName: "DARK OUD 50ML",
    edp:         "Long-lasting Perfume",
    family:      "Woody | Oud",
    notes:       ["Sandalwood", "Tobacco", "Agarwood (Oud)"],
    topNotes:    "Sandalwood, Amber",
    heartNotes:  "Tobacco, Jasmine",
    baseNotes:   "Agarwood (Oud)",
    feelings:    ["Mysterious", "Commanding", "Luxurious"],
    occasions:   ["Formal Events", "Winter Evenings", "Celebrations"],
    description: "An ode to the ancient art of oud. Dark Oud blends the richness of aged agarwood with dark leather, creating a fragrance that is both modern and timeless. Heavy, bold, and deeply unforgettable.",
    behindPerfume: "Inspired by the ancient incense routes of Arabia and India, Dark Oud captures the soul of royal oud rituals in a modern bottle.",
    whyLove:     "Extrait-level richness at an accessible price. Dark Oud speaks before you do — intense, long-lasting, and unmistakably premium.",
    usage:       "2–3 sprays is all you need. Apply to chest and wrists. The concentration is powerful — less is more.",
    image:       "/assets/images/products/dark-oud/01.jpg",
    thumbnails: [
      "/assets/images/products/thumbnails/Dark%20Oud/image-1.jpg",
      "/assets/images/products/thumbnails/Dark%20Oud/image-2.jpg",
      "/assets/images/products/thumbnails/Dark%20Oud/image-3.jpg",
      "/assets/images/products/thumbnails/Dark%20Oud/image-4.jpg"
    ],
    gallery: [
      "/assets/images/products/dark-oud/01.jpg",
      "/assets/images/products/dark-oud/02.jpg",
      "/assets/images/products/dark-oud/03.jpg",
      "/assets/images/products/dark-oud/04.jpg",
      "/assets/images/products/dark-oud/05.jpg"
    ],
    galleryAlt: [
      "NAFUME Dark Oud 50ML perfume bottle",
      "NAFUME Dark Oud oud-inspired perfume",
      "NAFUME Dark Oud premium perfume bottle and box",
      "NAFUME Dark Oud intense woody fragrance",
      "NAFUME Dark Oud premium perfume gift set"
    ],
    shopifyProductId: null, // Replace null with real Shopify Product ID
    shopifyVariantId: null, // Replace null with real Shopify Variant / merchandise ID
    fallbackRating: 4.8, fallbackReviewCount: 57,
    // ── Collection & merchandising fields (Upgrade 6) ──
    collections:         ["new-launches", "best-sellers", "him", "oud-intense", "date-night", "gifting", "discovery-set"],
    primaryCollection:   "oud-intense",
    gender:              "him",
    isBestSeller:        true,
    isNewLaunch:         true,
    isGiftable:          true,
    isBundleEligible:    true,
    isDiscoveryEligible: true,
    badges:              ["Popular Choice", "Oud Intense"]
  },
  {
    id:          "red-spirit",
    slug: "/pages/products/red-spirit.html",
    name:        "Red Spirit",
    displayName: "RED SPIRIT 50ML",
    edp:         "Long-lasting Perfume",
    family:      "Spicy | Aromatic",
    notes:       ["Blood Orange", "Absinthe", "Musk"],
    topNotes:    "Blood Orange, Bergamot, Pink Pepper",
    heartNotes:  "Absinthe, Lavender, Orris",
    baseNotes:   "Musk, Cedar, Opoponax",
    feelings:    ["Confident", "Bold", "Fiery"],
    occasions:   ["Power Meetings", "Night Out", "Adventure"],
    description: "Crafted for those who move with purpose, RED SPIRIT is a signature scent designed to ignite confidence and leave a striking impression wherever you go.",
    behindPerfume: "Inspired by the energy of speed, fire, and fearless ambition, RED SPIRIT is a fragrance that embodies boldness and modern confidence. It opens with a dynamic burst of fresh citrus and vibrant red fruits, creating an instant rush of energy and confidence. The heart reveals a warm blend of aromatic spices, rich woods, and coffee, adding depth and character to its powerful personality. As it settles, smoky undertones, amber, and smooth musk create a strong, lasting trail that feels both intense and refined.",
    whyLove:     "Spicy without being harsh, warm without being sweet. Red Spirit wears close to the skin yet fills every room you walk into.",
    usage:       "Spray 2–3 times on the chest and wrists. The warmth of your pulse points amplifies the spice notes beautifully throughout the day.",
    image:       "/assets/images/products/red-spirit/01.jpg",
    thumbnails: [
      "/assets/images/products/thumbnails/Red%20Spirit/image-1.jpg",
      "/assets/images/products/thumbnails/Red%20Spirit/image-2.jpg",
      "/assets/images/products/thumbnails/Red%20Spirit/image-3.jpg"
    ],
    gallery: [
      "/assets/images/products/red-spirit/01.jpg",
      "/assets/images/products/red-spirit/02.jpg",
      "/assets/images/products/red-spirit/03.jpg",
      "/assets/images/products/red-spirit/04.jpg",
      "/assets/images/products/red-spirit/05.jpg"
    ],
    galleryAlt: [
      "NAFUME Red Spirit 50ML perfume bottle",
      "NAFUME Red Spirit bold perfume for evening plans",
      "NAFUME Red Spirit premium fragrance bottle",
      "NAFUME Red Spirit spicy aromatic perfume",
      "NAFUME Red Spirit perfume bottle and packaging"
    ],
    shopifyProductId: null, // Replace null with real Shopify Product ID
    shopifyVariantId: null, // Replace null with real Shopify Variant / merchandise ID
    fallbackRating: 4.6, fallbackReviewCount: 31,
    // ── Collection & merchandising fields (Upgrade 6) ──
    collections:         ["new-launches", "him", "unisex", "date-night", "office-wear", "gifting", "discovery-set"],
    primaryCollection:   "him",
    gender:              "him",
    isBestSeller:        false,
    isNewLaunch:         true,
    isGiftable:          true,
    isBundleEligible:    true,
    isDiscoveryEligible: true,
    badges:              ["Bold Pick", "Night Out"]
  },
  {
    id:          "aqua-manthan",
    slug: "/pages/products/aqua-manthan.html",
    name:        "Aqua Manthan",
    displayName: "AQUA MANTHAN 50ML",
    edp:         "Long-lasting Perfume",
    family:      "Fresh | Aquatic",
    notes:       ["Mandarin Oil", "Jasmine Accord", "Upcycled Oakwood"],
    topNotes:    "Mandarin Oil, Cardamom Oil, Pink Pepper",
    heartNotes:  "Jasmine Accord",
    baseNotes:   "Upcycled Oakwood, Olibanum Oil, Patchouli Heart",
    feelings:    ["Fresh", "Clean", "Energetic"],
    occasions:   ["Daily Wear", "Office", "Gym", "Summer"],
    description: "Aqua Manthan captures the essence of the ocean at dawn — crisp sea air, fresh citrus, and a whisper of green tea. Light enough for everyday wear, distinctive enough to remember.",
    behindPerfume: "Manthan means 'churning' in Sanskrit — a process of creation. Aqua Manthan is the result of churning the ocean for its purest essence, bottled for you.",
    whyLove:     "The perfect daily driver. Fresh yet distinctive, light yet lasting. The fragrance people notice without being able to place.",
    usage:       "Spray generously on chest and neck after a shower. The marine accord blooms even more refreshingly in heat.",
    image:       "/assets/images/products/aqua-manthan/01.jpg",
    thumbnails: [
      "/assets/images/products/thumbnails/Aqua%20Manthan/image-1.jpg",
      "/assets/images/products/thumbnails/Aqua%20Manthan/image-2.jpg",
      "/assets/images/products/thumbnails/Aqua%20Manthan/image-3.jpg"
    ],
    gallery: [
      "/assets/images/products/aqua-manthan/01.jpg",
      "/assets/images/products/aqua-manthan/02.jpg",
      "/assets/images/products/aqua-manthan/03.jpg",
      "/assets/images/products/aqua-manthan/04.jpg",
      "/assets/images/products/aqua-manthan/05.jpg"
    ],
    galleryAlt: [
      "NAFUME Aqua Manthan 50ML perfume bottle",
      "NAFUME Aqua Manthan fresh aquatic perfume",
      "NAFUME Aqua Manthan fragrance for warm Indian weather",
      "NAFUME Aqua Manthan ocean-inspired fresh perfume",
      "NAFUME Aqua Manthan perfume bottle and box"
    ],
    shopifyProductId: null, // Replace null with real Shopify Product ID
    shopifyVariantId: null, // Replace null with real Shopify Variant / merchandise ID
    fallbackRating: 4.7, fallbackReviewCount: 48,
    // ── Collection & merchandising fields (Upgrade 6) ──
    collections:         ["new-launches", "best-sellers", "him", "her", "unisex", "office-wear", "fresh-aquatic", "gifting", "discovery-set"],
    primaryCollection:   "fresh-aquatic",
    gender:              "unisex",
    isBestSeller:        true,
    isNewLaunch:         true,
    isGiftable:          true,
    isBundleEligible:    true,
    isDiscoveryEligible: true,
    badges:              ["Bestseller", "Fresh Pick"]
  },
  {
    id:          "all-day-misfit",
    slug: "/pages/products/all-day-misfit.html",
    name:        "All Day",
    displayName: "ALL DAY 50ML",
    edp:         "Long-lasting Perfume",
    family:      "Gourmand | Woody",
    notes:       ["Lavender", "Akigalawood", "Patchouli"],
    topNotes:    "Lavender, Calabrian Bergamot, Angelica, Carrot Seeds",
    heartNotes:  "Akigalawood, Ambrette (Musk Mallow), Styrax, Bulgarian Rose",
    baseNotes:   "Patchouli, Tolu Balsam, Labdanum, Tonka Bean",
    feelings:    ["Carefree", "Warm", "Unique"],
    occasions:   ["Everyday", "Casual Hangouts", "Late Nights", "Travel"],
    description: "Crafted for those who appreciate lasting elegance, ALL DAY is a signature fragrance designed to make every moment unforgettable.",
    behindPerfume: "Inspired by the art of timeless perfumery, ALL DAY is a fragrance that embodies confidence, depth, and effortless sophistication. It opens with vibrant spices and fresh citrus, unfolding into a rich heart of elegant woods and earthy accords. As it settles, warm amber, smooth sandalwood, smoky woods, and soft musk leave a refined trail that lingers throughout the day.",
    whyLove:     "A conversation-starter in a bottle. The coffee-tobacco accord is rare and uniquely addictive. Those who love it obsess over it.",
    usage:       "Apply on pulse points and the back of the neck. The gourmand notes develop beautifully over time — let it breathe and evolve on your skin.",
    image:       "/assets/images/products/all-day-misfit/01.jpg",
    thumbnails: [
      "/assets/images/products/thumbnails/All%20Day%20Misfit/image-1.jpg",
      "/assets/images/products/thumbnails/All%20Day%20Misfit/image-2.jpg",
      "/assets/images/products/thumbnails/All%20Day%20Misfit/image-3.jpg"
    ],
    gallery: [
      "/assets/images/products/all-day-misfit/01.jpg",
      "/assets/images/products/all-day-misfit/02.jpg",
      "/assets/images/products/all-day-misfit/03.jpg",
      "/assets/images/products/all-day-misfit/04.jpg",
      "/assets/images/products/all-day-misfit/05.jpg"
    ],
    galleryAlt: [
      "NAFUME All Day 50ML perfume bottle",
      "NAFUME All Day everyday office perfume",
      "NAFUME All Day clean daily wear fragrance",
      "NAFUME All Day gourmand woody perfume",
      "NAFUME All Day coffee and vanilla perfume set"
    ],
    shopifyProductId: null, // Replace null with real Shopify Product ID
    shopifyVariantId: null, // Replace null with real Shopify Variant / merchandise ID
    fallbackRating: 4.6, fallbackReviewCount: 29,
    // ── Collection & merchandising fields (Upgrade 6) ──
    collections:         ["new-launches", "him", "unisex", "gifting", "discovery-set"],
    primaryCollection:   "him",
    gender:              "unisex",
    isBestSeller:        false,
    isNewLaunch:         true,
    isGiftable:          true,
    isBundleEligible:    true,
    isDiscoveryEligible: true,
    badges:              ["Cult Favourite", "Everyday Wear"]
  }
];
window.LAUNCH_PRODUCTS = LAUNCH_PRODUCTS;

// ─── Cart storage  (isolated key — does not touch main website cart) ─
let launchCart = [];

function loadLaunchCart() {
  try { return JSON.parse(localStorage.getItem("nafumeLaunchCart") || "[]"); }
  catch (e) { return []; }
}
function saveLaunchCart() {
  try { localStorage.setItem("nafumeLaunchCart", JSON.stringify(launchCart)); }
  catch (e) {}
}

// ─── Cart operations ──────────────────────────────────────────────
function launchAddToCart(productId, qty) {
  qty = Math.max(1, parseInt(qty) || 1);
  var product = LAUNCH_PRODUCTS.find(function(p) { return p.id === productId; });
  if (!product) return;
  var idx = launchCart.findIndex(function(i) { return i.id === productId; });
  if (idx > -1) {
    launchCart[idx].qty += qty;
  } else {
    launchCart.push({
      id:    productId,
      name:  product.displayName,
      price: LAUNCH_CONFIG.sellingPrice,
      qty:   qty,
      image: product.image,
      slug:  product.slug
    });
  }
  saveLaunchCart();
  renderCartUI();
  // Analytics (Upgrade 10) — safe + guarded.
  if (window.OperationsService) {
    try { window.OperationsService.recordAnalyticsEvent("add_to_cart", { productId: productId, qty: qty }); } catch (e) {}
  }
}

function launchRemove(productId) {
  launchCart = launchCart.filter(function(i) { return i.id !== productId; });
  saveLaunchCart();
  renderCartUI();
}

function launchChangeQty(productId, delta) {
  var idx = launchCart.findIndex(function(i) { return i.id === productId; });
  if (idx === -1) return;
  launchCart[idx].qty += delta;
  if (launchCart[idx].qty <= 0) launchCart.splice(idx, 1);
  saveLaunchCart();
  renderCartUI();
}

function launchClearCart() {
  if (!confirm("Remove all items from cart?")) return;
  launchCart = []; saveLaunchCart(); renderCartUI(); closeCart();
}

// ─── Cart math ────────────────────────────────────────────────────
function launchCount()    { return launchCart.reduce(function(s, i) { return s + i.qty; }, 0); }
function launchSubtotal() { return launchCart.reduce(function(s, i) { return s + i.price * i.qty; }, 0); }
function launchShipping() {
  var sub = launchSubtotal();
  if (sub === 0) return 0;
  return sub >= LAUNCH_CONFIG.freeShippingThreshold ? 0 : LAUNCH_CONFIG.shippingCost;
}
function launchTotal() { return launchSubtotal() + launchShipping(); }

// ─── Mobile nav drawer (nf-header) ───────────────────────────────
function nfMenuOpen() {
  var d = document.getElementById("nf-mobile-drawer");
  var o = document.getElementById("nf-drawer-overlay");
  if (d) d.classList.add("nf-open");
  if (o) o.classList.add("nf-open");
  document.body.style.overflow = "hidden";
}
function nfMenuClose() {
  var d = document.getElementById("nf-mobile-drawer");
  var o = document.getElementById("nf-drawer-overlay");
  if (d) d.classList.remove("nf-open");
  if (o) o.classList.remove("nf-open");
  document.body.style.overflow = "";
}

// ─── Drawer open / close ──────────────────────────────────────────
function openCart() {
  var drawer  = document.getElementById("launch-cart-drawer");
  var overlay = document.getElementById("launch-overlay");
  if (drawer)  drawer.classList.add("open");
  if (overlay) overlay.classList.add("active");
  document.body.style.overflow = "hidden";
}
function closeCart() {
  var drawer  = document.getElementById("launch-cart-drawer");
  var overlay = document.getElementById("launch-overlay");
  if (drawer)  drawer.classList.remove("open");
  if (overlay) overlay.classList.remove("active");
  document.body.style.overflow = "";
}

// ─── Badges + sticky bar ─────────────────────────────────────────
function updateCartBadges() {
  var count = launchCount();
  var total = launchTotal();

  // All badge elements
  document.querySelectorAll(".lp-cart-badge").forEach(function(el) {
    el.textContent = count;
    count > 0 ? el.classList.add("visible") : el.classList.remove("visible");
  });
  document.querySelectorAll(".lp-cart-count-text").forEach(function(el) {
    el.textContent = count > 0 ? " (" + count + ")" : "";
  });

  // Sticky bar
  var bar     = document.getElementById("launch-sticky-bar");
  var sCount  = document.getElementById("sticky-count");
  var sTotal  = document.getElementById("sticky-total");
  if (bar) {
    if (count > 0) { bar.classList.add("visible"); document.body.classList.add("has-bar"); }
    else           { bar.classList.remove("visible"); document.body.classList.remove("has-bar"); }
  }
  if (sCount) sCount.textContent = count + (count === 1 ? " item" : " items");
  if (sTotal) sTotal.textContent = LAUNCH_CONFIG.currency + total.toLocaleString("en-IN");
}

// ─── Render cart drawer ───────────────────────────────────────────
function renderCartDrawer() {
  var count  = launchCount();
  var sub    = launchSubtotal();
  var ship   = launchShipping();
  var total  = launchTotal();
  var thresh = LAUNCH_CONFIG.freeShippingThreshold;
  var freeSh = ship === 0 && sub > 0;
  var curr   = LAUNCH_CONFIG.currency;

  var countEl  = document.getElementById("cart-drawer-count");
  var itemsEl  = document.getElementById("launch-cart-items");
  var footerEl = document.getElementById("launch-cart-footer");

  if (countEl) countEl.textContent = count + (count === 1 ? " item" : " items");
  if (!itemsEl) return;

  // ── Empty state ──
  if (launchCart.length === 0) {
    itemsEl.innerHTML =
      '<div class="cart-empty-state">' +
        '<span class="material-symbols-outlined">shopping_bag</span>' +
        '<p>Your cart is empty</p>' +
        '<p class="cart-empty-sub">Add a fragrance to get started</p>' +
        '<a href="/#new-launches" class="cart-browse-link" onclick="closeCart()">Shop New Launches →</a>' +
      '</div>';
    if (footerEl) footerEl.innerHTML = "";
    return;
  }

  // ── Shipping progress ──
  var pct = Math.min(100, Math.round((sub / thresh) * 100));
  var progressHTML = freeSh
    ? '<span style="font-size:11px;font-weight:700;color:var(--green);display:flex;align-items:center;gap:6px;"><span class="material-symbols-outlined" style="font-size:15px;">check_circle</span>FREE shipping unlocked!</span>'
    : '<span>Add <strong>' + curr + (thresh - sub).toLocaleString("en-IN") + '</strong> more for FREE shipping</span>' +
      '<div class="ship-bar"><div class="ship-fill" style="width:' + pct + '%"></div></div>';

  // ── Item rows ──
  var itemsHTML = launchCart.map(function(item) {
    return '<div class="cart-item">' +
      '<img class="cart-item-img" src="' + item.image + '" alt="' + escapeHtml(item.name) + '" onerror="this.style.visibility=\'hidden\'">' +
      '<div class="cart-item-info">' +
        '<p class="cart-item-name">' + escapeHtml(item.name) + '</p>' +
        '<p class="cart-item-sub">50ml Perfume</p>' +
        '<div class="cart-qty-row">' +
          '<button class="cq-btn" onclick="launchChangeQty(\'' + item.id + '\',-1)">&#8722;</button>' +
          '<span class="cq-val">' + item.qty + '</span>' +
          '<button class="cq-btn" onclick="launchChangeQty(\'' + item.id + '\', 1)">+</button>' +
        '</div>' +
      '</div>' +
      '<div class="cart-item-price-col">' +
        '<span class="cart-item-total">' + curr + (item.price * item.qty).toLocaleString("en-IN") + '</span>' +
        '<span class="cart-item-each">' + curr + item.price.toLocaleString("en-IN") + ' each</span>' +
        '<button class="cart-item-del" onclick="launchRemove(\'' + item.id + '\')" aria-label="Remove">' +
          '<span class="material-symbols-outlined">delete</span>' +
        '</button>' +
      '</div>' +
    '</div>';
  }).join("");

  itemsEl.innerHTML =
    '<div class="cart-ship-bar-wrap">' + progressHTML + '</div>' +
    cartBundleBannerHtml() +
    itemsHTML +
    cartUpsellHtml();

  // ── Footer (with offer-aware totals) ──
  if (!footerEl) return;

  var bundleDiscount = 0, offerRowsHtml = "";
  if (window.Offers) {
    try {
      var b = window.Offers.calculateBuyAny3Bundle(launchCart);
      if (b.applied && b.discount > 0) {
        bundleDiscount = b.discount;
        offerRowsHtml +=
          '<div class="cart-row cart-row-offer"><span class="cart-offer-label">Buy Any 3 bundle</span>' +
          '<span class="cart-free">−' + curr + b.discount.toLocaleString("en-IN") + '</span></div>';
      }
    } catch (e) {}
  }
  var finalTotal = Math.max(0, total - bundleDiscount);

  footerEl.innerHTML =
    '<div class="cart-totals">' +
      '<div class="cart-row"><span class="cart-muted">Subtotal</span><span style="font-weight:700;">' + curr + sub.toLocaleString("en-IN") + '</span></div>' +
      offerRowsHtml +
      '<div class="cart-row"><span class="cart-muted">Shipping</span><span class="' + (freeSh ? "cart-free" : "") + '">' + (freeSh ? "FREE" : curr + ship) + '</span></div>' +
      '<div class="cart-row-total"><span>Total</span><span>' + curr + finalTotal.toLocaleString("en-IN") + '</span></div>' +
      '<p class="cart-gst-note">GST inclusive · offers applied at checkout</p>' +
    '</div>' +
    '<a href="/pages/order/shipping.html" class="btn-to-shipping">Proceed to Checkout →</a>' +
    '<button onclick="launchClearCart()" class="btn-clear-cart">Clear Cart</button>';
}

// ─── Cart bundle banner (Buy Any 3 progress / unlocked) — Upgrade 9 ──────────
function cartBundleBannerHtml() {
  if (!window.Offers) return "";
  try {
    var b = window.Offers.calculateBuyAny3Bundle(launchCart);
    if (!b.enabled) return "";
    if (b.eligible) {
      var msg = b.applied
        ? 'Bundle offer applied — you saved ' + LAUNCH_CONFIG.currency + b.discount.toLocaleString("en-IN") + '!'
        : 'Buy Any 3 unlocked — you\'re already getting the best price.';
      return '<div class="cart-bundle-banner cart-bundle-on">' +
        '<span class="material-symbols-outlined">redeem</span><span>' + msg + '</span></div>';
    }
    if (b.eligibleCount > 0 && b.remainingToUnlock > 0) {
      return '<div class="cart-bundle-banner">' +
        '<span class="material-symbols-outlined">add_shopping_cart</span>' +
        '<span>Add <strong>' + b.remainingToUnlock + '</strong> more eligible perfume' +
        (b.remainingToUnlock === 1 ? '' : 's') + ' to unlock <strong>' + b.label + '</strong>.</span></div>';
    }
  } catch (e) {}
  return "";
}

// ─── Cart upsell recommendations — Upgrade 9 ─────────────────────────────────
function cartUpsellHtml() {
  if (!window.Offers || !launchCart.length) return "";
  var recs;
  try { recs = window.Offers.getRecommendedUpsells(launchCart, LAUNCH_PRODUCTS); }
  catch (e) { return ""; }
  if (!recs || !recs.length) return "";

  var cards = recs.slice(0, 3).map(function (r) {
    var p = r.product;
    return '<div class="cart-upsell-card">' +
      '<img class="cart-upsell-img" src="' + p.image + '" alt="NAFUME ' + escapeHtml(p.name) + ' perfume bottle" loading="lazy" onerror="this.style.visibility=\'hidden\'">' +
      '<div class="cart-upsell-info">' +
        '<a href="' + p.slug + '" class="cart-upsell-name">' + escapeHtml(p.name) + '</a>' +
        '<span class="cart-upsell-reason">' + escapeHtml(r.reason) + '</span>' +
        '<span class="cart-upsell-price">' + LAUNCH_CONFIG.currency + LAUNCH_CONFIG.sellingPrice.toLocaleString("en-IN") + '</span>' +
      '</div>' +
      '<button class="cart-upsell-add" onclick="handleUpsellAdd(\'' + p.id + '\',this)" aria-label="Add ' + escapeHtml(p.name) + '">+</button>' +
    '</div>';
  }).join("");

  return '<div class="cart-upsell-wrap">' +
    '<p class="cart-upsell-title">Complete Your Fragrance Wardrobe</p>' +
    cards +
    '<a href="/pages/collections/collection.html?collection=discovery-set" class="cart-discovery-cta" onclick="closeCart()">Not sure? Try the Discovery Set first →</a>' +
  '</div>';
}

// Upsell add (records analytics, then adds normally) — Upgrade 10.
function handleUpsellAdd(productId, btn) {
  if (window.OperationsService) {
    try { window.OperationsService.recordAnalyticsEvent("upsell_added", { productId: productId }); } catch (e) {}
  }
  handleGridAdd(productId, btn);
}

// ─── Master render ────────────────────────────────────────────────
function renderCartUI() {
  updateCartBadges();
  renderCartDrawer();
}

// ─── Toast ────────────────────────────────────────────────────────
function showLaunchToast(msg) {
  var el = document.getElementById("launch-toast");
  if (!el) return;
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(el._timer);
  el._timer = setTimeout(function() { el.classList.remove("show"); }, 2500);
}

// ─── Placeholder image SVG ────────────────────────────────────────
function placeholderSrc(name) {
  var encoded = encodeURIComponent(name);
  return "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='400' height='533'%3E%3Crect width='400' height='533' fill='%23111'/%3E%3Ctext x='200' y='260' text-anchor='middle' font-family='Arial Narrow,sans-serif' font-size='22' font-weight='bold' fill='%23C5A059' letter-spacing='4'%3E" + encoded + "%3C/text%3E%3Ctext x='200' y='295' text-anchor='middle' font-family='Arial,sans-serif' font-size='11' fill='%23888' letter-spacing='3'%3ENAFUME%3C/text%3E%3C/svg%3E";
}

// ─── Build badge HTML for a product (ONE badge only) ───────────────
// Renders a single primary badge to avoid stacked/overlapping overlays.
// Priority: first value in p.badges, else "New Launch" for new items.
// Note: only the .nl-badge--primary class is used (the legacy absolute
// .nl-badge class caused multiple badges to overlap at the same spot).
function productBadgesHtml(p) {
  var primary = (p.badges && p.badges.length) ? p.badges[0]
              : (p.isNewLaunch ? "New Launch" : null);
  if (!primary) return "";
  return '<span class="nl-badge--primary">' + primary + '</span>';
}

// ─── Product-card thumbnail picker (temporary visual variety) ──────
// Returns a per-product thumbnail variation for LISTING CARDS only, so the
// same product looks different across sections (HER / HIM / BEST SELLERS / etc.)
// instead of repeating one packshot. PDP gallery + sticky bar are unaffected.
//
// Selection is DETERMINISTIC: a hash of (context + product id + index) picks a
// stable image, so it looks varied but never flickers/changes on refresh.
// Falls back to product.image when a product has no `thumbnails` list.
// Each product's `thumbnails` only contains that product's own images.
function getProductThumbnail(product, context, index) {
  if (!product) return "";
  var list = (product.thumbnails && product.thumbnails.length) ? product.thumbnails : null;
  if (!list) return product.image;            // safe fallback — never breaks
  var key = String(context || "") + "|" + product.id + "|" + (index || 0);
  // FNV-1a hash + avalanche — spreads evenly even across short lists (4–7 imgs).
  var h = 2166136261;
  for (var i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  h = (h ^ (h >>> 16)) >>> 0;
  return list[h % list.length];
}

function getProductHoverThumbnail(product) {
  if (!product || !product.thumbnails || product.thumbnails.length < 2) return null;
  return product.thumbnails[1];
}

// ─── Product grid renderer (used by launch.html) ──────────────────
function renderLaunchGrid(containerId, products, context) {
  var grid = document.getElementById(containerId);
  if (!grid) return;

  grid.innerHTML = products.map(function(p, i) {
    var imgSrc = (p.thumbnails && p.thumbnails.length) ? p.thumbnails[0] : p.image;
    var hoverSrc = getProductHoverThumbnail(p);
    var imgErr = 'onerror="this.src=\'' + placeholderSrc(p.name) + '\'"';
    var hoverImg = hoverSrc
      ? '<img class="prod-card-img prod-card-img--hover" src="' + hoverSrc + '" alt="" loading="lazy" aria-hidden="true" decoding="async">'
      : '';
    return '<div class="prod-card">' +
      '<a href="' + p.slug + '" class="prod-card-link" aria-label="View ' + p.name + '">' +
        '<img class="prod-card-img" src="' + imgSrc + '" alt="' + p.name + ' by NAFUME" loading="lazy" ' + imgErr + '>' +
        hoverImg +
        '<div class="nl-badge-wrap">' + productBadgesHtml(p) + '</div>' +
      '</a>' +
      '<div class="prod-card-info">' +
        '<a href="' + p.slug + '" class="prod-card-name">' + p.displayName + '</a>' +
        '<p class="prod-card-family">' + p.family + '</p>' +
        cardRatingHtml(p.id) +
        '<div class="prod-card-price">' +
          '<span class="price-sell">&#8377;' + LAUNCH_CONFIG.sellingPrice.toLocaleString("en-IN") + '</span>' +
          '<span class="price-mrp">MRP &#8377;' + LAUNCH_CONFIG.mrp.toLocaleString("en-IN") + '</span>' +
        '</div>' +
        '<button class="prod-card-atc" id="atc-' + p.id + '" onclick="handleGridAdd(\'' + p.id + '\',this)">' +
          'Add to Cart' +
        '</button>' +
      '</div>' +
    '</div>';
  }).join("");
}

function handleGridAdd(productId, btn) {
  launchAddToCart(productId, 1);
  if (btn) {
    var orig = btn.textContent;
    btn.textContent = "Added ✓";
    btn.classList.add("added");
    setTimeout(function() {
      btn.textContent = orig;
      btn.classList.remove("added");
    }, 1300);
  }
  var p = LAUNCH_PRODUCTS.find(function(x) { return x.id === productId; });
  if (p) showLaunchToast(p.name + " added to cart");
}

// ─── Product page renderer (used by individual product pages) ──────
function initProductPage(productId) {
  var p = LAUNCH_PRODUCTS.find(function(x) { return x.id === productId; });
  if (!p) return;

  // Meta
  document.title = p.name + " — Premium Perfume 50ml — NAFUME Artisan Luxe";

  // Breadcrumb
  var bcEl = document.getElementById("pdp-bc-name");
  if (bcEl) bcEl.textContent = p.name;

  // Root container
  var rootEl = document.getElementById("pdp-root");
  if (!rootEl) return;

  // Gallery — use p.gallery array if available, otherwise single product image
  var galleryImgs = (p.gallery && p.gallery.length) ? p.gallery : [p.image];
  var galleryAltList = (p.galleryAlt && p.galleryAlt.length) ? p.galleryAlt : null;

  var galleryHtml = '<div class="product-gallery">' +
    galleryImgs.map(function(src, idx) {
      var isLast = idx === galleryImgs.length - 1;
      var isFull = isLast && (galleryImgs.length % 2 === 1);
      var altText = galleryAltList && galleryAltList[idx] ? galleryAltList[idx] : 'NAFUME ' + p.name + ' perfume';
      return '<div class="product-gallery-item' + (isFull ? ' product-gallery-full' : '') + '">' +
        '<img src="' + src + '" alt="' + altText + '"' +
        ' class="product-gallery-img"' +
        ' loading="' + (idx === 0 ? 'eager' : 'lazy') + '"' +
        (idx === 0 ? ' fetchpriority="high"' : '') +
        ' decoding="async"' +
        ' width="1500" height="1500"' +
      '>' +
      '</div>';
    }).join('') +
  '</div>';

  // Accordion data
  var accordionData = [
    {
      title: 'Fragrance Notes',
      body: '<div class="acc-notes-grid">' +
        '<div class="acc-note-col">' +
          '<p class="acc-note-head">Top Notes</p>' +
          '<p class="acc-note-val">' + p.topNotes + '</p>' +
        '</div>' +
        '<div class="acc-note-col">' +
          '<p class="acc-note-head">Heart Notes</p>' +
          '<p class="acc-note-val">' + p.heartNotes + '</p>' +
        '</div>' +
        '<div class="acc-note-col">' +
          '<p class="acc-note-head">Base Notes</p>' +
          '<p class="acc-note-val">' + p.baseNotes + '</p>' +
        '</div>' +
      '</div>'
    },
    {
      title: 'Feelings & Occasions',
      body: '<p class="acc-label-sm">Feelings</p>' +
        '<div class="acc-tags">' +
          p.feelings.map(function(f) { return '<span class="acc-tag">' + f + '</span>'; }).join('') +
        '</div>' +
        '<p class="acc-label-sm" style="margin-top:14px">Best For</p>' +
        '<div class="acc-tags">' +
          p.occasions.map(function(o) { return '<span class="acc-tag">' + o + '</span>'; }).join('') +
        '</div>'
    },
    {
      title: 'Behind the Perfume',
      body: '<p class="acc-body-text">' + p.behindPerfume + '</p>' +
        '<p class="acc-body-text" style="margin-top:10px">' + p.description + '</p>'
    },
    {
      title: 'Shipping & Returns',
      body: '<p class="acc-body-text">We ship across India via trusted courier partners. Orders dispatched within 24 hours of WhatsApp confirmation.</p>' +
        '<ul class="acc-list">' +
          '<li>Delivery in 3–7 business days pan-India (may vary by location &amp; holidays)</li>' +
          '<li>' + LAUNCH_CONFIG.shippingNote + '</li>' +
          '<li>₹' + LAUNCH_CONFIG.shippingCost + ' flat shipping for orders below ₹' + LAUNCH_CONFIG.freeShippingThreshold + '</li>' +
          '<li>COD and prepaid (UPI / Bank Transfer) accepted</li>' +
          '<li>Returns accepted within 48 hours of delivery for damaged, wrong, or missing items only</li>' +
          '<li>Unboxing photo/video required for return requests</li>' +
        '</ul>' +
        '<p class="acc-body-text" style="margin-top:10px">' +
          '<a href="/pages/legal/shipping-policy.html" style="color:#555;text-decoration:underline">Read full Shipping Policy</a>' +
          ' &nbsp;·&nbsp; ' +
          '<a href="/pages/legal/return-refund-policy.html" style="color:#555;text-decoration:underline">Return &amp; Refund Policy</a>' +
        '</p>'
    },
    {
      title: 'Legal Information',
      body: '<div class="acc-legal-grid">' +
          '<div class="acc-legal-row"><span class="acc-legal-label">Product Type</span><span class="acc-legal-val">Perfume</span></div>' +
          '<div class="acc-legal-row"><span class="acc-legal-label">Net Quantity</span><span class="acc-legal-val">50 ml</span></div>' +
          '<div class="acc-legal-row"><span class="acc-legal-label">MRP (Incl. taxes)</span><span class="acc-legal-val">₹' + LAUNCH_CONFIG.mrp + '</span></div>' +
          '<div class="acc-legal-row"><span class="acc-legal-label">Country of Origin</span><span class="acc-legal-val">India</span></div>' +
          '<div class="acc-legal-row"><span class="acc-legal-label">Manufacturer / Marketer</span><span class="acc-legal-val">NAFUME Artisan Luxe, Ashok Vihar, Delhi, India</span></div>' +
          '<div class="acc-legal-row"><span class="acc-legal-label">Customer Care</span><span class="acc-legal-val">nafume.official@gmail.com</span></div>' +
        '</div>' +
        '<div class="acc-legal-row" style="margin-bottom:10px"><span class="acc-legal-label">Ingredients</span>' +
          '<span class="acc-legal-val">Alcohol Denat., Fragrance (Parfum), Aqua (Water)</span>' +
        '</div>' +
        '<div class="acc-legal-caution">' +
          '<p><strong>Caution:</strong> For external use only. Avoid contact with eyes. Keep away from flame and heat sources. Keep out of reach of children. Patch test recommended for sensitive skin. Store in a cool, dry place away from direct sunlight.</p>' +
        '</div>' +
        '<div class="acc-legal-links">' +
          '<a href="/pages/legal/privacy-policy.html">Privacy Policy</a>' +
          '<a href="/pages/legal/terms-conditions.html">Terms &amp; Conditions</a>' +
          '<a href="/pages/legal/return-refund-policy.html">Returns Policy</a>' +
        '</div>'
    }
  ];

  var accordionsHtml = '<div class="product-accordion">' +
    accordionData.map(function(item) {
      return '<div class="pdp-acc-item">' +
        '<button class="pdp-acc-trigger" type="button" aria-expanded="false">' +
          '<span class="pdp-acc-title">' + item.title + '</span>' +
          '<span class="material-symbols-outlined pdp-acc-icon">add</span>' +
        '</button>' +
        '<div class="pdp-acc-body">' +
          '<div class="pdp-acc-inner">' + item.body + '</div>' +
        '</div>' +
      '</div>';
    }).join('') +
  '</div>';

  // Price values
  var curr    = LAUNCH_CONFIG.currency;
  var sellStr = LAUNCH_CONFIG.sellingPrice.toLocaleString('en-IN');
  var mrpStr  = LAUNCH_CONFIG.mrp.toLocaleString('en-IN');

  // ── Enhanced PDP (Fraganote-style) — applies to ALL products ───────────────
  // Reusable layout: every product page gets the eyebrow, gender badge, rating
  // row, offer strip and sticky bottom purchase bar. All per-product content is
  // pulled from LAUNCH_PRODUCTS (name, gender, notes, price, gallery, reviews),
  // so a new product needs no PDP code change — just a catalogue entry.
  var isEnhancedPdp = true;

  // Eyebrow (enhanced only) — uses existing product data only.
  // NOTE: gender-specific PDP badge intentionally removed — all NAFUME
  // perfumes are unisex. The underlying p.gender field is kept as-is since
  // it still drives the real "For Him"/"For Her" collection pages.
  var pdpEyebrow = isEnhancedPdp ? '<p class="pdp-eyebrow">New Arrival</p>' : '';

  // Rating row (enhanced only) — real review summary / fallback rating; the site
  // already surfaces ratings on cards, so this reuses the same data + star style.
  var pdpRatingRow = '';
  if (isEnhancedPdp && window.ReviewService) {
    var rSum = window.ReviewService.getReviewSummary(productId);
    if (rSum && rSum.hasReviews && rSum.count) {
      pdpRatingRow =
        '<div class="pdp-rating-row" aria-label="Rated ' + rSum.average + ' out of 5 from ' + rSum.count + ' reviews">' +
          '<span class="pdp-rating-stars">' + starRow(rSum.average, 'rv-stars') + '</span>' +
          '<span class="pdp-rating-num">' + rSum.average.toFixed(1) + '</span>' +
          '<span class="pdp-rating-count">' + rSum.count + (rSum.count === 1 ? ' review' : ' reviews') + '</span>' +
        '</div>';
    }
  }

  // Offer strip (enhanced only) — uses REAL offers from COMMERCE_CONFIG. No fake
  // coupon codes are invented; bundle CTA points at the existing BYOB page.
  var pdpOfferStrip = '';
  if (isEnhancedPdp) {
    var OFF        = (window.COMMERCE_CONFIG && window.COMMERCE_CONFIG.offers) || {};
    var prepaidOff = OFF.prepaidDiscount;
    var buy3Off    = OFF.buyAny3;
    var stripInner = '';
    if (prepaidOff && prepaidOff.enabled && prepaidOff.label) {
      stripInner +=
        '<div class="pdp-offer-banner">' +
          '<span class="material-symbols-outlined">sell</span>' +
          '<span>' + prepaidOff.label + '</span>' +
        '</div>';
    }
    if (buy3Off && buy3Off.enabled) {
      stripInner +=
        '<a href="/pages/collections/build-your-own-box.html" class="pdp-offer-bundle-btn">' +
          '<span>' + (buy3Off.label || 'Buy any 3 × 50ml') + '</span>' +
          '<span class="material-symbols-outlined">arrow_forward</span>' +
        '</a>';
    }
    if (stripInner) pdpOfferStrip = '<div class="pdp-offer-strip">' + stripInner + '</div>';
  }

  var panelHtml =
    '<div class="product-info-panel">' +
      '<div class="product-sticky-panel">' +
        (isEnhancedPdp ? pdpEyebrow : '<span class="product-badge">New Launch</span>') +
        '<h1 class="product-name">' + p.displayName + '</h1>' +
        pdpRatingRow +
        '<p class="product-edp-type">' + p.edp + ' · 50ml · ' + p.family + '</p>' +
        '<div class="product-notes-preview">' +
          p.notes.map(function(n) { return '<span class="note-chip">' + n + '</span>'; }).join('') +
        '</div>' +
        '<div class="product-promo-bar">' + LAUNCH_CONFIG.saleLabel + ' — Limited First Batch</div>' +
        '<div class="product-price-block">' +
          '<span class="product-price-sell">' + curr + sellStr + '</span>' +
          '<span class="product-price-mrp">MRP ' + curr + mrpStr + '</span>' +
          '<span class="product-price-off">' + LAUNCH_CONFIG.discountLabel + '</span>' +
        '</div>' +
        '<p class="product-shipping-note">' +
          '<span class="material-symbols-outlined">local_shipping</span> ' + LAUNCH_CONFIG.shippingNote +
        '</p>' +
        '<div class="product-actions">' +
          '<div class="product-qty">' +
            '<button class="product-qty-btn" onclick="pdpAdjQty(-1)" aria-label="Decrease quantity">−</button>' +
            '<span class="product-qty-val" id="pdp-qty-val">1</span>' +
            '<button class="product-qty-btn product-qty-plus" onclick="pdpAdjQty(1)" aria-label="Increase quantity">+</button>' +
          '</div>' +
          '<button class="product-btn-atc" id="pdp-btn-atc" onclick="pdpAddToCart()">Add to Cart</button>' +
        '</div>' +
        '<a href="/pages/order/shipping.html" class="product-btn-ship">' +
          '<span class="material-symbols-outlined" style="font-size:16px">arrow_forward</span>' +
          'Continue to Shipping' +
        '</a>' +
        pdpOfferStrip +
        '<div class="product-benefits">' +
          '<div class="benefit-item">' +
            '<span class="material-symbols-outlined">verified</span>' +
            '<span>100% Genuine</span>' +
          '</div>' +
          '<div class="benefit-item">' +
            '<span class="material-symbols-outlined">local_shipping</span>' +
            '<span>Fast Shipping</span>' +
          '</div>' +
          '<div class="benefit-item">' +
            '<span class="material-symbols-outlined">replay</span>' +
            '<span>Easy Returns</span>' +
          '</div>' +
          '<div class="benefit-item">' +
            '<span class="material-symbols-outlined">lock</span>' +
            '<span>Secure Checkout</span>' +
          '</div>' +
        '</div>' +
        accordionsHtml +
      '</div>' +
    '</div>';

  // Render layout into root
  rootEl.innerHTML =
    '<div class="pdp-layout">' +
      '<div class="pdp-gallery-col">' + galleryHtml + '</div>' +
      '<div class="pdp-info-col">' + panelHtml + '</div>' +
    '</div>';

  // Qty / ATC handlers. Both the panel and the (enhanced) sticky bottom bar
  // share window._pdpQty, so their quantity displays and buttons stay in sync.
  window._pdpQty = 1;
  window.pdpAdjQty = function(delta) {
    window._pdpQty = Math.max(1, (window._pdpQty || 1) + delta);
    var ids = ["pdp-qty-val", "pdp-buy-bar-qty-val"];
    ids.forEach(function(id) {
      var el = document.getElementById(id);
      if (el) el.textContent = window._pdpQty;
    });
  };
  window.pdpAddToCart = function() {
    launchAddToCart(productId, window._pdpQty || 1);
    ["pdp-btn-atc", "pdp-buy-bar-atc"].forEach(function(id) {
      var btn = document.getElementById(id);
      if (!btn) return;
      var label = btn.getAttribute("data-label") || "Add to Cart";
      btn.textContent = "Added ✓";
      btn.classList.add("added");
      setTimeout(function() {
        btn.textContent = label;
        btn.classList.remove("added");
      }, 1300);
    });
    showLaunchToast(p.name + " added to cart");
  };

  // Enhanced PDP only: build the sticky bottom purchase bar (thumbnail + name +
  // price + qty + add-to-cart) that reveals after the main CTA scrolls off-screen.
  if (isEnhancedPdp) buildPdpBuyBar(p);

  // Accordion toggle (product pages load launch.js only, not app.js)
  rootEl.addEventListener('click', function(e) {
    var trigger = e.target.closest('.pdp-acc-trigger');
    if (!trigger) return;
    var item = trigger.closest('.pdp-acc-item');
    if (!item) return;
    var isOpen = trigger.getAttribute('aria-expanded') === 'true';
    rootEl.querySelectorAll('.pdp-acc-item').forEach(function(it) {
      it.querySelector('.pdp-acc-trigger').setAttribute('aria-expanded', 'false');
      it.querySelector('.pdp-acc-body').classList.remove('open');
      it.querySelector('.pdp-acc-icon').textContent = 'add';
    });
    if (!isOpen) {
      trigger.setAttribute('aria-expanded', 'true');
      item.querySelector('.pdp-acc-body').classList.add('open');
      item.querySelector('.pdp-acc-icon').textContent = 'remove';
    }
  });

  // Related products — same collection first, then remaining (Upgrade 6)
  var othersEl = document.getElementById("other-launches");
  if (othersEl) {
    var sameCollection = LAUNCH_PRODUCTS.filter(function(x) {
      return x.id !== productId && p.collections && x.collections &&
             p.collections.some(function(c) { return x.collections.indexOf(c) > -1 && c !== "new-launches" && c !== "gifting" && c !== "discovery-set"; });
    });
    var others = sameCollection.length
      ? sameCollection
      : LAUNCH_PRODUCTS.filter(function(x) { return x.id !== productId; });

    othersEl.innerHTML =
      '<div class="other-launches-wrap">' +
        '<p class="other-launches-title">' + (sameCollection.length ? 'More From This Collection' : 'Other New Launches') + '</p>' +
        '<div class="other-grid">' +
          others.map(function(op, oi) {
            var oErr = 'onerror="this.src=\'' + placeholderSrc(op.name) + '\'"';
            var oHoverSrc = getProductHoverThumbnail(op);
            var oHoverImg = oHoverSrc ? '<img class="prod-card-img prod-card-img--hover" src="' + oHoverSrc + '" alt="" loading="lazy" aria-hidden="true" decoding="async">' : '';
            return '<div class="prod-card">' +
              '<a href="' + op.slug + '" class="prod-card-link">' +
                '<img class="prod-card-img" src="' + ((op.thumbnails && op.thumbnails.length) ? op.thumbnails[0] : op.image) + '" alt="NAFUME ' + op.name + ' perfume bottle" loading="lazy" ' + oErr + '>' +
                oHoverImg +
                '<div class="nl-badge-wrap">' + productBadgesHtml(op) + '</div>' +
              '</a>' +
              '<div class="prod-card-info">' +
                '<a href="' + op.slug + '" class="prod-card-name">' + op.displayName + '</a>' +
                '<p class="prod-card-family">' + op.family + '</p>' +
                cardRatingHtml(op.id) +
                '<div class="prod-card-price">' +
                  '<span class="price-sell">₹' + LAUNCH_CONFIG.sellingPrice + '</span>' +
                  '<span class="price-mrp">MRP ₹' + LAUNCH_CONFIG.mrp + '</span>' +
                '</div>' +
                '<button class="prod-card-atc" onclick="handleGridAdd(\'' + op.id + '\',this)">Add to Cart</button>' +
              '</div>' +
            '</div>';
          }).join("") +
        '</div>' +
        '<div class="other-launches-actions">' +
          '<a href="/pages/collections/collections.html" class="other-launches-browse">Browse All Collections →</a>' +
        '</div>' +
      '</div>';
  }

  // Stock state (Upgrade 10) — out-of-stock / low-stock display.
  applyProductStockState(p);

  // Analytics (Upgrade 10) — product view.
  if (window.OperationsService) {
    try { window.OperationsService.recordAnalyticsEvent("product_view", { productId: p.id }); } catch (e) {}
  }

  // Pairing / bundle upsells (Upgrade 9) — before the SEO sections.
  renderProductPairings(p);

  // SEO sections (Upgrade 8) — description depth, how-to-wear, best-for, FAQ.
  renderProductSeoSections(p);

  // Reviews section (Upgrade 4) — injected after the PDP, before other-launches.
  renderProductReviews(productId);

  // Dynamic SEO metadata + structured data (Upgrade 8).
  applyProductSeo(p);
}

// ─── Sticky bottom purchase bar (enhanced PDP) ──────────────────────────────
// Creates a fixed bottom bar (product thumb + name + price + qty + add-to-cart)
// that is hidden until the user scrolls past the main Add-to-Cart button. The
// qty/ATC controls reuse pdpAdjQty/pdpAddToCart so cart + pricing logic is
// unchanged. Only built for the test product, so other pages are untouched.
function buildPdpBuyBar(p) {
  if (!p || document.getElementById("pdp-buy-bar")) return;

  var curr = LAUNCH_CONFIG.currency;
  var sell = LAUNCH_CONFIG.sellingPrice.toLocaleString("en-IN");
  var mrp  = LAUNCH_CONFIG.mrp.toLocaleString("en-IN");

  var bar = document.createElement("div");
  bar.className = "pdp-buy-bar";
  bar.id = "pdp-buy-bar";
  bar.setAttribute("aria-hidden", "true");
  bar.innerHTML =
    '<div class="pdp-buy-bar-inner">' +
      '<img class="pdp-buy-bar-thumb" src="' + p.image + '" alt="NAFUME ' + p.name + ' perfume" ' +
        'loading="lazy" decoding="async" onerror="this.src=\'' + placeholderSrc(p.name) + '\'">' +
      '<div class="pdp-buy-bar-info">' +
        '<span class="pdp-buy-bar-name">' + p.displayName + '</span>' +
        '<span class="pdp-buy-bar-price">' + curr + sell +
          ' <s>' + curr + mrp + '</s></span>' +
      '</div>' +
      '<div class="pdp-buy-bar-actions">' +
        '<div class="pdp-buy-bar-qty">' +
          '<button type="button" onclick="pdpAdjQty(-1)" aria-label="Decrease quantity">−</button>' +
          '<span id="pdp-buy-bar-qty-val">1</span>' +
          '<button type="button" onclick="pdpAdjQty(1)" aria-label="Increase quantity">+</button>' +
        '</div>' +
        '<button class="pdp-buy-bar-atc" id="pdp-buy-bar-atc" data-label="Add to Cart" ' +
          'onclick="pdpAddToCart()">Add to Cart</button>' +
      '</div>' +
    '</div>';
  document.body.appendChild(bar);

  // Reveal only after the main Add-to-Cart button has scrolled above the viewport
  // (top < 0). This keeps the bar hidden while the panel is still below the fold
  // on mobile, so it never covers the primary product info.
  var anchor = document.getElementById("pdp-btn-atc");
  if (anchor && "IntersectionObserver" in window) {
    var io = new IntersectionObserver(function(entries) {
      entries.forEach(function(en) {
        var scrolledPast = !en.isIntersecting && en.boundingClientRect.top < 0;
        bar.classList.toggle("show", scrolledPast);
        bar.setAttribute("aria-hidden", scrolledPast ? "false" : "true");
      });
    }, { threshold: 0 });
    io.observe(anchor);
  }
}

// ─── Product page stock state (Upgrade 10) ──────────────────────────────────
// Reads local inventory via OperationsService (defaults to in-stock if absent).
// Shows "Out of Stock" (disables Add to Cart) or a subtle "Low stock" label.
// No fake urgency — labels only appear when real local inventory is set low/out.
function applyProductStockState(p) {
  if (!window.OperationsService) return;
  var rec;
  try { rec = window.OperationsService.getProductStock(p.id); } catch (e) { return; }
  if (!rec) return;

  var atc    = document.getElementById("pdp-btn-atc");
  var badge  = document.querySelector(".product-sticky-panel .product-badge");

  // Clean any prior injected stock note.
  var prev = document.getElementById("pdp-stock-note");
  if (prev) prev.parentNode.removeChild(prev);

  if (rec.stockStatus === "out_of_stock") {
    if (atc) {
      atc.disabled = true;
      atc.textContent = "Out of Stock";
      atc.classList.add("product-btn-oos");
      atc.onclick = function () { return false; };
    }
    if (badge) badge.textContent = "Out of Stock";
    insertStockNote(atc, "This fragrance is currently out of stock. Check back soon or contact us on WhatsApp.");
  } else if (rec.stockStatus === "low_stock") {
    insertStockNote(atc, "Low stock — limited units remaining.");
  } else if (rec.stockStatus === "preorder") {
    if (badge) badge.textContent = "Pre-order";
    insertStockNote(atc, "Available on pre-order. We'll confirm dispatch timing on WhatsApp.");
  }
}
function insertStockNote(anchorBtn, text) {
  if (!anchorBtn || !anchorBtn.parentNode) return;
  var note = document.createElement("p");
  note.id = "pdp-stock-note";
  note.className = "pdp-stock-note";
  note.textContent = text;
  anchorBtn.parentNode.insertBefore(note, anchorBtn.nextSibling);
}

// ─── Product page upsells: "Pairs well with" / "Make it a bundle" (Upgrade 9) ─
function renderProductPairings(p) {
  if (!window.Offers) return;
  var anchor = document.getElementById("other-launches");
  if (!anchor || !anchor.parentNode) return;

  var recs;
  try { recs = window.Offers.getPairingRecommendations(p.id); }
  catch (e) { return; }
  if (!recs || !recs.length) return;

  var existing = document.getElementById("pdp-pairings");
  if (existing) existing.parentNode.removeChild(existing);

  var curr = LAUNCH_CONFIG.currency;
  var cards = recs.map(function (r, ri) {
    var op = r.product;
    var oErr = 'onerror="this.src=\'' + placeholderSrc(op.name) + '\'"';
    var pHoverSrc = getProductHoverThumbnail(op);
    var pHoverImg = pHoverSrc ? '<img class="prod-card-img prod-card-img--hover" src="' + pHoverSrc + '" alt="" loading="lazy" aria-hidden="true" decoding="async">' : '';
    return '<div class="prod-card">' +
      '<a href="' + op.slug + '" class="prod-card-link">' +
        '<img class="prod-card-img" src="' + ((op.thumbnails && op.thumbnails.length) ? op.thumbnails[0] : op.image) + '" alt="NAFUME ' + op.name + ' perfume bottle" loading="lazy" ' + oErr + '>' +
        pHoverImg +
        '<span class="pairing-reason">' + r.reason + '</span>' +
      '</a>' +
      '<div class="prod-card-info">' +
        '<a href="' + op.slug + '" class="prod-card-name">' + op.displayName + '</a>' +
        '<p class="prod-card-family">' + op.family + '</p>' +
        '<div class="prod-card-price">' +
          '<span class="price-sell">' + curr + LAUNCH_CONFIG.sellingPrice.toLocaleString("en-IN") + '</span>' +
          '<span class="price-mrp">MRP ' + curr + LAUNCH_CONFIG.mrp.toLocaleString("en-IN") + '</span>' +
        '</div>' +
        '<div class="pairing-actions">' +
          '<button class="prod-card-atc" onclick="handleUpsellAdd(\'' + op.id + '\',this)">Add to Cart</button>' +
          '<a href="' + op.slug + '" class="pairing-view">View Product</a>' +
        '</div>' +
      '</div>' +
    '</div>';
  }).join("");

  var section = document.createElement("section");
  section.id = "pdp-pairings";
  section.className = "pdp-pairings-section";
  section.innerHTML =
    '<div class="pdp-pairings-wrap">' +
      '<h2 class="pdp-pairings-title">Pairs Well With · Make It a Bundle</h2>' +
      '<p class="pdp-pairings-sub">Build your fragrance wardrobe — add any 3 × 50ml to unlock our bundle offer.</p>' +
      '<div class="other-grid">' + cards + '</div>' +
      '<a href="/pages/collections/collection.html?collection=discovery-set" class="pdp-discovery-cta">Not sure? Try the Discovery Set first →</a>' +
    '</div>';
  anchor.parentNode.insertBefore(section, anchor);
}

// ─── Product SEO (Upgrade 8) ────────────────────────────────────────────────
// Build 3–5 honest FAQs from product data (no over-promised longevity).
function buildProductFaqs(p) {
  var occ = (p.occasions || []).join(" ").toLowerCase();
  var daily = /every|daily|office|casual|gym|travel/.test(occ);
  var evening = /evening|night|date|formal|celebration|special|winter/.test(occ);
  var dayOrEve = daily && evening ? "It is versatile — light enough for daytime and rich enough for evenings."
    : daily ? "It leans towards daytime, office and everyday wear."
    : evening ? "It is best suited to evenings and special occasions."
    : "It works across day and evening depending on how much you apply.";
  var faqs = [
    { q: "Is " + p.name + " suitable for daily use?",
      a: daily ? "Yes. " + p.name + " is easy to wear for daily, office and casual use." :
                 p.name + " is richer and more suited to evenings and special occasions, but you can wear it daily with a lighter application." },
    { q: "Is " + p.name + " better for day or evening?", a: dayOrEve },
    { q: "What kind of scent is " + p.name + "?",
      a: p.name + " is a " + (p.family || "Perfume") + " fragrance. Top notes: " + (p.topNotes || "—") + "; heart: " + (p.heartNotes || "—") + "; base: " + (p.baseNotes || "—") + "." },
    { q: "How strong is " + p.name + "?",
      a: "It is a highly concentrated, long-lasting fragrance — noticeable without being overwhelming. Two to three sprays on pulse points is usually enough; adjust to your preference." }
  ];
  if (p.isGiftable) {
    faqs.push({ q: "Is " + p.name + " good for gifting?",
      a: "Yes. " + p.name + " comes in premium packaging and is a thoughtful gift for birthdays, anniversaries and special occasions." });
  }
  return faqs;
}

// Visible SEO content sections appended to the product page.
function renderProductSeoSections(p) {
  var anchor = document.getElementById("other-launches");
  if (!anchor || !anchor.parentNode) return;

  // Avoid duplicate injection.
  var existing = document.getElementById("pdp-seo");
  if (existing) existing.parentNode.removeChild(existing);

  var bestFor = (p.occasions || []).map(function (o) { return '<span class="acc-tag">' + o + '</span>'; }).join('');
  var moods   = (p.feelings  || []).map(function (f) { return '<span class="acc-tag">' + f + '</span>'; }).join('');
  var giftLine = p.isGiftable
    ? '<li>Comes in premium packaging — a thoughtful gift for birthdays, anniversaries and special occasions.</li>' : '';

  var faqHtml = buildProductFaqs(p).map(function (f) {
    return '<div class="pdp-seo-faq-item">' +
      '<p class="pdp-seo-faq-q">' + f.q + '</p>' +
      '<p class="pdp-seo-faq-a">' + f.a + '</p>' +
    '</div>';
  }).join('');

  var section = document.createElement("section");
  section.id = "pdp-seo";
  section.className = "pdp-seo-section";
  section.innerHTML =
    '<div class="pdp-seo-wrap">' +
      // A. Description depth
      '<div class="pdp-seo-block">' +
        '<h2 class="pdp-seo-title">About ' + p.name + '</h2>' +
        '<p class="pdp-seo-text">' + (p.description || '') + '</p>' +
        '<p class="pdp-seo-text">' + (p.whyLove || '') + '</p>' +
        '<ul class="pdp-seo-list">' +
          '<li>Scent family: <strong>' + (p.family || 'Perfume') + '</strong></li>' +
          '<li>Notes: ' + (p.topNotes || '') + ' · ' + (p.heartNotes || '') + ' · ' + (p.baseNotes || '') + '</li>' +
          '<li>Highly concentrated · 50ml · noticeable without being overwhelming</li>' +
          giftLine +
        '</ul>' +
      '</div>' +
      // C. Best for
      (bestFor || moods ?
      '<div class="pdp-seo-block">' +
        '<h2 class="pdp-seo-title">Best For</h2>' +
        (bestFor ? '<div class="acc-tags">' + bestFor + '</div>' : '') +
        (moods ? '<p class="acc-label-sm" style="margin-top:12px">The Mood</p><div class="acc-tags">' + moods + '</div>' : '') +
      '</div>' : '') +
      // B. How to wear
      '<div class="pdp-seo-block">' +
        '<h2 class="pdp-seo-title">How to Wear</h2>' +
        '<ul class="pdp-seo-list">' +
          '<li>Apply to pulse points — wrists, neck and behind the ears.</li>' +
          '<li>Do not rub your wrists together; it can break down the scent.</li>' +
          '<li>Spray after a shower or over a light moisturiser for longer wear.</li>' +
          '<li>Store away from direct heat and sunlight to protect the fragrance.</li>' +
        '</ul>' +
      '</div>' +
      // D. FAQ
      '<div class="pdp-seo-block">' +
        '<h2 class="pdp-seo-title">Frequently Asked Questions</h2>' +
        faqHtml +
      '</div>' +
      // Internal links
      '<div class="pdp-seo-links">' +
        '<a href="/pages/collections/collection.html?collection=' + (p.primaryCollection || 'best-sellers') + '">More like this</a>' +
        '<a href="/pages/collections/shop.html">Shop all perfumes</a>' +
        (p.isGiftable ? '<a href="/pages/collections/gifting.html">Gifting</a>' : '') +
        '<a href="/pages/collections/collections.html">Explore Collections</a>' +
      '</div>' +
    '</div>';

  anchor.parentNode.insertBefore(section, anchor);
}

// Update metadata + inject JSON-LD for the product page.
function applyProductSeo(p) {
  if (!window.SEO) return;
  try {
    var price = LAUNCH_CONFIG.sellingPrice;
    var productForSeo = {
      id:          p.id,
      name:        p.name,
      displayName: p.displayName,
      family:      p.family,
      description: p.description,
      image:       p.image,
      slug:        p.slug,
      price:       price,
      mrp:         LAUNCH_CONFIG.mrp,
      stockStatus: "in_stock",
      isGiftable:  !!p.isGiftable
    };
    var summary = window.ReviewService ? window.ReviewService.getReviewSummary(p.id) : null;

    window.SEO.updateDocumentSeo(window.SEO.getProductSeo(productForSeo));
    window.SEO.injectJsonLd(window.SEO.createProductSchema(productForSeo, summary), "ld-product");
    window.SEO.injectJsonLd(window.SEO.createBreadcrumbSchema([
      { name: "Home", url: "/" },
      { name: "New Launches", url: "/pages/collections/shop.html" },
      { name: p.name, url: p.slug }
    ]), "ld-breadcrumb");
    var faqSchema = window.SEO.createFAQSchema(buildProductFaqs(p));
    if (faqSchema) window.SEO.injectJsonLd(faqSchema, "ld-faq");
  } catch (e) { /* SEO must never break the PDP */ }
}

// ─── Product reviews (Upgrade 4) ───────────────────────────────────────────
// Compact rating line for product cards: ★★★★★ 4.8 · 126 reviews
function cardRatingHtml(productId) {
  if (!window.ReviewService) return '';
  var s = window.ReviewService.getReviewSummary(productId);
  if (!s.hasReviews || !s.count) {
    return '<p class="prod-card-rating prod-card-rating--none">New launch · No reviews yet</p>';
  }
  return '<p class="prod-card-rating">' +
    '<span class="prod-card-stars">' + starRow(s.average, "rv-stars") + '</span>' +
    '<span class="prod-card-rating-val">' + s.average.toFixed(1) + '</span>' +
    '<span class="prod-card-rating-count">· ' + s.count + (s.count === 1 ? ' review' : ' reviews') + '</span>' +
    '</p>';
}

function starRow(rating, cls) {
  rating = Math.round(rating || 0);
  var s = "";
  for (var i = 1; i <= 5; i++) s += (i <= rating ? "★" : "☆");
  return '<span class="' + (cls || "rv-stars") + '">' + s + "</span>";
}

function reviewCardHtml(r) {
  var when = "";
  try { when = new Date(r.createdAt).toLocaleDateString("en-IN", { year: "numeric", month: "short", day: "numeric" }); }
  catch (e) {}
  var who = r.customerName + (r.customerLocation ? ' · ' + r.customerLocation : '');
  var verified = r.verifiedBuyer
    ? '<span class="rv-verified"><span class="material-symbols-outlined">verified</span>Verified Buyer</span>' : '';
  return '<div class="rv-card">' +
      '<div class="rv-card-head">' +
        '<div>' +
          '<p class="rv-card-name">' + escapeHtml(who) + '</p>' +
          starRow(r.rating) +
        '</div>' + verified +
      '</div>' +
      (r.title ? '<p class="rv-card-title">' + escapeHtml(r.title) + '</p>' : '') +
      '<p class="rv-card-body">' + escapeHtml(r.body) + '</p>' +
      '<p class="rv-card-date">' + when + '</p>' +
    '</div>';
}

function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
    return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c];
  });
}

/* refreshPdpRatingRow(productId)
   Updates the star row at the top of a product page in place once server
   reviews arrive. Re-rendering the whole PDP would reset the gallery and any
   selection the customer had already made, so only this one element changes. */
function refreshPdpRatingRow(productId) {
  if (!window.ReviewService) return;
  var summary = window.ReviewService.getReviewSummary(productId);
  if (!summary || !summary.hasReviews || !summary.count) return;

  var html =
    '<span class="pdp-rating-stars">' + starRow(summary.average, 'rv-stars') + '</span>' +
    '<span class="pdp-rating-num">' + summary.average.toFixed(1) + '</span>' +
    '<span class="pdp-rating-count">' + summary.count +
      (summary.count === 1 ? ' review' : ' reviews') + '</span>';

  var row = document.querySelector(".pdp-rating-row");
  if (row) {
    row.innerHTML = html;
    row.setAttribute("aria-label",
      "Rated " + summary.average + " out of 5 from " + summary.count + " reviews");
    return;
  }

  // No row was rendered because there were no reviews at page load — insert one.
  var eyebrow = document.querySelector(".pdp-eyebrow");
  if (!eyebrow || !eyebrow.parentNode) return;
  row = document.createElement("div");
  row.className = "pdp-rating-row";
  row.setAttribute("aria-label",
    "Rated " + summary.average + " out of 5 from " + summary.count + " reviews");
  row.innerHTML = html;
  eyebrow.parentNode.insertBefore(row, eyebrow.nextSibling);
}

function renderProductReviews(productId) {
  if (!window.ReviewService) return;
  var pdpRoot = document.getElementById("pdp-root");
  if (!pdpRoot) return;

  /* Pull published reviews from the database and re-render when they arrive.
     Rendering is never blocked on the request: the page shows what it already
     has, then improves. hydrateProduct() de-duplicates in-flight calls, so the
     re-render it triggers cannot loop. */
  if (typeof window.ReviewService.hydrateProduct === "function") {
    window.ReviewService.hydrateProduct(productId, function () {
      renderProductReviews(productId);
      refreshPdpRatingRow(productId);
    });
  }

  // Container (insert once, right after the PDP layout)
  var section = document.getElementById("pdp-reviews");
  if (!section) {
    section = document.createElement("section");
    section.id = "pdp-reviews";
    section.className = "pdp-reviews-section";
    pdpRoot.parentNode.insertBefore(section, pdpRoot.nextSibling);
  }

  var summary = window.ReviewService.getReviewSummary(productId);
  var reviews = window.ReviewService.getReviewsByProductId(productId, false);

  var summaryHtml =
    '<div class="rv-summary">' +
      '<div class="rv-summary-score">' +
        '<span class="rv-avg">' + (summary.hasReviews ? summary.average.toFixed(1) : "—") + '</span>' +
        starRow(summary.average, "rv-stars rv-stars-lg") +
        '<span class="rv-count">' + (summary.hasReviews ? summary.count + (summary.count === 1 ? " review" : " reviews") : "No reviews yet") + '</span>' +
      '</div>' +
      '<button class="rv-write-btn" id="rv-write-btn" type="button">Write a Review</button>' +
    '</div>';

  var listHtml = reviews.length
    ? '<div class="rv-list">' + reviews.map(reviewCardHtml).join("") + '</div>'
    : '<div class="rv-empty">No reviews yet. Be the first to review this fragrance.</div>';

  section.innerHTML =
    '<div class="rv-wrap">' +
      '<h2 class="rv-heading">Customer Reviews</h2>' +
      '<p class="rv-subheading">Real feedback from NAFUME buyers.</p>' +
      summaryHtml +
      '<div class="rv-form-wrap" id="rv-form-wrap" style="display:none;"></div>' +
      listHtml +
    '</div>';

  var writeBtn = document.getElementById("rv-write-btn");
  if (writeBtn) writeBtn.addEventListener("click", function () { toggleReviewForm(productId); });
}

function toggleReviewForm(productId) {
  var wrap = document.getElementById("rv-form-wrap");
  if (!wrap) return;
  if (wrap.style.display === "block") { wrap.style.display = "none"; return; }
  wrap.style.display = "block";

  var loggedIn = !!(window.CustomerService && window.CustomerService.isCustomerLoggedIn());
  var elig = window.ReviewService.canCustomerReviewProduct(productId);

  if (loggedIn && elig.alreadyReviewed) {
    wrap.innerHTML = '<p class="rv-form-note">You have already reviewed this product.</p>';
    return;
  }

  wrap.innerHTML =
    '<form class="rv-form" id="rv-form">' +
      '<div class="rv-rating-pick" id="rv-rating-pick" role="radiogroup" aria-label="Your rating">' +
        [1,2,3,4,5].map(function (n) {
          return '<button type="button" class="rv-star-btn" data-val="' + n + '" aria-label="' + n + ' star">☆</button>';
        }).join("") +
      '</div>' +
      '<input type="hidden" id="rv-rating" value="0">' +
      '<input type="text" id="rv-title" class="rv-input" placeholder="Review title (optional)" maxlength="80">' +
      '<textarea id="rv-body" class="rv-input" rows="4" placeholder="Share your experience — longevity, occasion, how it smells…" maxlength="600"></textarea>' +
      (loggedIn ? '' :
        '<input type="text" id="rv-name" class="rv-input" placeholder="Your name *" maxlength="40">' +
        '<input type="text" id="rv-location" class="rv-input" placeholder="City (optional)" maxlength="40">') +
      '<p class="rv-form-msg" id="rv-form-msg"></p>' +
      '<button type="submit" class="rv-submit-btn">Submit Review</button>' +
    '</form>';

  // Star picker
  var picked = 0;
  var stars = wrap.querySelectorAll(".rv-star-btn");
  stars.forEach(function (btn) {
    btn.addEventListener("click", function () {
      picked = parseInt(btn.getAttribute("data-val"), 10);
      document.getElementById("rv-rating").value = picked;
      stars.forEach(function (b) {
        b.textContent = parseInt(b.getAttribute("data-val"), 10) <= picked ? "★" : "☆";
        b.classList.toggle("on", parseInt(b.getAttribute("data-val"), 10) <= picked);
      });
    });
  });

  document.getElementById("rv-form").addEventListener("submit", function (e) {
    e.preventDefault();
    submitReview(productId);
  });
}

function submitReview(productId) {
  var msg = document.getElementById("rv-form-msg");
  function showMsg(t, ok) {
    if (!msg) return;
    msg.textContent = t;
    msg.className = "rv-form-msg " + (ok ? "rv-msg-ok" : "rv-msg-err");
  }
  var nameEl = document.getElementById("rv-name");
  var locEl  = document.getElementById("rv-location");
  var payload = {
    productId: productId,
    rating: parseInt(document.getElementById("rv-rating").value, 10),
    title: document.getElementById("rv-title").value,
    body: document.getElementById("rv-body").value,
    customerName: nameEl ? nameEl.value : "",
    customerLocation: locEl ? locEl.value : ""
  };
  var res = window.ReviewService.addReview(payload);
  if (!res.success) { showMsg(res.message, false); return; }

  // Success — replace the form with a thank-you note.
  var wrap = document.getElementById("rv-form-wrap");
  if (wrap) {
    wrap.innerHTML = '<div class="rv-thankyou">' +
      '<span class="material-symbols-outlined">check_circle</span>' +
      '<p>' + res.message + '</p></div>';
  }
  // Re-render the list (published reviews only; pending ones stay hidden).
  var section = document.getElementById("pdp-reviews");
  if (section) {
    var keepWrap = wrap ? wrap.outerHTML : "";
    renderProductReviews(productId);
    // Restore the thank-you note after re-render.
    var newWrap = document.getElementById("rv-form-wrap");
    if (newWrap && keepWrap) { newWrap.outerHTML = keepWrap; }
  }
}

// ─── Homepage: featured reviews + product-card ratings (Upgrade 4) ─────────
function renderFeaturedHomeReviews() {
  if (!window.ReviewService) return;
  var grid = document.querySelector(".reviews-grid");
  if (!grid) return;   // homepage only
  var featured = window.ReviewService.getFeaturedReviews(4);
  if (!featured.length) return;   // keep the static cards if nothing to show

  grid.innerHTML = featured.map(function (r) {
    var p = LAUNCH_PRODUCTS.find(function (x) { return x.id === r.productId; });
    var thumb = p ? p.image : "";
    var pname = p ? p.displayName : "";
    var who = r.customerName + (r.customerLocation ? ' · ' + r.customerLocation : '');
    return '<div class="review-card">' +
        '<p class="review-name">' + escapeHtml(who) + '</p>' +
        '<p class="review-stars">' + starRow(r.rating, "") + '</p>' +
        (r.title ? '<p class="review-title">' + escapeHtml(r.title) + '</p>' : '') +
        '<p class="review-text">' + escapeHtml(r.body) + '</p>' +
        '<hr class="review-divider">' +
        '<div class="review-product">' +
          (thumb ? '<img class="review-product-thumb" src="' + thumb + '" alt="' + escapeHtml(pname) + '" loading="lazy">' : '') +
          '<span class="review-product-name">' + escapeHtml(pname) + '</span>' +
        '</div>' +
      '</div>';
  }).join("");
}

function enhanceHomeProductCards() {
  var cards = document.querySelectorAll(".home-product-card");
  if (!cards.length) return;   // homepage only
  cards.forEach(function (card, cardIndex) {
    // Derive productId from the Add-to-Cart button's handleGridAdd('id', this)
    var btn = card.querySelector(".home-add-cart-btn");
    var id = null;
    if (btn) {
      var m = (btn.getAttribute("onclick") || "").match(/handleGridAdd\('([^']+)'/);
      if (m) id = m[1];
    }
    if (!id) return;
    var product = LAUNCH_PRODUCTS.find(function (x) { return x.id === id; });

    // (1) Thumbnail variety — swap the static card image by section so the same
    //     product doesn't look identical across HER / HIM / BEST SELLERS / NEW
    //     LAUNCHES. nfPath() keeps it working on file:// and http://. Idempotent.
    var img = card.querySelector(".home-product-image");
    if (product && img && !img.getAttribute("data-thumb-set")) {
      // Skip src swap on cards that already have a hover image set up — those
      // use thumbnails[0] as primary and overwriting would break the swap.
      if (!card.querySelector(".home-product-image--hover")) {
        var sectionEl = card.closest(".home-product-section");
        var ctx = (sectionEl && sectionEl.id) ? sectionEl.id : "home";
        var thumb = getProductThumbnail(product, ctx, cardIndex);
        if (thumb) {
          img.src = nfPath(thumb);
          img.setAttribute("data-thumb-set", "1");
        }
      }
    }

    // (2) Rating row — unchanged; still requires ReviewService.
    if (!window.ReviewService) return;
    if (card.querySelector(".home-product-rating")) return;   // already done
    var fam = card.querySelector(".home-product-family");
    if (!fam) return;
    var html = cardRatingHtml(id);
    if (!html) return;
    var ratingEl = document.createElement("div");
    ratingEl.className = "home-product-rating";
    ratingEl.innerHTML = html;   // contains a <p class="prod-card-rating">…</p>
    fam.parentNode.insertBefore(ratingEl, fam.nextSibling);
  });
}

// ─── Shipping page: selected payment method ────────────────────────
function getShippingPaymentMethod() {
  var checked = document.querySelector('[name="payment"]:checked');
  return checked ? checked.value : "COD";
}

// ─── Shipping page: render order summary from cart (offer-aware, Upgrade 9) ──
function renderOrderSummary() {
  var summaryEl = document.getElementById("order-summary-items");
  var subtotEl  = document.getElementById("order-subtotal");
  var shipEl    = document.getElementById("order-shipping");
  var totalEl   = document.getElementById("order-total");
  var curr      = LAUNCH_CONFIG.currency;

  // Render item rows
  if (summaryEl) {
    if (launchCart.length === 0) {
      summaryEl.innerHTML = '<p class="order-empty-note">No items in cart.</p>';
    } else {
      summaryEl.innerHTML = launchCart.map(function(item) {
        return '<div class="order-item">' +
          '<img class="order-item-img" src="' + item.image + '" alt="' + item.name + '" onerror="this.style.visibility=\'hidden\'">' +
          '<div class="order-item-info">' +
            '<p class="order-item-name">' + item.name + '</p>' +
            '<p class="order-item-meta">Qty: ' + item.qty + '</p>' +
          '</div>' +
          '<span class="order-item-price">' + curr + (item.price * item.qty).toLocaleString("en-IN") + '</span>' +
        '</div>';
      }).join("");
    }
  }

  if (launchCart.length === 0) {
    if (shipEl) shipEl.textContent = "—";
    return;
  }

  // Offer-aware totals (fall back to base math if Offers unavailable).
  var payment = getShippingPaymentMethod();
  var sub = launchSubtotal(), ship = launchShipping(), total = launchTotal();
  var s = null;
  if (window.Offers) {
    try { s = window.Offers.getCartOfferSummary(launchCart, payment); } catch (e) { s = null; }
  }
  if (s) { sub = s.subtotal; ship = s.shipping; total = s.total; }

  // An applied promo code is priced by the SERVER; use the totals it returned
  // rather than recomputing them here, so the page can never show a discount
  // the server would not honour.
  if (nfAppliedPromo && nfAppliedPromo.totals) {
    total = nfAppliedPromo.totals.total;
    ship  = nfAppliedPromo.totals.shipping;
    sub   = nfAppliedPromo.totals.subtotal;
  }
  var freeSh = ship === 0 && sub > 0;

  if (subtotEl) subtotEl.textContent = curr + sub.toLocaleString("en-IN");
  if (shipEl) {
    shipEl.textContent = freeSh ? "FREE" : curr + ship;
    shipEl.classList.toggle("order-free", freeSh);
  }
  if (totalEl) totalEl.textContent = curr + total.toLocaleString("en-IN");

  // Inject offer rows (bundle / prepaid / gift) into the totals block.
  renderCheckoutOfferRows(s);
  renderCheckoutOfferExtras(s);
}

// Insert discount/add-on rows between Shipping and Total without disturbing the
// existing fixed rows.
function renderCheckoutOfferRows(s) {
  var totalsBox = document.querySelector("#order-summary .order-totals");
  if (!totalsBox) return;
  // Remove previously injected offer rows.
  totalsBox.querySelectorAll(".order-row-offer").forEach(function (el) { el.remove(); });

  var curr = LAUNCH_CONFIG.currency;
  var totalRow = totalsBox.querySelector(".order-row-total");

  function addRow(label, amount, isDiscount) {
    var row = document.createElement("div");
    row.className = "order-row order-row-offer";
    var amt = (isDiscount ? "−" : "+") + curr + Math.abs(amount).toLocaleString("en-IN");
    row.innerHTML = '<span class="order-offer-label"></span><span class="' +
      (isDiscount ? "order-free" : "") + '"></span>';
    // textContent, not innerHTML: an offer label can contain a customer-typed
    // promo code, and it must never be parsed as markup.
    row.children[0].textContent = label;
    row.children[1].textContent = amt;
    if (totalRow) totalsBox.insertBefore(row, totalRow);
    else totalsBox.appendChild(row);
  }

  if (s && s.appliedOffers && s.appliedOffers.length) {
    s.appliedOffers.forEach(function (o) { addRow(o.label, o.amount, o.amount < 0); });
  }

  // Server-priced promo code, shown as its own line.
  if (nfAppliedPromo && nfAppliedPromo.discount > 0) {
    addRow("Promo code " + nfAppliedPromo.code, nfAppliedPromo.discount, true);
  }
}

// Free-shipping progress + sample eligibility note above the totals.
function renderCheckoutOfferExtras(s) {
  var host = document.getElementById("order-summary");
  if (!host || !s) return;
  var box = document.getElementById("checkout-offer-extras");
  if (!box) {
    box = document.createElement("div");
    box.id = "checkout-offer-extras";
    box.className = "checkout-offer-extras";
    var totalsBox = host.querySelector(".order-totals");
    if (totalsBox) host.insertBefore(box, totalsBox);
    else host.appendChild(box);
  }
  var curr = LAUNCH_CONFIG.currency;
  var fs = s.freeShippingProgress || {};
  var html = "";
  // Free shipping progress
  if (!fs.unlocked && fs.remaining > 0) {
    html += '<div class="co-progress"><span>Add <strong>' + curr + fs.remaining.toLocaleString("en-IN") +
      '</strong> more to unlock free shipping</span>' +
      '<div class="ship-bar"><div class="ship-fill" style="width:' + (fs.percent || 0) + '%"></div></div></div>';
  } else if (fs.unlocked) {
    html += '<div class="co-progress co-progress-done"><span class="material-symbols-outlined">check_circle</span>' +
      'You have unlocked free shipping.</div>';
  }
  // Try-me sample eligibility (messaging only)
  if (s.tryMeSample && s.tryMeSample.enabled && s.tryMeSample.eligible) {
    html += '<div class="co-sample"><span class="material-symbols-outlined">redeem</span>' +
      'You\'re eligible for a free try-me sample.</div>';
  }
  box.innerHTML = html;
}

// ─── Shipping page: prepaid / gift-packaging / bundle UI (Upgrade 9) ─────────
function initCheckoutOffersUI() {
  // Re-render totals when the payment method changes (prepaid discount).
  document.querySelectorAll('[name="payment"]').forEach(function (radio) {
    radio.addEventListener("change", function () {
      renderOrderSummary();
      renderPrepaidNote();
    });
  });

  // Inject a gift-packaging toggle into the order summary column.
  injectGiftPackagingToggle();
  renderPrepaidNote();
}

function renderPrepaidNote() {
  var note = document.getElementById("prepaid-discount-note");
  var payment = getShippingPaymentMethod();
  var cfg = (window.COMMERCE_CONFIG && window.COMMERCE_CONFIG.offers && window.COMMERCE_CONFIG.offers.prepaidDiscount) || null;
  if (!note) {
    var optionsBox = document.querySelector(".payment-options");
    if (!optionsBox || !cfg || !cfg.enabled) return;
    note = document.createElement("p");
    note.id = "prepaid-discount-note";
    note.className = "prepaid-discount-note";
    optionsBox.parentNode.appendChild(note);
  }
  if (!cfg || !cfg.enabled) { note.style.display = "none"; return; }
  var isPrepaid = /prepaid|upi|bank|online|card/i.test(payment);
  if (isPrepaid) {
    note.className = "prepaid-discount-note prepaid-on";
    note.innerHTML = '<span class="material-symbols-outlined">verified</span> Extra ' + cfg.value +
      '% prepaid discount applied — already included in your total below.';
  } else {
    note.className = "prepaid-discount-note";
    note.innerHTML = '<span class="material-symbols-outlined">savings</span> Pay online to get an extra ' +
      cfg.value + '% off this order.';
  }
  note.style.display = "flex";
}

function injectGiftPackagingToggle() {
  if (!window.Offers) return;
  var gift = window.Offers.getGiftingAddOn();
  if (!gift.enabled) return;
  var host = document.getElementById("order-summary");
  if (!host || document.getElementById("gift-packaging-toggle")) return;

  var curr = LAUNCH_CONFIG.currency;
  var wrap = document.createElement("label");
  wrap.className = "gift-addon-toggle";
  wrap.id = "gift-packaging-toggle";
  wrap.innerHTML =
    '<input type="checkbox" id="gift-packaging-check"' + (gift.applied ? " checked" : "") + '>' +
    '<span class="gift-addon-info">' +
      '<span class="gift-addon-label"><span class="material-symbols-outlined">card_giftcard</span>' + gift.label + '</span>' +
      '<span class="gift-addon-price">+' + curr + gift.price.toLocaleString("en-IN") + '</span>' +
    '</span>';
  var totalsBox = host.querySelector(".order-totals");
  if (totalsBox) host.insertBefore(wrap, totalsBox);
  else host.appendChild(wrap);

  wrap.querySelector("#gift-packaging-check").addEventListener("change", function (e) {
    if (e.target.checked) window.Offers.applyLocalOfferToCart(window.Offers.GIFT_OFFER_ID);
    else window.Offers.removeLocalOfferFromCart(window.Offers.GIFT_OFFER_ID);
    renderOrderSummary();
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
   CHECKOUT  —  real orders, saved on the server
   ───────────────────────────────────────────────────────────────────────────
   The order is created by the BACKEND, not by opening WhatsApp:

     Pay Online →  POST /api/razorpay/create-order   (validates + prices + saves
                                                      a pending order)
                → Razorpay Checkout
                → POST /api/razorpay/verify-payment  (verifies the signature and
                                                      the payment with Razorpay,
                                                      then marks the order paid)

     Cash on Delivery →  POST /api/orders/create-cod (validates + prices + saves
                                                      a confirmed COD order)

   WhatsApp is still offered AFTER the order exists, as a courtesy confirmation
   and for support — it is no longer where an order is created.

   Nothing here is trusted for money: the amount sent is only ever compared
   against the server's own recomputed total, and a mismatch blocks the payment.
   ═══════════════════════════════════════════════════════════════════════════ */

/* ── checkout status + busy states ─────────────────────────────────────────
   Every path through checkout ends in a visible state. A customer must never
   be left looking at a spinner that stopped or a button that does nothing.  */

function checkoutStatusEl() {
  var note = document.getElementById("checkout-status-note");
  if (note) return note;
  var actions = document.querySelector(".form-actions");
  if (!actions) return null;
  note = document.createElement("p");
  note.id = "checkout-status-note";
  note.className = "checkout-status-note";
  note.setAttribute("role", "status");
  note.setAttribute("aria-live", "polite");
  actions.insertBefore(note, actions.firstChild);
  return note;
}

/* kind: "error" | "info" | "success" */
function showCheckoutStatus(message, kind) {
  var note = checkoutStatusEl();
  if (!note) { if (kind === "error") alert(message); return; }
  note.textContent = message;
  note.className = "checkout-status-note is-" + (kind || "info");
  note.style.display = "flex";
  try { note.scrollIntoView({ behavior: "smooth", block: "nearest" }); } catch (e) {}
}
function clearCheckoutStatus() {
  var note = document.getElementById("checkout-status-note");
  if (note) { note.style.display = "none"; note.textContent = ""; }
}

/* setCheckoutBusy — disables the CTA and shows what is happening. Always
   called with false again on every exit path, including failures. */
function setCheckoutBusy(busy, label) {
  var btn = document.getElementById("btn-place-order");
  if (!btn) return;
  if (busy) {
    if (!btn.dataset.idleLabel) btn.dataset.idleLabel = btn.innerHTML;
    btn.disabled = true;
    btn.setAttribute("aria-busy", "true");
    btn.classList.add("is-busy");
    btn.innerHTML = '<span class="btn-spinner" aria-hidden="true"></span>' +
                    (label || "Processing…");
  } else {
    btn.disabled = false;
    btn.removeAttribute("aria-busy");
    btn.classList.remove("is-busy");
    if (btn.dataset.idleLabel) btn.innerHTML = btn.dataset.idleLabel;
  }
}

/* ── field-level validation ────────────────────────────────────────────────
   Mirrors api/_lib/validate.js so the customer is corrected before a round
   trip. The SERVER is still the authority — this is convenience, not security. */

function clearFieldErrors() {
  document.querySelectorAll(".field-error").forEach(function (el) { el.remove(); });
  document.querySelectorAll(".has-error").forEach(function (el) {
    el.classList.remove("has-error");
    el.removeAttribute("aria-invalid");
  });
}

function showFieldErrors(fields) {
  if (!fields) return;
  var first = null;
  Object.keys(fields).forEach(function (name) {
    var input = document.querySelector('#shipping-form [name="' + name + '"]');
    if (!input) return;
    input.classList.add("has-error");
    input.setAttribute("aria-invalid", "true");
    var msg = document.createElement("p");
    msg.className = "field-error";
    msg.textContent = fields[name];
    if (input.parentNode) input.parentNode.appendChild(msg);
    if (!first) first = input;
  });
  if (first) {
    try { first.scrollIntoView({ behavior: "smooth", block: "center" }); } catch (e) {}
    try { first.focus({ preventScroll: true }); } catch (e) {}
  }
}

function nfNormalizePhone(v) {
  var d = String(v || "").replace(/\D/g, "");
  if (d.length > 10) {
    if (d.indexOf("91") === 0 && d.length === 12) d = d.slice(2);
    else if (d.charAt(0) === "0" && d.length === 11) d = d.slice(1);
    else d = d.slice(-10);
  }
  return (d.length === 10 && /^[6-9]/.test(d)) ? d : null;
}

/* collectCheckoutForm() -> { valid, errors, values } */
function collectCheckoutForm() {
  var form = document.getElementById("shipping-form");
  if (!form) return { valid: false, errors: {}, values: null };

  function val(name) {
    var el = form.querySelector('[name="' + name + '"]');
    return el ? String(el.value || "").replace(/\s+/g, " ").trim() : "";
  }

  var values = {
    name:  val("name"),
    phone: val("phone"),
    email: val("email"),
    addr1: val("addr1"),
    addr2: val("addr2"),
    city:  val("city"),
    state: val("state"),
    pin:   val("pin"),
    notes: (function () {
      var el = form.querySelector('[name="notes"]');
      return el ? String(el.value || "").trim() : "";
    })()
  };

  var errors = {};
  if (!values.name || !/[A-Za-zÀ-ɏऀ-ॿ]/.test(values.name)) {
    errors.name = "Please enter your full name.";
  }
  if (!nfNormalizePhone(values.phone)) {
    errors.phone = "Please enter a valid 10-digit Indian mobile number.";
  }
  if (!/^[^\s@]+@[^\s@]+\.[A-Za-z]{2,}$/.test(values.email)) {
    errors.email = "Please enter a valid email address — we send your order confirmation here.";
  }
  if (values.addr1.length < 5) errors.addr1 = "Please enter your full street address.";
  if (values.city.length < 2)  errors.city  = "Please enter your city.";
  if (values.state.length < 2) errors.state = "Please select your state.";
  if (!/^[1-9][0-9]{5}$/.test(values.pin.replace(/\D/g, ""))) {
    errors.pin = "Please enter a valid 6-digit PIN code.";
  }

  return { valid: Object.keys(errors).length === 0, errors: errors, values: values };
}

/* whatsappOptInChecked() — the consent checkbox. Absent checkbox means NO
   consent; consent is never assumed. */
function whatsappOptInChecked() {
  var box = document.getElementById("whatsapp-optin");
  return !!(box && box.checked);
}

/* ── promo code ─────────────────────────────────────────────────────────────
   The applied code is held here and sent with the order. The DISCOUNT AMOUNT
   is never sent — the server recomputes eligibility and rupees from scratch at
   order time. Everything shown here is display only. */

var nfAppliedPromo = null;   // { code, label, discount, totals }

function promoMsg(text, kind) {
  var el = document.getElementById("promo-msg");
  if (!el) return;
  el.textContent = text || "";
  el.className = "promo-msg" + (kind ? " is-" + kind : "");
}

function setPromoBusy(busy) {
  var btn = document.getElementById("promo-apply");
  if (!btn) return;
  btn.disabled = busy;
  btn.textContent = busy ? "Checking…" : (nfAppliedPromo ? "Remove" : "Apply");
}

function renderPromoState() {
  var input = document.getElementById("promo-code");
  var btn   = document.getElementById("promo-apply");
  if (!input || !btn) return;

  if (nfAppliedPromo) {
    input.value = nfAppliedPromo.code;
    input.readOnly = true;
    input.classList.add("is-applied");
    btn.textContent = "Remove";
    promoMsg(nfAppliedPromo.label + " applied — you save " +
             LAUNCH_CONFIG.currency + nfAppliedPromo.discount.toLocaleString("en-IN") + ".", "success");
  } else {
    input.readOnly = false;
    input.classList.remove("is-applied");
    btn.textContent = "Apply";
  }
  renderOrderSummary();
}

function applyPromoCode() {
  var input = document.getElementById("promo-code");
  if (!input) return;

  // Same button removes an applied code.
  if (nfAppliedPromo) {
    nfAppliedPromo = null;
    input.value = "";
    promoMsg("Promo code removed.", "info");
    renderPromoState();
    return;
  }

  var code = (input.value || "").trim();
  if (!code) { promoMsg("Please enter a promo code.", "error"); input.focus(); return; }
  if (launchCart.length === 0) { promoMsg("Add something to your cart first.", "error"); return; }

  // Eligibility depends on who is ordering, so send whatever contact detail the
  // customer has typed. A signed-in session takes priority server-side.
  var form = document.getElementById("shipping-form");
  var emailEl = form && form.querySelector('[name="email"]');
  var phoneEl = form && form.querySelector('[name="phone"]');
  var contact = (emailEl && emailEl.value.trim()) || (phoneEl && phoneEl.value.trim()) || "";

  setPromoBusy(true);
  promoMsg("Checking your code…", "info");

  window.NafumeAPI.post("/api/discounts/validate", {
    code: code,
    items: launchCart.map(function (it) { return { id: it.id, qty: it.qty }; }),
    giftingAddOn: !!(window.Offers && window.Offers.getGiftingAddOn().applied),
    paymentMethod: getShippingPaymentMethod(),
    contact: contact
  }).then(function (res) {
    setPromoBusy(false);

    if (!res.ok) {
      promoMsg(res.message || "We couldn't check that code. Please try again.", "error");
      return;
    }
    if (!res.data.applied) {
      nfAppliedPromo = null;
      promoMsg(res.data.message || "That code isn't valid.", "error");
      renderPromoState();
      return;
    }

    nfAppliedPromo = {
      code:     res.data.code,
      label:    res.data.label,
      discount: res.data.discount,
      totals:   res.data.totals
    };
    renderPromoState();
  });
}

/* Re-checks an applied code after the cart or payment method changes, because
   both change the amount it is worth. Silently drops it if it no longer
   applies, and says so. */
function revalidatePromoCode() {
  if (!nfAppliedPromo) return;
  var code = nfAppliedPromo.code;
  nfAppliedPromo = null;
  var input = document.getElementById("promo-code");
  if (input) { input.readOnly = false; input.value = code; }
  applyPromoCode();
}

/* checkoutPayload(paymentMethod) — the exact body both order endpoints take. */
function checkoutPayload(values, paymentMethod) {
  var total = launchTotal();
  if (window.Offers) {
    try { total = window.Offers.getCartOfferSummary(launchCart, paymentMethod).total; } catch (e) {}
  }
  // An applied promo changes the payable amount, so the amount we send for the
  // server's equality check must be the DISCOUNTED total the customer was
  // shown. Only the CODE travels — never the discount amount.
  if (nfAppliedPromo && nfAppliedPromo.totals &&
      typeof nfAppliedPromo.totals.total === "number") {
    total = nfAppliedPromo.totals.total;
  }

  return {
    items: launchCart.map(function (it) { return { id: it.id, qty: it.qty }; }),
    amount: total,
    discountCode: nfAppliedPromo ? nfAppliedPromo.code : null,
    giftingAddOn: !!(window.Offers && window.Offers.getGiftingAddOn().applied),
    whatsappOptIn: whatsappOptInChecked(),
    notes: values.notes,
    shipping: {
      name:  values.name,  phone: values.phone, email: values.email,
      addr1: values.addr1, addr2: values.addr2,
      city:  values.city,  state: values.state, pin: values.pin
    }
  };
}

/* ── after an order exists ───────────────────────────────────────────────── */

/* onOrderPlaced(order, prefill)
   Runs only once the SERVER has confirmed the order. Caches the order locally
   for offline viewing, remembers the contact detail so the confirmation page
   can authenticate a guest lookup, stores the account prefill, clears the cart,
   and redirects. */
function onOrderPlaced(order, prefill, values) {
  try {
    if (window.NafumeAPI) {
      window.NafumeAPI.rememberCheckoutContact(order.orderId, values.email || values.phone);
      window.NafumeAPI.rememberAccountPrefill(prefill || {
        name: values.name, email: values.email, phone: values.phone, orderId: order.orderId
      });
    }
  } catch (e) {}

  // Local cache so confirmation/track pages still show something if the network
  // drops on the very next page load. The server remains the source of truth.
  try {
    if (window.Commerce && window.NafumeAPI) {
      var local = window.NafumeAPI.toLocalOrder(order);
      var all = window.Commerce.getAllOrders();
      var replaced = false;
      for (var i = 0; i < all.length; i++) {
        if (all[i].orderId === local.orderId) { all[i] = local; replaced = true; break; }
      }
      if (!replaced) all.unshift(local);
      window.Commerce.saveAllOrders(all);
    }
  } catch (e) {}

  try {
    if (window.OperationsService) {
      window.OperationsService.recordAnalyticsEvent("order_created", {
        orderId: order.orderId, total: order.totals ? order.totals.total : 0,
        checkoutType: order.paymentMethod
      });
    }
  } catch (e) {}

  launchCart = []; saveLaunchCart();
  if (window.Offers) {
    try { window.Offers.removeLocalOfferFromCart(window.Offers.GIFT_OFFER_ID); } catch (e) {}
  }

  window.location.href = nfPath("/pages/order/confirmation.html") +
    "?orderId=" + encodeURIComponent(order.orderId);
}

/* ── entry point (form submit) ─────────────────────────────────────────────
   `placeOrder` is bound both as the form's onsubmit and to the primary CTA, so
   Enter-in-a-field and tapping the button behave identically. */

var nfCheckoutInFlight = false;

function placeOrder(event) {
  if (event) event.preventDefault();

  // Guard against double submission at the source, not just visually.
  if (nfCheckoutInFlight) return;

  clearCheckoutStatus();
  clearFieldErrors();

  if (launchCart.length === 0) {
    showCheckoutStatus("Your cart is empty. Please add a fragrance before placing an order.", "error");
    return;
  }

  var collected = collectCheckoutForm();
  if (!collected.valid) {
    showFieldErrors(collected.errors);
    showCheckoutStatus("Please correct the highlighted fields and try again.", "error");
    return;
  }

  var method = getShippingPaymentMethod();
  nfCheckoutInFlight = true;

  if (/whatsapp/i.test(method))      placeWhatsAppOrder(collected.values, method);
  else if (/cod|cash/i.test(method)) placeCodOrder(collected.values, method);
  else                               payWithRazorpay(collected.values, method);
}

/* Kept as an alias so any older markup or bookmark that still calls
   submitShippingForm() places a real order instead of silently doing nothing. */
function submitShippingForm(event) { return placeOrder(event); }

/* ── Cash on Delivery ─────────────────────────────────────────────────────── */

function placeCodOrder(values, method) {
  setCheckoutBusy(true, "Placing your order…");
  showCheckoutStatus("Placing your order…", "info");

  window.NafumeAPI.post("/api/orders/create-cod", checkoutPayload(values, method))
    .then(function (res) {
      nfCheckoutInFlight = false;
      setCheckoutBusy(false);

      if (!res.ok) {
        if (res.fields) showFieldErrors(res.fields);
        showCheckoutStatus(res.message || "We couldn't place your order. Please try again.", "error");
        return;
      }
      showCheckoutStatus("Order confirmed. Taking you to your order details…", "success");
      onOrderPlaced(res.data.order, res.data.accountPrefill, values);
    });
}

/* ── Order on WhatsApp ────────────────────────────────────────────────────
   The order is saved on the server first (awaiting WhatsApp confirmation), so
   it exists even if the customer never taps Send. The confirmation page then
   offers the WhatsApp button, pre-filled with the saved order's details.     */

function placeWhatsAppOrder(values, method) {
  setCheckoutBusy(true, "Saving your order…");
  showCheckoutStatus("Saving your order…", "info");

  window.NafumeAPI.post("/api/orders/create-whatsapp", checkoutPayload(values, method))
    .then(function (res) {
      nfCheckoutInFlight = false;
      setCheckoutBusy(false);

      if (!res.ok) {
        if (res.fields) showFieldErrors(res.fields);
        showCheckoutStatus(res.message || "We couldn't save your order. Please try again.", "error");
        return;
      }
      try {
        if (res.data.whatsapp && res.data.whatsapp.url) {
          sessionStorage.setItem("nafume_wa_" + res.data.order.orderId, res.data.whatsapp.url);
        }
      } catch (e) {}
      showCheckoutStatus("Order saved. Taking you to WhatsApp confirmation…", "success");
      onOrderPlaced(res.data.order, res.data.accountPrefill, values);
    });
}

/* ── legacy WhatsApp message builder ───────────────────────────────────────
   Still used to compose the COURTESY confirmation a customer can send after a
   real order exists (confirmation page). It no longer creates orders.       */
function buildWhatsAppOrderText(order) {
  if (!order) return "";
  var c = order.customer || {};
  var t = order.totals || {};
  var curr = LAUNCH_CONFIG.currency;
  var address = (c.address || "") + ", " + (c.city || "") + " " + (c.state || "") +
    (c.pincode ? " - " + c.pincode : "");
  var itemLines = (order.items || []).map(function (it, i) {
    var qty = it.quantity || it.qty || 1;
    return (i + 1) + ". " + it.name + " x " + qty + " = " + curr + ((it.price || 0) * qty).toLocaleString("en-IN");
  }).join("\n");

  return "NAFUME Order " + order.orderId + "\n\n" +
    "Name: " + (c.name || "—") + "\n" +
    "Phone: " + (c.phone || "—") + "\n" +
    "Email: " + (c.email || "—") + "\n\n" +
    "Address:\n" + address + "\n\n" +
    "Items:\n" + itemLines + "\n\n" +
    "Total: " + curr + (t.total || 0).toLocaleString("en-IN") + "\n" +
    "Payment: " + (order.paymentStatus === "paid" ? "PAID online" : (order.paymentMethod === "whatsapp" ? "To be arranged on WhatsApp" : "Cash on Delivery")) + "\n\n" +
    "Please confirm dispatch. Thank you!";
}
window.buildWhatsAppOrderText = buildWhatsAppOrderText;

// ─── Instagram carousel (global — referenced by rendered footer onclick) ──
window.igCarouselMove = function(dir) {
  var strip = document.getElementById('gf-ig-strip');
  if (!strip) return;
  var item = strip.querySelector('.instagram-item');
  if (!item) return;
  strip.scrollBy({ left: dir * (item.offsetWidth + 4), behavior: 'smooth' });
};

// ─── Instagram feed helpers ────────────────────────────────────────────────
var IG_PROFILE_URL = 'https://www.instagram.com/nafume.official?igsh=djk0OHY0dnlmeXJ5';

// Fallback static images — shown immediately and kept if live API unavailable
var IG_FALLBACK = [
  { src: '/assets/images/products/seduction/01.jpg',      link: IG_PROFILE_URL, alt: 'Seduction by NAFUME',      type: 'IMAGE' },
  { src: '/assets/images/products/dark-oud/01.jpg',       link: IG_PROFILE_URL, alt: 'Dark Oud by NAFUME',       type: 'IMAGE' },
  { src: '/assets/images/products/red-spirit/01.jpg',     link: IG_PROFILE_URL, alt: 'Red Spirit by NAFUME',     type: 'IMAGE' },
  { src: '/assets/images/products/aqua-manthan/01.jpg',   link: IG_PROFILE_URL, alt: 'Aqua Manthan by NAFUME',   type: 'IMAGE' },
  { src: '/assets/images/products/all-day-misfit/01.jpg', link: IG_PROFILE_URL, alt: 'All Day Misfit by NAFUME', type: 'IMAGE' }
];

function igEscAttr(str) {
  return String(str).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function buildIgItem(src, link, alt, type) {
  var safeAlt  = igEscAttr(alt);
  var safeLink = igEscAttr(link);
  var videoBadge = (type === 'VIDEO')
    ? '<span class="ig-video-badge" aria-hidden="true"><svg viewBox="0 0 24 24" width="20" height="20" fill="#fff" xmlns="http://www.w3.org/2000/svg"><polygon points="5,3 19,12 5,21"/></svg></span>'
    : '';
  return '<a href="' + safeLink + '" target="_blank" rel="noopener noreferrer" class="instagram-item" aria-label="' + safeAlt + '">' +
         '<img src="' + igEscAttr(src) + '" alt="' + safeAlt + '" loading="lazy" onerror="this.closest(\'a\').style.display=\'none\'">' +
         videoBadge +
         '</a>';
}

function renderIgStrip(posts) {
  var strip = document.getElementById('gf-ig-strip');
  if (!strip) return;
  strip.innerHTML = posts.map(function(p) {
    return buildIgItem(p.src, p.link, p.alt, p.type);
  }).join('');
}

function fetchInstagramFeed() {
  if (typeof fetch === 'undefined') return;
  try {
    var ctrl    = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    var timer   = ctrl ? setTimeout(function() { ctrl.abort(); }, 6000) : null;
    var options = ctrl ? { cache: 'default', signal: ctrl.signal } : { cache: 'default' };
    fetch('/api/instagram/feed', options)
      .then(function(r) {
        if (timer) clearTimeout(timer);
        return r.ok ? r.json() : null;
      })
      .then(function(data) {
        if (!data || !Array.isArray(data.posts) || data.posts.length === 0) return;
        var posts = data.posts
          .filter(function(p) { return p && p.media_url; })
          .map(function(p) {
            return {
              src:  p.media_url,
              link: p.permalink || IG_PROFILE_URL,
              alt:  p.caption   ? p.caption.slice(0, 80) : 'NAFUME on Instagram',
              type: p.media_type || 'IMAGE'
            };
          });
        if (posts.length) renderIgStrip(posts);
      })
      .catch(function() { /* network error or timeout — fallback stays */ });
  } catch (e) { /* fetchInstagramFeed must never throw */ }
}

// ─── Global Footer Renderer ───────────────────────────────────────────────
function renderGlobalFooter() {
  var container = document.getElementById('global-footer');
  if (!container) return;

  // Render fallback immediately (no layout shift)
  var igItems = IG_FALLBACK.map(function(f) {
    return buildIgItem(f.src, f.link, f.alt, f.type);
  }).join('');

  function buildLogos(hidden) {
    var items = [
      ['WhatsApp Order Confirmation', 'chat'],
      ['Free Shipping Above ₹999', 'local_shipping'],
      ['Summer Sale ₹799', 'sell'],
      ['Secure Order Details', 'lock'],
      ['Premium Long-Lasting Perfume', 'water_drop'],
      ['Made for Indian Weather', 'wb_sunny'],
      ['Fast Dispatch Support', 'rocket_launch'],
      ['Instagram Updates', 'photo_camera']
    ];
    var aria = hidden ? ' aria-hidden="true"' : '';
    return items.map(function(item) {
      return '<span class="trust-item-pill"' + aria + '>' +
        '<span class="material-symbols-outlined trust-pill-icon">' + item[1] + '</span>' +
        '<span class="trust-pill-label">' + item[0] + '</span>' +
        '</span>';
    }).join('');
  }

  container.innerHTML = [
    '<section class="instagram-section">',
    '  <h2 class="instagram-title">Our Instagram</h2>',
    '  <div class="instagram-strip-wrap">',
    '    <button class="instagram-arrow left" onclick="igCarouselMove(-1)" aria-label="Previous">',
    '      <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><polyline points="15 18 9 12 15 6"/></svg>',
    '    </button>',
    '    <div class="instagram-strip" id="gf-ig-strip">',
    igItems,
    '    </div>',
    '    <button class="instagram-arrow right" onclick="igCarouselMove(1)" aria-label="Next">',
    '      <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><polyline points="9 18 15 12 9 6"/></svg>',
    '    </button>',
    '  </div>',
    '</section>',
    '<section class="retail-marquee-section" aria-label="Our service promise">',
    '  <div class="retail-marquee">',
    '    <div class="retail-marquee-track">',
    buildLogos(false),
    buildLogos(true),
    '    </div>',
    '  </div>',
    '</section>',
    '<div class="read-more-bar" id="gf-read-more-bar" role="button" aria-expanded="false" tabindex="0">',
    '  <span class="read-more-bar-label">Read More</span>',
    '  <span class="read-more-bar-icon">',
    '    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="20" height="20" xmlns="http://www.w3.org/2000/svg"><polyline points="6 9 12 15 18 9"/></svg>',
    '  </span>',
    '</div>',
    '<div class="read-more-content" id="gf-read-more-content">',
    '  <div class="read-more-inner">',
    '    <h2 class="read-more-heading">Luxury Perfume Brand for Long Lasting Fragrance</h2>',
    '    <h3 class="read-more-subheading">NAFUME Luxury Perfumes Crafted for Indian Conditions</h3>',
    '    <p>NAFUME is a premium perfume brand in India created for people who expect performance, quality, and refinement. When you buy perfume online in India, you are not just choosing a scent, you are choosing how you present yourself every day.</p>',
    '    <p>Our fragrances are designed with smooth blends, memorable notes, and long-lasting character suited for Indian weather. Whether you prefer fresh, bold, woody, aquatic, fruity, or elegant scents, NAFUME offers premium long-lasting fragrances for everyday confidence, gifting, and special occasions.</p>',
    '    <h3 class="read-more-subheading">Why NAFUME is a Smart Place to Buy Perfumes Online in India</h3>',
    '    <ul class="read-more-list">',
    '      <li><strong>Long Lasting Performance That Works in Real Conditions</strong><br>NAFUME perfumes are created to offer a strong, lasting scent experience that feels smooth from the first spray to the final dry-down.</li>',
    '      <li><strong>Designed for Indian Weather</strong><br>Heat and humidity can reduce fragrance performance. NAFUME perfumes are designed with Indian conditions in mind, helping the scent feel present, balanced, and wearable.</li>',
    '      <li><strong>Premium Notes and Smooth Blends</strong><br>Each fragrance is built around carefully selected notes, giving every perfume its own personality — from seductive fruity musk to bold oud, fresh aquatic energy, and modern spicy woods.</li>',
    '      <li><strong>Luxury Feel at Practical Pricing</strong><br>NAFUME makes premium perfume more accessible through thoughtful pricing, seasonal offers, and direct WhatsApp ordering.</li>',
    '      <li><strong>Simple WhatsApp Order Experience</strong><br>Choose your fragrance, add it to cart, fill shipping details, and confirm your order directly on WhatsApp.</li>',
    '    </ul>',
    '    <h3 class="read-more-subheading">Explore Perfumes by Fragrance Family</h3>',
    '    <ul class="read-more-list">',
    '      <li><strong>Fresh and Aquatic Perfumes</strong><br>Clean, cooling, and energetic fragrances ideal for daily wear, office use, summer days, and travel.</li>',
    '      <li><strong>Woody and Oud Fragrances</strong><br>Deep, rich, and powerful scents designed for evenings, weddings, formal events, and statement moments.</li>',
    '      <li><strong>Fruity and Musky Perfumes</strong><br>Sweet, smooth, and confident fragrances that feel playful, attractive, and memorable.</li>',
    '      <li><strong>Spicy and Modern Masculine Fragrances</strong><br>Bold and energetic blends made for daily wear, parties, night outs, and all-season confidence.</li>',
    '      <li><strong>Unisex-Style Everyday Perfumes</strong><br>Versatile scent profiles that can suit different moods, personalities, and occasions.</li>',
    '    </ul>',
    '    <h3 class="read-more-subheading">What Makes NAFUME Different</h3>',
    '    <p>NAFUME is built on a simple idea: fragrance should feel premium, perform well, and be easy to choose.</p>',
    '    <p>Our perfumes are designed to:</p>',
    '    <ul class="read-more-list">',
    '      <li>Deliver a lasting fragrance experience</li>',
    '      <li>Feel smooth and wearable in Indian weather</li>',
    '      <li>Offer premium scent profiles at practical pricing</li>',
    '      <li>Help customers choose easily through clear notes and descriptions</li>',
    '      <li>Make ordering simple through WhatsApp confirmation</li>',
    '    </ul>',
    '    <h3 class="read-more-subheading">Buy Luxury Perfumes Online in India with Confidence</h3>',
    '    <p>NAFUME simplifies the process of buying perfume online in India by giving clear fragrance descriptions, transparent pricing, and direct order confirmation on WhatsApp.</p>',
    '    <p>When you choose NAFUME, you choose a fragrance brand focused on real everyday use — long-lasting scent, memorable presence, and premium feel without unnecessary complexity.</p>',
    '  </div>',
    '</div>',
    '<footer class="site-footer">',
    '  <div class="footer-grid">',
    /* Column 1 — Brand + Fragrances */
    '    <div class="footer-column">',
    '      <h5 class="footer-title">NAFUME</h5>',
    '      <p class="footer-subscribe-text" style="margin-bottom:16px">Premium fragrances crafted for everyday luxury.</p>',
    '      <a href="/pages/support/contact.html" class="footer-link">Contact Us</a>',
    '      <a href="mailto:nafume.official@gmail.com" class="footer-link">nafume.official@gmail.com</a>',
    '      <a href="/pages/brand/about.html" class="footer-link">About NAFUME</a>',
    '      <h5 class="footer-title" style="margin-top:24px;">Fragrances</h5>',
    '      <a href="/pages/products/seduction.html" class="footer-link">Seduction</a>',
    '      <a href="/pages/products/dark-oud.html" class="footer-link">Dark Oud</a>',
    '      <a href="/pages/products/red-spirit.html" class="footer-link">Red Spirit</a>',
    '      <a href="/pages/products/aqua-manthan.html" class="footer-link">Aqua Manthan</a>',
    '      <a href="/pages/products/all-day-misfit.html" class="footer-link">All Day</a>',
    '    </div>',
    /* Column 2 — Shop by collection */
    '    <div class="footer-column">',
    '      <h5 class="footer-title">Shop</h5>',
    '      <a href="/pages/collections/shop.html" class="footer-link">Shop All Perfumes</a>',
    '      <a href="/pages/collections/perfumes-for-men.html" class="footer-link">Perfumes for Men</a>',
    '      <a href="/pages/collections/perfumes-for-women.html" class="footer-link">Perfumes for Women</a>',
    '      <a href="/pages/collections/unisex-perfumes.html" class="footer-link">Unisex Perfumes</a>',
    '      <a href="/pages/collections/office-everyday-perfumes.html" class="footer-link">Office &amp; Everyday</a>',
    '      <a href="/pages/collections/date-night-perfumes.html" class="footer-link">Date Night Perfumes</a>',
    '      <a href="/pages/collections/fresh-aquatic-perfumes.html" class="footer-link">Fresh &amp; Aquatic</a>',
    '      <a href="/pages/collections/oud-intense-perfumes.html" class="footer-link">Oud &amp; Intense</a>',
    '      <a href="/pages/collections/gifting.html" class="footer-link">Perfume Gifts</a>',
    '      <a href="/pages/collections/build-your-own-box.html" class="footer-link">Build Your Own Box</a>',
    '    </div>',
    /* Column 3 — Fragrance Guides */
    '    <div class="footer-column">',
    '      <h5 class="footer-title">Fragrance Guides</h5>',
    '      <a href="/pages/guides/index.html" class="footer-link">All Guides</a>',
    '      <a href="/pages/guides/perfume-for-indian-weather.html" class="footer-link">Perfume for Indian Weather</a>',
    '      <a href="/pages/guides/best-perfume-for-office.html" class="footer-link">Office Perfume Guide</a>',
    '      <a href="/pages/guides/fresh-perfume-for-summer.html" class="footer-link">Fresh Summer Perfumes</a>',
    '      <a href="/pages/guides/date-night-perfume-guide.html" class="footer-link">Date Night Perfume Guide</a>',
    '      <a href="/pages/guides/oud-perfume-guide.html" class="footer-link">Oud Perfume Guide</a>',
    '      <a href="/pages/guides/how-to-choose-perfume.html" class="footer-link">How to Choose a Perfume</a>',
    '      <a href="/pages/guides/perfume-gifting-guide.html" class="footer-link">Perfume Gifting Guide</a>',
    '    </div>',
    /* Column 4 — Subscribe + Orders */
    '    <div class="footer-column">',
    '      <h5 class="footer-title">Subscribe</h5>',
    '      <p class="footer-subscribe-text">Be the first to know about new launches and offers.</p>',
    '      <form class="subscribe-form" id="gf-subscribe-form">',
    '        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" xmlns="http://www.w3.org/2000/svg"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="M2 7l10 7 10-7"/></svg>',
    '        <input class="subscribe-input" type="email" placeholder="Enter your email" required aria-label="Email address">',
    '        <button class="subscribe-submit" type="submit" aria-label="Subscribe">',
    '          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18" xmlns="http://www.w3.org/2000/svg"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>',
    '        </button>',
    '      </form>',
    '      <div class="subscribe-success" id="gf-subscribe-success">Thank you for subscribing.</div>',
    '      <div class="footer-socials">',
    '        <a href="https://www.facebook.com/profile.php?id=61590903942862" target="_blank" rel="noopener" class="footer-social-btn" aria-label="Facebook">',
    '          <svg viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M18 2h-3a5 5 0 00-5 5v3H7v4h3v8h4v-8h3l1-4h-4V7a1 1 0 011-1h3z"/></svg>',
    '        </a>',
    '        <a href="' + IG_PROFILE_URL + '" target="_blank" rel="noopener" class="footer-social-btn" aria-label="Instagram">',
    '          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" xmlns="http://www.w3.org/2000/svg"><rect x="2" y="2" width="20" height="20" rx="5" ry="5"/><path d="M16 11.37A4 4 0 1112.63 8 4 4 0 0116 11.37z"/><line x1="17.5" y1="6.5" x2="17.51" y2="6.5"/></svg>',
    '        </a>',
    '      </div>',
    '      <h5 class="footer-title" style="margin-top:24px;">Orders &amp; Support</h5>',
    '      <a href="/pages/legal/shipping-policy.html" class="footer-link">Shipping Policy</a>',
    '      <a href="/pages/legal/return-refund-policy.html" class="footer-link">Return &amp; Refund Policy</a>',
    '      <a href="/pages/order/track-order.html" class="footer-link">Track My Order</a>',
    '      <a href="/pages/support/contact.html" class="footer-link">Contact Support</a>',
    '      <a href="/pages/support/faq.html" class="footer-link">FAQs</a>',
    '    </div>',
    '  </div>',
    '  <div class="footer-bottom">',
    '    <p class="footer-copy">&copy; 2026 NAFUME Artisan Luxe. All rights reserved. &nbsp;|&nbsp;',
    '      <a href="/pages/legal/privacy-policy.html" style="color:inherit;opacity:0.7;text-decoration:underline">Privacy</a> &nbsp;',
    '      <a href="/pages/legal/terms-conditions.html" style="color:inherit;opacity:0.7;text-decoration:underline">Terms</a> &nbsp;',
    '      <a href="/pages/legal/return-refund-policy.html" style="color:inherit;opacity:0.7;text-decoration:underline">Returns</a>',
    '    </p>',
    '  </div>',
    '</footer>'
  ].join('\n');

  var bar = document.getElementById('gf-read-more-bar');
  var content = document.getElementById('gf-read-more-content');
  if (bar && content) {
    bar.addEventListener('click', function() {
      var isOpen = bar.classList.toggle('open');
      content.classList.toggle('open', isOpen);
      bar.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
      content.style.maxHeight = isOpen ? content.scrollHeight + 'px' : '0';
    });
  }

  var form = document.getElementById('gf-subscribe-form');
  if (form) {
    form.addEventListener('submit', function(e) {
      e.preventDefault();
      var success = document.getElementById('gf-subscribe-success');
      if (success) { success.style.display = 'block'; form.reset(); }
    });
  }

  // Async: swap fallback images with live Instagram posts (no-op if API unavailable)
  fetchInstagramFeed();
}

// ─── Collection nav injection (Upgrade 6) ─────────────────────────
function injectCollectionNav() {
  var collectionLinks = [
    { href: '/pages/collections/collections.html', label: 'COLLECTIONS' },
    { href: '/pages/collections/gifting.html',     label: 'GIFTING' }
  ];
  // Desktop nav row
  var navRow = document.querySelector('.nf-nav-row');
  if (navRow && !navRow.querySelector('[data-collection-nav]')) {
    collectionLinks.forEach(function(link) {
      var a = document.createElement('a');
      a.href = link.href;
      a.className = 'nf-nav-link';
      a.setAttribute('data-collection-nav', '1');
      a.textContent = link.label;
      navRow.appendChild(a);
    });
  }
  // Mobile drawer nav
  var drawerNav = document.querySelector('.nf-drawer-nav');
  if (drawerNav && !drawerNav.querySelector('[data-collection-nav]')) {
    collectionLinks.forEach(function(link) {
      var a = document.createElement('a');
      a.href = link.href;
      a.className = 'nf-drawer-link';
      a.setAttribute('data-collection-nav', '1');
      a.textContent = link.label;
      drawerNav.appendChild(a);
    });
  }
}

// ─── Init ─────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", function() {
  launchCart = loadLaunchCart();
  renderCartUI();

  // Reviews (Upgrade 4): seed starter reviews once, before anything renders.
  if (window.ReviewService) window.ReviewService.seedInitialReviewsIfEmpty();

  // Collection nav injection (Upgrade 6)
  injectCollectionNav();

  // Product page init
  if (window.PRODUCT_PAGE_ID) {
    initProductPage(window.PRODUCT_PAGE_ID);
  }

  // Launch grid init
  if (document.getElementById("launch-grid")) {
    renderLaunchGrid("launch-grid", LAUNCH_PRODUCTS);
  }

  // Collection/category page grids — any .launch-grid with data-products attr
  document.querySelectorAll('.launch-grid[data-products]').forEach(function(el) {
    var ids = el.getAttribute('data-products').split(',').map(function(s){ return s.trim(); });
    var prods = LAUNCH_PRODUCTS.filter(function(p){ return ids.indexOf(p.id) !== -1; });
    prods.sort(function(a, b){ return ids.indexOf(a.id) - ids.indexOf(b.id); });
    if (prods.length && el.id) renderLaunchGrid(el.id, prods, 'collection');
  });

  // Homepage reviews (Upgrade 4): featured testimonials + product-card ratings.
  renderFeaturedHomeReviews();
  enhanceHomeProductCards();

  // Shipping page init
  if (document.getElementById("shipping-form")) {
    renderOrderSummary();
    if (launchCart.length === 0) {
      var shippingForm = document.getElementById("shipping-form");
      shippingForm.style.display = "none";
      var shHeading = document.querySelector(".shipping-heading");
      var shSubhead = document.querySelector(".shipping-subhead");
      if (shHeading) shHeading.style.display = "none";
      if (shSubhead) shSubhead.style.display = "none";
      var emptyMsg = document.createElement("div");
      emptyMsg.className = "shipping-empty-state";
      emptyMsg.innerHTML =
        '<span class="material-symbols-outlined">shopping_bag</span>' +
        '<p class="shipping-empty-heading">Your cart is empty</p>' +
        '<p class="shipping-empty-sub">Please add a fragrance before entering shipping details.</p>' +
        '<a href="/#new-launches" class="shipping-empty-cta">Return to New Launches →</a>';
      shippingForm.parentNode.insertBefore(emptyMsg, shippingForm);
    } else {
      document.getElementById("shipping-form").addEventListener("submit", placeOrder);
      initCheckoutUI();          // payment-method CTA, inline validation
      initCheckoutAccountUI();   // prefill from the signed-in account
      initCheckoutOffersUI();    // prepaid / gift / bundle / sample
      // Analytics (Upgrade 10): reached checkout with items.
      if (window.OperationsService) {
        try { window.OperationsService.recordAnalyticsEvent("begin_checkout", { itemCount: launchCount() }); } catch (e) {}
      }
    }
  }

  renderGlobalFooter();
});

/* ─── Razorpay online payment ───────────────────────────────────────────────
   The full flow, with the security-critical parts on the server:

     1. POST /api/razorpay/create-order
          The server validates the shipping details, RE-PRICES the cart from its
          own catalogue, rejects any mismatch with what the browser thinks the
          total is, creates the Razorpay order, and saves a PENDING order plus
          the customer and their WhatsApp consent.
     2. Razorpay Checkout opens with the publishable key_id the server returned.
        No secret ever exists in this file or any other frontend file.
     3. POST /api/razorpay/verify-payment
          The server checks the HMAC signature, re-fetches the payment from
          Razorpay to confirm it was really captured for the right amount, and
          only then marks the order paid. The browser's "payment succeeded"
          callback is never treated as proof on its own.

   Every failure path restores the button, shows a specific message, and leaves
   the cart untouched so the customer can simply try again.                   */

/* ensureRazorpaySdk() -> Promise<boolean>
   Loads Razorpay's checkout.js ON DEMAND rather than with a blocking <script>
   tag on the checkout page.

   Why: a classic <script src="https://checkout.razorpay.com/…"> executes in
   order and blocks every script after it. When Razorpay's CDN is slow or
   unreachable, that left the whole checkout page inert — no validation, no
   button handler, and the form falling back to a native GET submit. Fetching it
   only when someone actually chooses to pay means a third-party outage can
   never break the page, and COD keeps working regardless.

   Resolves false (never rejects) if the SDK cannot be loaded, so the caller can
   show a proper message. */
var nfRazorpaySdkPromise = null;

function ensureRazorpaySdk() {
  if (typeof window.Razorpay !== "undefined") return Promise.resolve(true);
  if (nfRazorpaySdkPromise) return nfRazorpaySdkPromise;

  nfRazorpaySdkPromise = new Promise(function (resolve) {
    var script = document.createElement("script");
    script.src = "https://checkout.razorpay.com/v1/checkout.js";
    script.async = true;

    var settled = false;
    function finish(okState) {
      if (settled) return;
      settled = true;
      // Allow a retry on a later attempt rather than caching the failure.
      if (!okState) nfRazorpaySdkPromise = null;
      resolve(okState);
    }

    var timer = setTimeout(function () { finish(false); }, 12000);
    script.onload  = function () { clearTimeout(timer); finish(typeof window.Razorpay !== "undefined"); };
    script.onerror = function () { clearTimeout(timer); finish(false); };

    document.head.appendChild(script);
  });

  return nfRazorpaySdkPromise;
}

function payWithRazorpay(values, method) {
  setCheckoutBusy(true, "Starting secure payment…");
  showCheckoutStatus("Starting secure payment…", "info");

  try {
    if (window.OperationsService) {
      window.OperationsService.recordAnalyticsEvent("razorpay_checkout_started", {});
    }
  } catch (e) {}

  ensureRazorpaySdk().then(function (sdkReady) {
    if (!sdkReady) {
      nfCheckoutInFlight = false;
      setCheckoutBusy(false);
      showCheckoutStatus(
        "We couldn't load the secure payment window. Please check your connection and try again, " +
        "or choose Cash on Delivery.", "error");
      return;
    }
    startRazorpayOrder(values, method);
  });
}

function startRazorpayOrder(values, method) {
  window.NafumeAPI.post("/api/razorpay/create-order", checkoutPayload(values, method))
    .then(function (res) {
      if (!res.ok) {
        nfCheckoutInFlight = false;
        setCheckoutBusy(false);
        if (res.fields) showFieldErrors(res.fields);
        showCheckoutStatus(
          res.message || "We couldn't start the payment. Please try again in a moment.", "error");
        return;
      }

      var data = res.data;
      var cfg  = (window.COMMERCE_CONFIG && window.COMMERCE_CONFIG.razorpay) || {};

      // The order now exists server-side as `pending`. Remember how to find it
      // BEFORE opening the payment sheet, so a customer who pays and then loses
      // the browser can still be reconciled from the confirmation page.
      try {
        window.NafumeAPI.rememberCheckoutContact(data.nafume_order_id, values.email);
      } catch (e) {}

      setCheckoutBusy(true, "Waiting for payment…");
      showCheckoutStatus("Complete your payment in the secure window.", "info");

      var rzp = new window.Razorpay({
        key:         data.key_id,
        amount:      data.amount,
        currency:    data.currency,
        order_id:    data.order_id,
        name:        "NAFUME Artisan Luxe",
        description: "Order " + data.nafume_order_id,
        image:       "/assets/logo/logo-mark.png",
        prefill:     { name: values.name, email: values.email, contact: values.phone },
        theme:       { color: cfg.themeColor || "#C5A059" },
        notes:       { nafumeOrderId: data.nafume_order_id },
        retry:       { enabled: false },   // we handle retries ourselves, so a
                                           // retry can't bypass our verification
        handler: function (response) {
          verifyRazorpayPayment(response, data.nafume_order_id, values);
        },
        modal: {
          ondismiss: function () {
            nfCheckoutInFlight = false;
            setCheckoutBusy(false);
            showCheckoutStatus(
              "Payment was cancelled. Your cart and details are still here — you can try again or choose Cash on Delivery.",
              "error");
          }
        }
      });

      rzp.on("payment.failed", function (resp) {
        nfCheckoutInFlight = false;
        setCheckoutBusy(false);
        var reason = (resp && resp.error && resp.error.description)
          ? resp.error.description
          : "Your payment did not go through.";
        showCheckoutStatus(reason + " Nothing has been charged. Please try again or choose Cash on Delivery.", "error");
        try {
          if (window.OperationsService) {
            window.OperationsService.recordAnalyticsEvent("razorpay_payment_failed",
              { orderId: data.nafume_order_id });
          }
        } catch (e) {}
      });

      rzp.open();
    });
}

/* verifyRazorpayPayment — the server decides whether the order is paid; the
   browser's "payment succeeded" callback is never proof on its own.

   Three outcomes:
     paid                   → confirmation page
     awaiting_verification  → Razorpay has not confirmed CAPTURE yet (or could
                              not be reached). The order is saved and will
                              update by itself; the customer must not pay
                              again. We clear the cart and show the order.
     refused                → signature/amount/order mismatch or a failed
                              payment. Nothing was marked paid.

   Safe to call more than once for the same payment: the server's paid
   transition is a single conditional update shared with the webhook. */
var NF_AWAITING_PAYMENT_MESSAGE =
  "We're confirming your payment. Please don't pay again. Your order status will update once confirmation arrives.";

function verifyRazorpayPayment(response, nafumeOrderId, values, attempt) {
  attempt = attempt || 1;

  setCheckoutBusy(true, "Confirming your payment…");
  showCheckoutStatus("Payment received — confirming your order…", "info");

  window.NafumeAPI.post("/api/razorpay/verify-payment", {
    razorpay_order_id:   response.razorpay_order_id,
    razorpay_payment_id: response.razorpay_payment_id,
    razorpay_signature:  response.razorpay_signature
  }).then(function (res) {

    /* ── the network dropped mid-confirmation ──────────────────────────────
       The money may well have left the customer's account, so we retry rather
       than declaring failure. Idempotency makes retrying free of risk.      */
    if (res.offline && attempt < 3) {
      showCheckoutStatus("Confirming your payment — reconnecting…", "info");
      setTimeout(function () {
        verifyRazorpayPayment(response, nafumeOrderId, values, attempt + 1);
      }, 1500 * attempt);
      return;
    }

    nfCheckoutInFlight = false;

    /* ── still offline, or the server is holding it for confirmation ──────
       Either way the order exists server-side and the webhook / status
       refresh will settle it. Never invite a second payment.              */
    var awaiting = res.offline || res.status === 202 ||
                   (res.data && res.data.paymentState === "awaiting_verification");
    if (awaiting) {
      launchCart = []; saveLaunchCart();
      try {
        window.NafumeAPI.rememberCheckoutContact(nafumeOrderId, values.email || values.phone);
        window.NafumeAPI.rememberAccountPrefill((res.data && res.data.accountPrefill) || {
          name: values.name, email: values.email, phone: values.phone, orderId: nafumeOrderId
        });
      } catch (e) {}
      showCheckoutStatus(NF_AWAITING_PAYMENT_MESSAGE +
        " Payment ID: " + response.razorpay_payment_id + ".", "info");
      try {
        if (window.OperationsService) {
          window.OperationsService.recordAnalyticsEvent("razorpay_payment_awaiting_confirmation", { orderId: nafumeOrderId });
        }
      } catch (e) {}
      setTimeout(function () {
        window.location.href = nfPath("/pages/order/confirmation.html") +
          "?orderId=" + encodeURIComponent(nafumeOrderId) + "&payment=confirming";
      }, 2600);
      return;
    }

    if (!res.ok) {
      setCheckoutBusy(false);
      showCheckoutStatus(
        (res.message || "We could not confirm your payment.") +
        " If money was deducted, contact us with payment ID " + response.razorpay_payment_id +
        " and we will sort it out immediately.",
        "error");
      return;
    }

    showCheckoutStatus("Payment confirmed. Taking you to your order…", "success");
    try {
      if (window.OperationsService) {
        window.OperationsService.recordAnalyticsEvent("razorpay_payment_verified",
          { orderId: nafumeOrderId });
      }
    } catch (e) {}

    onOrderPlaced(res.data.order, res.data.accountPrefill, values);
  });
}

/* ─── Checkout page setup ───────────────────────────────────────────────────
   Wires the single "Place Order" CTA, keeps the label in step with the chosen
   payment method, and hides online payment when Razorpay is switched off in
   js/commerce/config.js (COD then stands alone rather than the page offering a
   button that cannot work).                                                  */
function initCheckoutUI() {
  var form = document.getElementById("shipping-form");
  if (!form) return;

  var cfg = (window.COMMERCE_CONFIG && window.COMMERCE_CONFIG.razorpay) || {};
  var onlineOption = document.querySelector('.payment-option[data-method="online"]');
  var onlineRadio  = document.querySelector('[name="payment"][value="online"]');
  var codRadio     = document.querySelector('[name="payment"][value="COD"]');

  // Availability is a CONFIG decision only. The SDK is fetched on demand in
  // ensureRazorpaySdk(), so whether it happens to be loaded right now says
  // nothing about whether online payment is offered.
  var onlineAvailable = cfg.enabled !== false;
  if (!onlineAvailable) {
    if (onlineOption) onlineOption.style.display = "none";
    if (onlineRadio)  onlineRadio.checked = false;
    if (codRadio)     codRadio.checked = true;
  }

  updatePlaceOrderLabel();
  document.querySelectorAll('[name="payment"]').forEach(function (radio) {
    radio.addEventListener("change", updatePlaceOrderLabel);
  });

  var btn = document.getElementById("btn-place-order");
  if (btn) {
    btn.addEventListener("click", function (e) {
      // The button is type="submit"; let the form's own handler run once.
      if (btn.form) return;
      placeOrder(e);
    });
  }

  // Clear a field's error the moment the customer starts fixing it.
  form.querySelectorAll("input, select, textarea").forEach(function (el) {
    el.addEventListener("input", function () {
      if (!el.classList.contains("has-error")) return;
      el.classList.remove("has-error");
      el.removeAttribute("aria-invalid");
      var msg = el.parentNode && el.parentNode.querySelector(".field-error");
      if (msg) msg.remove();
    });
  });

  // ── promo code ──
  var promoBtn   = document.getElementById("promo-apply");
  var promoInput = document.getElementById("promo-code");
  if (promoBtn) promoBtn.addEventListener("click", applyPromoCode);
  if (promoInput) {
    // Enter applies the code; it must NOT submit the checkout form.
    promoInput.addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); applyPromoCode(); }
    });
  }
}

/* The CTA says exactly what tapping it does. */
function updatePlaceOrderLabel() {
  var btn = document.getElementById("btn-place-order");
  if (!btn) return;
  var method = getShippingPaymentMethod();
  var whatsapp = /whatsapp/i.test(method);
  var online = !whatsapp && !/cod|cash/i.test(method);
  var label  = whatsapp ? "Order on WhatsApp" : (online ? "Pay Securely" : "Place COD Order");
  var icon   = whatsapp ? "chat" : (online ? "lock" : "local_shipping");
  btn.innerHTML = '<span class="material-symbols-outlined" style="font-size:20px;">' + icon + '</span> ' + label;
  delete btn.dataset.idleLabel;
  var trust = document.getElementById("checkout-trust-note");
  if (trust) {
    if (!trust.dataset.original) trust.dataset.original = trust.textContent;
    trust.textContent = whatsapp
      ? "Your order is saved first. Then WhatsApp opens so you can send it to us and we confirm it."
      : trust.dataset.original;
  }
  renderOrderSummary();
  renderPrepaidNote();
  // COD removes the prepaid discount, which changes what a promo code is
  // worth — so an applied code has to be re-quoted.
  revalidatePromoCode();
}
/* ─── Checkout ⇄ account bridge ─────────────────────────────────────────────
   Prefills the shipping form from the SIGNED-IN account (the server session),
   so a returning customer types nothing. Guests are shown a non-blocking note
   and can always check out without an account.

   Runs asynchronously and only fills EMPTY fields, so it can never overwrite
   something the customer has already started typing while the request was in
   flight. */
function initCheckoutAccountUI() {
  var form = document.getElementById("shipping-form");
  var col  = document.querySelector(".shipping-form-col");
  var sub  = document.querySelector(".shipping-subhead");
  if (!form || !col || !window.NafumeAPI) return;

  var note = document.createElement("p");
  note.id = "checkout-account-note";
  note.className = "checkout-account-note";
  note.textContent = "Checking for a saved NAFUME account…";
  if (sub && sub.parentNode === col) col.insertBefore(note, sub.nextSibling);
  else col.insertBefore(note, form);

  function fillEmpty(map) {
    Object.keys(map).forEach(function (k) {
      var el = form.querySelector('[name="' + k + '"]');
      if (el && !el.value && map[k]) el.value = map[k];
    });
  }

  window.NafumeAPI.me().then(function (res) {
    if (res.ok && res.data.authenticated && res.data.customer) {
      var c = res.data.customer;
      var a = c.address || {};
      fillEmpty({
        name: c.name, phone: c.phone, email: c.email,
        addr1: a.line1, addr2: a.line2, city: a.city, state: a.state, pin: a.pincode
      });

      // Reflect the saved marketing choice rather than silently re-opting them in.
      var optIn = document.getElementById("whatsapp-optin");
      if (optIn && res.data.consent) optIn.checked = res.data.consent.whatsapp === true;

      note.className = "checkout-account-note is-signed-in";
      note.textContent = "Welcome back" + (c.name ? ", " + c.name.split(" ")[0] : "") +
        " — we've filled in your saved details. Edit anything before placing your order.";
      return;
    }

    note.className = "checkout-account-note is-guest";
    note.innerHTML = 'Checking out as a guest. ' +
      '<a href="' + nfPath("/pages/account/account.html") + '">Log in</a> ' +
      'to reuse your saved address, or create an account after you order.';
  });
}

// ─── Sitewide: tap & hold to show hover image on touch devices ────────────────
(function() {
  var HOLD_MS = 350;
  function findCard(el) {
    return el.closest && (
      el.closest('.home-product-card') ||
      el.closest('.prod-card') ||
      el.closest('.coll-card')
    );
  }
  function hasHover(card) {
    return !!(card.querySelector('.home-product-image--hover, .prod-card-img--hover, .coll-card-img--hover'));
  }
  document.addEventListener('touchstart', function(e) {
    var card = findCard(e.target);
    if (!card || !hasHover(card)) return;
    card._holdTimer = setTimeout(function() { card.classList.add('touch-peek'); }, HOLD_MS);
  }, { passive: true });
  function clearHold(e) {
    var card = findCard(e.target);
    if (card) { clearTimeout(card._holdTimer); card.classList.remove('touch-peek'); }
  }
  document.addEventListener('touchend', clearHold, { passive: true });
  document.addEventListener('touchmove', clearHold, { passive: true });
  document.addEventListener('touchcancel', clearHold, { passive: true });
})();

