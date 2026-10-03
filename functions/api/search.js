// GET /api/search?q=nama+game
// PC/Mac  : Steam (IDR) + IsThereAnyDeal (opsional, env ITAD_KEY)
// PS      : PlayStation Store Indonesia (IDR)
// Xbox    : Microsoft Store Australia (AUD) + Singapura (SGD), dikonversi ke IDR
// Switch  : Nintendo eShop Malaysia (MYR) + Australia (AUD), dikonversi ke IDR
// Semua sumber selain ITAD tidak resmi dan bisa berubah sewaktu-waktu.

const ITAD = "https://api.isthereanydeal.com";
const MAX = 6;
const CACHE_SECONDS = 3600;
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

const enc = encodeURIComponent;
const get = (url, opts = {}) =>
  fetch(url, {
    ...opts,
    headers: { "User-Agent": UA, "Accept-Language": "en", ...(opts.headers || {}) },
    signal: AbortSignal.timeout(8000),
  });
const json = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...extra },
  });

export async function onRequestGet({ request, env, waitUntil }) {
  const url = new URL(request.url);
  const q = (url.searchParams.get("q") || "").trim();
  if (q.length < 2) return json({ error: "Ketik minimal 2 huruf." }, 400);

  // Cache edge. Tidak semua runtime menyediakan Cache API, jadi semua akses
  // dibungkus try/catch: kalau tidak ada, aplikasi tetap jalan lewat KV / fetch.
  let cache = null;
  let cacheKey = null;
  try {
    cache = caches.default;
    cacheKey = new Request(`${url.origin}/api/search?q=${enc(q.toLowerCase())}`);
    const hit = await cache.match(cacheKey);
    if (hit) return hit;
  } catch {
    cache = null;
  }

  // Cache global lewat KV (opsional, aktif kalau binding CACHE dipasang)
  const kvKey = "q:" + q.toLowerCase();
  if (env.CACHE) {
    try {
      const saved = await env.CACHE.get(kvKey);
      if (saved) {
        return new Response(saved, {
          headers: { "Content-Type": "application/json; charset=utf-8", "X-Cache": "KV" },
        });
      }
    } catch {}
  }

  const rates = await getRates();
  const names = ["steam", "playstation", "xbox", "switch"];
  const settled = await Promise.allSettled([
    steam(q, env, rates),
    playstation(q),
    xbox(q, rates),
    nintendo(q, rates),
  ]);

  // Gabungkan hasil semua sumber berdasarkan judul
  const sources = {};
  const groups = new Map();
  settled.forEach((s, i) => {
    sources[names[i]] = s.status === "fulfilled" ? (s.value.length ? "ok" : "kosong") : "error";
    if (s.status !== "fulfilled") return;
    for (const item of s.value) {
      const key = norm(item.name);
      if (!groups.has(key)) groups.set(key, { name: item.name, offers: [], tags: [] });
      const g = groups.get(key);
      g.offers.push(...item.offers);
      for (const t of item.tags || []) if (!g.tags.includes(t)) g.tags.push(t);
      if (!g.release && item.release) g.release = item.release;
    }
  });
  if (!env.ITAD_KEY) sources.itad = "off";

  const games = [...groups.values()].filter((g) => g.offers.length);
  for (const g of games) {
    g.offers.sort((a, b) => (a.idr ?? Infinity) - (b.idr ?? Infinity));
  }

  const body = { query: q, sources, games };
  const res = json(body, 200, {
    "Cache-Control": `public, s-maxage=${CACHE_SECONDS}`,
  });
  if (games.length) {
    if (cache) {
      try {
        waitUntil(cache.put(cacheKey, res.clone()));
      } catch {}
    }
    if (env.CACHE) {
      try {
        waitUntil(env.CACHE.put(kvKey, JSON.stringify(body), { expirationTtl: CACHE_SECONDS }));
      } catch {}
    }
  }
  return res;
}

const norm = (s) =>
  s.toLowerCase().replace(/[™®©]/g, "").replace(/[^a-z0-9]+/g, "");

// Hanya anggap hasil relevan kalau judul memuat semua kata kunci query
// (kata >= 3 huruf). Membuang hasil pencarian sampingan seperti
// "Ace Robot Combat" saat mencari "ACE COMBAT 7".
function relevan(name, q) {
  const kata = q
    .toLowerCase()
    .replace(/[™®©]/g, "")
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3);
  if (!kata.length) return true;
  const judul = norm(name);
  return kata.every((w) => judul.includes(w));
}

