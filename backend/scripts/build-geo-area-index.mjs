/**
 * One-shot offline extractor: documented open datasets → src/data/geo-area-index.json
 * Run after populating backend/.tmp-geo-coverage/ (not committed).
 * Names are copied only from source fields — no hand aliases.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cov = resolve(root, ".tmp-geo-coverage");

function bboxOf(geom) {
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLng = Infinity;
  let maxLng = -Infinity;
  const visit = (c) => {
    if (typeof c[0] === "number") {
      const lng = c[0];
      const lat = c[1];
      minLat = Math.min(minLat, lat);
      maxLat = Math.max(maxLat, lat);
      minLng = Math.min(minLng, lng);
      maxLng = Math.max(maxLng, lng);
      return;
    }
    for (const x of c) visit(x);
  };
  visit(geom.coordinates);
  return {
    low: { lat: minLat, lng: minLng },
    high: { lat: maxLat, lng: maxLng },
    spanLat: maxLat - minLat,
    spanLng: maxLng - minLng,
  };
}

function uniqNames(arr) {
  const out = [];
  const seen = new Set();
  for (const n of arr) {
    const t = String(n ?? "").trim();
    if (!t) continue;
    const k = t.normalize("NFC").toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  return out;
}

/** Keep ring endpoints; thin vertices for large admin polys (offline index size). */
function simplifyRing(ring, maxPoints = 80) {
  if (!Array.isArray(ring) || ring.length <= maxPoints) {
    return ring;
  }
  const closed =
    ring.length >= 2 &&
    ring[0][0] === ring[ring.length - 1][0] &&
    ring[0][1] === ring[ring.length - 1][1];
  const body = closed ? ring.slice(0, -1) : ring.slice();
  const step = Math.max(1, Math.ceil(body.length / (maxPoints - 1)));
  const out = [];
  for (let i = 0; i < body.length; i += step) {
    out.push(body[i]);
  }
  const last = body[body.length - 1];
  if (out[out.length - 1] !== last) {
    out.push(last);
  }
  if (closed) {
    out.push(out[0]);
  }
  return out;
}

function simplifyGeometry(geom) {
  if (geom.type === "Polygon") {
    return {
      type: "Polygon",
      coordinates: geom.coordinates.map((ring, i) =>
        simplifyRing(ring, i === 0 ? 120 : 40),
      ),
    };
  }
  if (geom.type === "MultiPolygon") {
    return {
      type: "MultiPolygon",
      coordinates: geom.coordinates.map((poly) =>
        poly.map((ring, i) => simplifyRing(ring, i === 0 ? 100 : 30)),
      ),
    };
  }
  return geom;
}

const features = [];

const ne = JSON.parse(
  readFileSync(resolve(cov, "ne_10m_geography_regions_polys.geojson"), "utf8"),
);
const wantNe = new Set(["Negev Desert", "PATAGONIA", "Massif Central"]);
for (const f of ne.features) {
  const p = f.properties || {};
  if (!wantNe.has(p.NAME)) continue;
  const geometry = simplifyGeometry(f.geometry);
  features.push({
    id: `natural_earth:${p.NE_ID}`,
    names: uniqNames([p.NAME, p.NAME_EN, p.NAME_HE, p.NAME_FR, p.LABEL]),
    kind: "vernacular_region",
    hierarchy: {
      level: "physical_region",
      featureClass: p.FEATURECLA,
      region: p.REGION || null,
    },
    source: {
      dataset: "natural-earth-vector/geojson/ne_10m_geography_regions_polys.geojson",
      provider: "Natural Earth",
      license: "public domain",
      attribution: "Made with Natural Earth",
      featureId: String(p.NE_ID),
      wikidata: p.WIKIDATAID || null,
      url: "https://github.com/nvkelso/natural-earth-vector",
    },
    geometry,
    bbox: bboxOf(geometry),
  });
}

const isr = JSON.parse(readFileSync(resolve(cov, "ISR_ADM1.geojson"), "utf8"));
for (const f of isr.features) {
  const p = f.properties || {};
  const geometry = simplifyGeometry(f.geometry);
  features.push({
    id: `geoboundaries:ISR:ADM1:${p.shapeID}`,
    names: uniqNames([p.shapeName]),
    kind: "admin_broad",
    hierarchy: {
      level: "ADM1",
      shapeType: p.shapeType,
      shapeISO: p.shapeISO || null,
      shapeGroup: p.shapeGroup,
    },
    source: {
      dataset: "geoBoundaries-ISR-ADM1",
      provider: "geoBoundaries (wmgeolab)",
      license: "CC BY 4.0",
      attribution: "geoBoundaries",
      featureId: String(p.shapeID),
      url: "https://www.geoboundaries.org/",
    },
    geometry,
    bbox: bboxOf(geometry),
  });
}

const fra = JSON.parse(readFileSync(resolve(cov, "FRA_ADM1.geojson"), "utf8"));
for (const f of fra.features) {
  const p = f.properties || {};
  if (p.shapeName !== "Provence-Alpes-Côte d'Azur") continue;
  const geometry = simplifyGeometry(f.geometry);
  features.push({
    id: `geoboundaries:FRA:ADM1:${p.shapeID}`,
    names: uniqNames([p.shapeName]),
    kind: "admin_broad",
    hierarchy: {
      level: "ADM1",
      shapeType: p.shapeType,
      shapeISO: p.shapeISO || null,
      shapeGroup: p.shapeGroup,
    },
    source: {
      dataset: "geoBoundaries-FRA-ADM1",
      provider: "geoBoundaries (wmgeolab)",
      license: "CC BY 4.0",
      attribution: "geoBoundaries",
      featureId: String(p.shapeID),
      url: "https://www.geoboundaries.org/",
      geometryNote: "rings thinned for index size; bbox preserved from simplified rings",
    },
    geometry,
    bbox: bboxOf(geometry),
  });
}

const coverageNotes = {
  הגליל: {
    inIndex: false,
    reason:
      "Absent from Natural Earth geography regions and geoBoundaries ISR ADM1",
  },
  השרון: {
    inIndex: false,
    reason:
      "Absent from Natural Earth geography regions and geoBoundaries ISR ADM1",
  },
  הנגב: {
    inIndex: true,
    source: "Natural Earth Negev Desert (NAME_HE from dataset)",
  },
  "דרום צרפת": {
    inIndex: false,
    reason:
      "No feature named South France; PACA indexed only under its exact admin name",
  },
  "מחוז מינהלי ברור": {
    inIndex: true,
    source: "geoBoundaries ISR ADM1 (English shapeName only)",
  },
  "אזור עממי מחוץ לישראל": {
    inIndex: true,
    examples: ["Patagonia", "Massif Central"],
  },
  "Provence-Alpes-Côte d'Azur": {
    inIndex: true,
    note: "Exact admin name only — not an alias for דרום צרפת",
  },
};

const index = {
  version: 1,
  generatedAt: new Date().toISOString(),
  description:
    "Minimal geographic-area index from documented open datasets. Names are source fields only (no hand aliases).",
  coverageNotes,
  features,
};

mkdirSync(resolve(root, "src/data"), { recursive: true });
const outPath = resolve(root, "src/data/geo-area-index.json");
writeFileSync(outPath, JSON.stringify(index));
console.log(
  JSON.stringify(
    {
      outPath,
      featureCount: features.length,
      totalBytes: Buffer.byteLength(JSON.stringify(index)),
      summary: features.map((f) => ({
        id: f.id,
        names: f.names,
        kind: f.kind,
        geomBytes: Buffer.byteLength(JSON.stringify(f.geometry)),
      })),
    },
    null,
    2,
  ),
);
