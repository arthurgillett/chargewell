const GOOGLE_API_KEY    = process.env.GOOGLE_API_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

const HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json"
};

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: HEADERS, body: "" };

  const { origin, destination, travellerType, vehicle } = JSON.parse(event.body || "{}");
  if (!origin || !destination) {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: "origin and destination required" }) };
  }

  // ── Step 1: Get route from Google Directions ──────────────────────────
  let routePoints = [];
  let totalDistanceMeters = 0;
  let routeLegs;
  try {
    const dirUrl = `https://maps.googleapis.com/maps/api/directions/json?origin=${encodeURIComponent(origin)}&destination=${encodeURIComponent(destination)}&key=${GOOGLE_API_KEY}`;
    const dirRes = await fetch(dirUrl);
    const dirJson = await dirRes.json();
    if (!dirJson.routes?.length) {
      throw new Error(`${dirJson.status || "UNKNOWN"}: ${dirJson.error_message || "No routes returned"}`);
    }
    const route = dirJson.routes[0];
    routeLegs = route.legs;
    totalDistanceMeters = route.legs.reduce((sum, leg) => sum + leg.distance.value, 0);
    routePoints = sampleRoutePoints(route, 30000);
  } catch (e) {
    return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: `Directions failed: ${e.message}` }) };
  }

  // ── Step 2: Find DC fast chargers via Open Charge Map ─────────────────
  let chargers = [];
  try {
    const chargerPromises = routePoints.map(pt =>
      fetch(`https://api.openchargemap.io/v3/poi/?output=json&latitude=${pt.lat}&longitude=${pt.lng}&distance=15&distanceunit=km&maxresults=5&levelid=3&compact=true&verbose=false`)
        .then(r => r.json())
        .catch(() => [])
    );
    const results = await Promise.all(chargerPromises);
    const seen = new Set();
    results.flat().forEach(c => {
      const id = c.ID;
      if (!id || seen.has(id)) return;
      seen.add(id);
      const addr = c.AddressInfo;
      if (!addr?.Latitude || !addr?.Longitude) return;

      // Calculate distance from route origin
      const originLat = routeLegs[0].start_location.lat;
      const originLng = routeLegs[0].start_location.lng;
      const distFromOrigin = haversine(originLat, originLng, addr.Latitude, addr.Longitude);

      chargers.push({
        id,
        name: addr.Title || `Charger ${id}`,
        address: [addr.AddressLine1, addr.Town, addr.StateOrProvince, addr.Postcode].filter(Boolean).join(", "),
        lat: addr.Latitude,
        lng: addr.Longitude,
        network: c.OperatorInfo?.Title || "Unknown network",
        kw: c.Connections?.[0]?.PowerKW || 50,
        typicalMinutes: estimateMinutes(c.Connections?.[0]?.PowerKW),
        distanceFromOriginKm: Math.round(distFromOrigin / 1000)
      });
    });

    // Sort by distance from origin and keep top 4
    chargers.sort((a, b) => a.distanceFromOriginKm - b.distanceFromOriginKm);
    chargers = chargers.slice(0, 4);
  } catch (e) {
    return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: `Charger search failed: ${e.message}` }) };
  }

  if (!chargers.length) {
    return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ chargers: [], totalDistanceKm: Math.round(totalDistanceMeters / 1000) }) };
  }

  // ── Step 3: Grade each charger (Places + Claude Haiku) ────────────────
  const graded = await Promise.all(chargers.map(c => gradeCharger(c, travellerType, vehicle)));

  return {
    statusCode: 200,
    headers: HEADERS,
    body: JSON.stringify({
      chargers: graded,
      totalDistanceKm: Math.round(totalDistanceMeters / 1000)
    })
  };
};

async function gradeCharger(charger, travellerType, vehicle) {
  // Get nearby places within 750m
  let places = [];
  try {
    const url = `https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=${charger.lat},${charger.lng}&radius=750&key=${GOOGLE_API_KEY}`;
    const res = await fetch(url);
    const json = await res.json();
    places = (json.results || []).slice(0, 10).map(p => ({
      name: p.name,
      types: (p.types || []).filter(t => !["point_of_interest", "establishment"].includes(t)).slice(0, 2),
      rating: p.rating || null,
      meters: haversine(charger.lat, charger.lng, p.geometry.location.lat, p.geometry.location.lng)
    })).filter(p => p.meters <= 750);
  } catch (e) { places = []; }

  // Ask Claude Haiku to grade the stop
  let grade = { score: 50, scoreWord: "Decent", food: "See nearby options", coffee: null, outdoors: null, kids: null, caveat: null, foodTier: "chain" };
  try {
    const prompt = `Grade this EV charging stop for a road trip.
Charger: ${charger.name} · ${charger.network} · ${charger.kw}kW · ~${charger.typicalMinutes} min wait
Vehicle: ${vehicle || "EV"}
Travellers: ${travellerType || "Family with kids"}
Nearby places within 750m: ${JSON.stringify(places)}

Reply ONLY with JSON:
{
  "score": <0-100>,
  "scoreWord": <"Wonderful"|"Great stop"|"Decent"|"Basic">,
  "food": "<best 1-2 walkable food options as readable string, mention if local or chain>",
  "coffee": "<best coffee nearby or null>",
  "outdoors": "<best outdoor/park option walkable or null>",
  "kids": "<best kid-friendly option or null>",
  "caveat": "<one short sentence caveat or null>",
  "foodTier": <"local"|"mid"|"chain">
}
85-100=exceptional local food+outdoor, 70-84=great with gem, 55-69=decent+walkable, 40-54=chains only, 0-39=nothing nearby.`;

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 300,
        messages: [{ role: "user", content: prompt }]
      })
    });
    const json = await res.json();
    const text = json.content?.[0]?.text || "{}";
    // Extract JSON from response (handle markdown code blocks)
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      grade = JSON.parse(jsonMatch[0]);
    }
  } catch (e) { /* use default grade */ }

  return { ...charger, ...grade };
}

function estimateMinutes(kw) {
  if (!kw) return 40;
  if (kw >= 250) return 20;
  if (kw >= 150) return 30;
  if (kw >= 50) return 45;
  return 60;
}

function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

function sampleRoutePoints(route, intervalMeters) {
  const points = [];
  let accumulated = 0;
  for (const leg of route.legs) {
    for (const step of leg.steps) {
      accumulated += step.distance.value;
      if (accumulated >= intervalMeters) {
        points.push({ lat: step.end_location.lat, lng: step.end_location.lng });
        accumulated = 0;
      }
    }
  }
  return points;
}
