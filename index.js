// index.js
// Express API wrapper around your scraper parser with:
// - Path param route: /character/:character
// - Fix for "-" placeholders so level 0 jobs keep their real name
// - "details" object (name + world) at the top level

const express = require("express");
const axios = require("axios");
const cheerio = require("cheerio");
const he = require("he");

const app = express();
const PORT = process.env.PORT || 3000;

// ---------- Route for frontend HTML ----------
app.use("/", express.static("public"));

// ---------- HTTP route with path param ----------
app.get("/character/:character", async (req, res) => {
  const id = (req.params.character || "").trim();

  if (!id) {
    return res.status(400).json({ error: "Missing character ID." });
  }

  const url = `https://na.finalfantasyxiv.com/lodestone/character/${encodeURIComponent(id)}/class_job/`;

  try {
    // Fetch the page
    const resp = await axios.get(url, {
      headers: { "User-Agent": "Mozilla/5.0 (scraper)" },
      timeout: 15000,
    });

    const pretty = String(resp.data);
    const rawHtml = reconstructFromViewSource(pretty);

    const $ = cheerio.load(rawHtml, { decodeEntities: false });

    const out = {
      details: {
        name: norm($(".frame__chara__name").first().text()),
        world: norm($(".frame__chara__world").first().text()),
      },
      "DoW/DoM": {
        Tank: { icon: null, jobs: [] },
        Healer: { icon: null, jobs: [] },
        "Melee DPS": { icon: null, jobs: [] },
        "Physical Ranged DPS": { icon: null, jobs: [] },
        "Magical Ranged DPS": { icon: null, jobs: [] },
        "Limited Jobs": { icon: null, jobs: [] },
      },
      "DoH/DoL": {
        "Hand (DoH)": { icon: null, jobs: [] },
        "Land (DoL)": { icon: null, jobs: [] },
      },
    };

    const h4s = $("h4");
    h4s.each((_, h4) => {
      const label = norm($(h4).text()).toLowerCase();
      const target = mapCategory(label);
      if (!target) return;
      const [group, key] = target;

      const catImg = $(h4).find("img").first().attr("src");
      if (catImg && out[group][key].icon == null) out[group][key].icon = catImg;

      const ul = $(h4).nextAll("ul").first();
      if (!ul.length) return;

      ul.find("> li").each((_, li) => {
        const parsed = parseLi($, li);
        if (!parsed.name) return;

        out[group][key].jobs.push({
          job_icon: parsed.icon || null,
          job_level: parsed.level || 0,
          job_name: parsed.name,
          job_name_tooltip: parsed.tooltip || parsed.name,
          job_exp: parsed.exp || 0,
          job_exp_max: parsed.max || 0,
        });
      });
    });

    // Success: return JSON
    res.set("Cache-Control", "no-store");
    return res.json(out);
  } catch (err) {
    const status = err.response?.status;
    const msg =
      status
        ? `Upstream returned HTTP ${status}`
        : err.code === "ECONNABORTED"
        ? "Request timed out"
        : "Fetch/parse failed";
    return res.status(502).json({ error: msg, url });
  }
});

// ---------- Start server ----------
app.listen(PORT, () => {
  console.log(`Scraper API listening on http://localhost:${PORT}`);
});

/* -------------------- robust view-source reconstruction -------------------- */
function reconstructFromViewSource(html) {
  // If the HTML is a "view-source" table, collect the line-content cells and
  // stitch them back together. Otherwise, return the input as-is.
  const cellRegex = /<td[^>]*class=(?:"|')([^"']*line-content[^"']*)(?:"|')[^>]*>([\s\S]*?)<\/td>/gi;
  let m, cells = [];
  while ((m = cellRegex.exec(html)) !== null) {
    const inner = m[2];
    const noTags = inner.replace(/<[^>]+>/g, "");
    cells.push(he.decode(noTags));
  }
  if (cells.length === 0) {
    return html; // not a "view-source" dump
  }
  return cells.join("\n");
}

/* --------------------------- structural helpers --------------------------- */
function norm(s) {
  return (s || "").replace(/\s+/g, " ").trim();
}

function mapCategory(t) {
  if (t.includes("tank")) return ["DoW/DoM", "Tank"];
  if (t.includes("healer")) return ["DoW/DoM", "Healer"];
  if (t.includes("melee dps")) return ["DoW/DoM", "Melee DPS"];
  if (t.includes("physical ranged dps")) return ["DoW/DoM", "Physical Ranged DPS"];
  if (t.includes("magical ranged dps")) return ["DoW/DoM", "Magical Ranged DPS"];
  if (t.includes("limited")) return ["DoW/DoM", "Limited Jobs"];
  if (t.includes("disciples of the hand") || t === "hand") return ["DoH/DoL", "Hand (DoH)"];
  if (t.includes("disciples of the land") || t === "land") return ["DoH/DoL", "Land (DoL)"];
  return null;
}

// Parse a single <li> based on child structure (no classes)
function parseLi($, li) {
  const $li = $(li);

  const icon = $li.find("img").first().attr("src") || null;

  let level = 0, name = "", tooltip = "", exp = 0, max = 0;
  const isDash = (s) => s === "-" || s === "–";

  $li.children("div").each((_, div) => {
    const $div = $(div);
    const raw = norm($div.text());

    // Level: only accept pure digits; ignore "-" placeholders
    if (!level && /^\d{1,3}$/.test(raw)) {
      level = parseInt(raw, 10);
      return;
    }

    // EXP: "n / m"
    const m = raw.match(/(\d[\d,]*)\s*\/\s*(\d[\d,]*)/);
    if (m) {
      exp = parseInt(m[1].replace(/,/g, ""), 10);
      max = parseInt(m[2].replace(/,/g, ""), 10);
      return;
    }

    // Name: ignore "-" placeholders; prefer strings with letters
    if (!name && raw && !isDash(raw) && /[A-Za-z]/.test(raw)) {
      name = raw;
      tooltip =
        $div.attr("data-tooltip") ||
        $div.attr("title") ||
        $div.attr("aria-label") ||
        name;
    }
  });

  return { icon, level, name, tooltip, exp, max };
}