async function getRates() {
  try {
    const r = await get("https://open.er-api.com/v6/latest/USD", { cf: { cacheTtl: 21600 } });
    return (await r.json()).rates || {};
  } catch {
    return {};
  }
}

function toIdr(amount, currency, rates) {
  if (amount == null) return null;
  if (currency === "IDR") return amount;
  if (!rates[currency] || !rates.IDR) return null;
  return Math.round((amount / rates[currency]) * rates.IDR);
}

function offer(shop, platforms, amount, regular, currency, rates, url) {
  return {
    shop,
    platforms,
    idr: toIdr(amount, currency, rates),
    regularIdr: toIdr(regular, currency, rates),
    converted: currency !== "IDR",
    original: currency !== "IDR" && amount != null ? `${currency} ${amount}` : null,
    url,
  };
}

// Tag dari nama (gratis, tanpa request). Contoh: "DELUXE EDITION" -> "Deluxe".
function tagEdisi(nama) {
  const m = nama.match(/\b(deluxe|ultimate|definitive|complete|gold|premium|standard|goty|game of the year)\b/i);
  if (!m) return null;
  return m[1].toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

// Tipe produk dari appdetails.type -> label Indonesia.
const TIPE = {
  game: "Game",
  dlc: "DLC",
  music: "Soundtrack",
  demo: "Demo",
  mod: "Mod",
  adventure: "Game",
  series: "Seri",
  video: "Video",
  hardware: "Hardware",
};

/* ---------- PC / Mac ---------- */
async function steam(q, env, rates) {
  const r = await get(`https://store.steampowered.com/api/storesearch/?term=${enc(q)}&l=english&cc=ID`);
  if (!r.ok) throw new Error(`Steam ${r.status}`);
  const items = ((await r.json()).items || [])
    .filter((i) => i.type === "app" && relevan(i.name, q))
    .slice(0, MAX);

  // Ambil detail paralel (type, genre, status). Dibungkus try agar gagal satu
  // tidak menjatuhkan seluruh pencarian.
  const details = await Promise.all(items.map((i) => ambilDetail(i.id)));

  const out = items.map((i, n) => {
    const plats = [];
    if (i.platforms?.windows) plats.push("pc");
    if (i.platforms?.mac) plats.push("mac");
    return {
      id: i.id,
      name: i.name,
      plats,
      tags: tagGame(i, details[n]),
      release: tanggalRilis(details[n]),
      offers: [
        offer("Steam", plats,
          i.price ? i.price.final / 100 : null,
          i.price ? i.price.initial / 100 : null,
          "IDR", rates, `https://store.steampowered.com/app/${i.id}/`),
      ],
    };
  });

  if (env.ITAD_KEY && out.length) {
    try { await addItad(out, env.ITAD_KEY, rates); } catch {}
  }
  return out;
}

// Detail app Steam (1 request per game, di-cache Cloudflare 1 hari).
async function ambilDetail(appid) {
  try {
    const r = await get(`https://store.steampowered.com/api/appdetails?appids=${appid}&l=english&cc=ID`, {
      cf: { cacheTtl: 86400 },
    });
    if (!r.ok) return null;
    return (await r.json())?.[appid]?.data || null;
  } catch {
    return null;
  }
}

// Tag dasar dari nama saja (untuk PS/Xbox/Switch yang tidak punya appdetails).
function tagDasar(nama, klasifikasi) {
  const tags = [];
  if (/\bdlc\b|season pass|expansion|add-?on/i.test(nama)) tags.push("DLC");
  else if (/soundtrack|\bost\b/i.test(nama)) tags.push("Soundtrack");
  else if (/bundle/i.test(nama) || /BUNDLE/i.test(klasifikasi || "")) tags.push("Bundle");
  else tags.push("Game");

  const edisi = tagEdisi(nama);
  if (edisi && !tags.includes(edisi)) tags.push(edisi);
  return tags;
}

// Susun tag untuk sebuah game Steam.
function tagGame(item, detail) {
  const tags = [];
  const tipe = TIPE[detail?.type];
  if (tipe) tags.push(tipe);
  else if (item.name) {
    // Fallback dari nama kalau appdetails gagal
    if (/\bdlc\b|season pass|expansion/i.test(item.name)) tags.push("DLC");
    else if (/soundtrack|ost\b/i.test(item.name)) tags.push("Soundtrack");
    else tags.push("Game");
  }

  for (const g of (detail?.genres || []).slice(0, 2)) if (g.description) tags.push(g.description);

  const edisi = tagEdisi(item.name);
  if (edisi && !tags.includes(edisi)) tags.push(edisi);

  const soon = detail?.release_date?.coming_soon;
  const adaHarga = item.price && item.price.final != null;
  if (detail?.is_free) tags.push("Gratis");
  else if (soon && adaHarga) tags.push("Pre-order");
  else if (soon) tags.push("Belum rilis");

  if (item.metascore) tags.push("Metascore " + item.metascore);

  return tags;
}

// Tanggal rilis ringkas: "23 Feb 2027", atau null kalau tidak diketahui.
const BULAN = ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des"];
function tanggalRilis(detail) {
  const d = detail?.release_date?.date;
  if (!d) return null;
  // Steam memakai format "23 Feb, 2027" atau "2027" atau "Q1 2027"
  const m = d.match(/^(\d{1,2})\s+([A-Za-z]{3}),?\s*(\d{4})$/);
  if (m) {
    const bln = BULAN[["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"].indexOf(m[2].toLowerCase())];
    return `${m[1]} ${bln || m[2]} ${m[3]}`;
  }
  return d; // "2027", "Segera hadir", dll. — tampilkan apa adanya
}

async function addItad(games, key, rates) {
  // Satu request untuk semua appid (bukan satu per game)
  const lr = await get(`${ITAD}/lookup/id/shop/61/v1?key=${key}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(games.map((g) => `app/${g.id}`)),
  });
  if (!lr.ok) throw new Error(`ITAD lookup ${lr.status}`);
  const map = await lr.json();

  const valid = [];
  for (const g of games) {
    g.itadId = map[`app/${g.id}`] || null;
    if (g.itadId) valid.push(g.itadId);
  }
  if (!valid.length) return;

  const r = await get(`${ITAD}/games/prices/v3?key=${key}&country=ID`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(valid),
  });
  if (!r.ok) throw new Error(`ITAD ${r.status}`);
  const byItadId = new Map(games.filter((g) => g.itadId).map((g) => [g.itadId, g]));

  for (const row of await r.json()) {
    const g = byItadId.get(row.id);
    if (!g) continue;
    for (const d of row.deals || []) {
      if (!d.shop || d.shop.name === "Steam") continue;
      g.offers.push(offer(d.shop.name, itadPlats(d, g.plats), d.price.amount, d.regular.amount, d.price.currency, rates, d.url));
    }
  }
}

// Platform dari data ITAD; kalau kosong, pakai daftar platform Steam.
function itadPlats(deal, fallback) {
  const names = (deal.platforms || []).map((p) => (p.name || "").toLowerCase());
  const plats = [];
  if (names.some((n) => n.includes("windows") || n.includes("pc"))) plats.push("pc");
  if (names.some((n) => n.includes("mac"))) plats.push("mac");
  return plats.length ? plats : fallback;
}

/* ---------- PlayStation Store Indonesia ---------- */
async function playstation(q) {
  const r = await get(`https://store.playstation.com/en-id/search/${enc(q)}`);
  if (!r.ok) throw new Error(`PS ${r.status}`);
  const m = (await r.text()).match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) throw new Error("PS: data tidak ditemukan");
  const state = JSON.parse(m[1]).props.apolloState || {};
  const deref = (v) => (v && (v.__ref || v.id) && state[v.__ref || v.id]) || v;
  const num = (s) => (s ? Number(String(s).replace(/[^\d]/g, "")) : null);

  const out = [];
  for (const p of Object.values(state)) {
    if (!p || p.__typename !== "Product" || !p.name) continue;
    if (!relevan(p.name, q)) continue;
    const cls = p.storeDisplayClassification || "";
    if (!/GAME|EDITION|BUNDLE/.test(cls)) continue;
    const price = deref(p.price);
    if (!price) continue;
    const now = price.isFree ? 0 : num(price.discountedPrice || price.basePrice);
    out.push({
      name: p.name,
      tags: tagDasar(p.name, cls),
      offers: [offer("PlayStation Store Indonesia", ["ps"], now, num(price.basePrice), "IDR", {},
        `https://store.playstation.com/en-id/product/${p.id}`)],
    });
    if (out.length >= MAX) break;
  }
  return out;
}

/* ---------- Xbox: Australia + Singapura ---------- */
async function xbox(q, rates) {
  const s = await get(
    `https://www.microsoft.com/msstoreapiprod/api/autosuggest?market=en-au&sources=DCatAll-Products&filter=%2BClientType%3AStoreWeb&counts=10&query=${enc(q)}`
  );
  if (!s.ok) throw new Error(`Xbox ${s.status}`);
  const suggests = ((await s.json()).ResultSets?.[0]?.Suggests || []).filter(
    (x) => x.Source === "Games" && relevan(x.Title || "", q)
  );
  const ids = suggests
    .map((x) => (x.Metas || []).find((m) => m.Key === "BigCatalogId")?.Value)
    .filter(Boolean)
    .slice(0, MAX);
  if (!ids.length) return [];

  const markets = [
    { code: "AU", lang: "en-au", label: "Xbox Store Australia" },
    { code: "SG", lang: "en-sg", label: "Xbox Store Singapura" },
  ];
  const byId = new Map();
  await Promise.all(markets.map(async (mk) => {
    const r = await get(
      `https://displaycatalog.mp.microsoft.com/v7.0/products?bigIds=${ids.join(",")}&market=${mk.code}&languages=${mk.lang}&MS-CV=DGU1mcuYo0WMMp.1`
    );
    if (!r.ok) return;
    for (const p of (await r.json()).Products || []) {
      const price = xboxPrice(p);
      if (!price) continue;
      const id = p.ProductId;
      if (!byId.has(id)) {
        const nama = p.LocalizedProperties?.[0]?.ProductTitle || id;
        byId.set(id, { name: nama, tags: tagDasar(nama), offers: [] });
      }
      byId.get(id).offers.push(
        offer(mk.label, ["xbox"], price.ListPrice, price.MSRP, price.CurrencyCode, rates,
          `https://www.xbox.com/${mk.lang}/games/store/-/${id}`)
      );
    }
  }));
  if (!byId.size) throw new Error("Xbox: harga tidak tersedia");
  return ids.map((id) => byId.get(id)).filter(Boolean);
}

function xboxPrice(p) {
  for (const sku of p.DisplaySkuAvailabilities || []) {
    if (sku.Sku?.Properties?.IsTrial) continue;
    for (const a of sku.Availabilities || []) {
      const price = a.OrderManagementData?.Price;
      if ((a.Actions || []).includes("Purchase") && price) return price;
    }
  }
  return null;
}

/* ---------- Nintendo eShop: Malaysia + Australia ---------- */
// ID game (nsuid) diambil dari pencarian Nintendo Eropa. Katalog Australia
// memakai ID yang sama; Malaysia hanya muncul kalau ID-nya kebetulan sama.
async function nintendo(q, rates) {
  const s = await get(
    `https://searching.nintendo-europe.com/en/select?q=${enc(q)}&fq=${enc("type:GAME AND system_type:nintendoswitch*")}&rows=${MAX * 4}&wt=json`
  );
  if (!s.ok) throw new Error(`Nintendo ${s.status}`);
  const docs = ((await s.json()).response?.docs || [])
    .filter((d) => d.nsuid_txt?.[0] && relevan(d.title, q))
    .slice(0, MAX);
  if (!docs.length) return [];
  const ids = docs.map((d) => d.nsuid_txt[0]);

  const markets = [
    { code: "MY", label: "Nintendo eShop Malaysia", fallback: "MYR" },
    { code: "AU", label: "Nintendo eShop Australia", fallback: "AUD" },
  ];
  const byId = new Map(docs.map((d) => [d.nsuid_txt[0], { name: d.title, tags: tagDasar(d.title), offers: [] }]));
  await Promise.all(markets.map(async (mk) => {
    const r = await get(`https://api.ec.nintendo.com/v1/price?country=${mk.code}&lang=en&ids=${ids.join(",")}`);
    if (!r.ok) return;
    for (const p of (await r.json()).prices || []) {
      const g = byId.get(String(p.title_id));
      if (!g || !p.regular_price) continue;
      const regular = Number(p.regular_price.raw_value);
      const now = p.discount_price ? Number(p.discount_price.raw_value) : regular;
      g.offers.push(offer(mk.label, ["switch"], now, regular, p.regular_price.currency || mk.fallback, rates,
        `https://ec.nintendo.com/${mk.code}/en/titles/${p.title_id}`));
    }
  }));
  return ids.map((id) => byId.get(id)).filter((g) => g.offers.length);
}
