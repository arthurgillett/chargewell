const GOOGLE_API_KEY    = process.env.GOOGLE_API_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const NREL_API_KEY      = process.env.NREL_API_KEY || "DEMO_KEY";

// Realistic highway range at 75mph (miles) — roughly 70-75% of EPA rated range
const VEHICLE_RANGE_MI = {
  tesla_model_y_lr: 240,
  tesla_model_y_sr: 200,
  tesla_model_3_lr: 260,
  tesla_model_3_sr: 210,
  tesla_cybertruck: 230,
  rivian_r1t: 220,
  rivian_r1s: 225,
  ford_mach_e: 210,
  ford_f150_lightning: 180,
  chevy_equinox_ev: 245,
  chevy_blazer_ev: 220,
  hyundai_ioniq_5: 230,
  hyundai_ioniq_6: 260,
  kia_ev6: 240,
  kia_ev9: 210,
  bmw_ix: 250,
  mercedes_eqs: 280,
  vw_id4: 210,
  porsche_taycan: 200,
  lucid_air: 375,
  cadillac_lyriq: 240,
  polestar_2: 210,
  nissan_ariya: 230,
};

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

  // ── Check if the trip is within range (arrive with 20%+ battery) ────────
  const rangeMi = VEHICLE_RANGE_MI[vehicle] || 210;
  const totalDistanceMi = totalDistanceMeters / 1609.344;
  const arrivalPct = Math.round((1 - totalDistanceMi / rangeMi) * 100);

  if (arrivalPct >= 20) {
    const mi = Math.round(totalDistanceMi);
    const messages = [
      `Your ${vehicleName(vehicle)} eats ${mi} miles for breakfast. You'll arrive with about ${arrivalPct}% battery — skip the stop and enjoy the drive.`,
      `${mi} miles? That's a warm-up for your ${vehicleName(vehicle)}. You'll roll in with ~${arrivalPct}% battery. Save the charging for another day.`,
      `Good news — your ${vehicleName(vehicle)} can do this ${mi}-mile trip on a single charge. You'll arrive with roughly ${arrivalPct}% left. More time for snacks at the destination.`,
      `No pit stop required! At ${mi} miles, your ${vehicleName(vehicle)} will arrive with about ${arrivalPct}% battery to spare. That's what we call range confidence.`,
    ];
    return {
      statusCode: 200,
      headers: HEADERS,
      body: JSON.stringify({
        noStopNeeded: true,
        noStopMessage: messages[Math.floor(Math.random() * messages.length)],
        totalDistanceMi: mi,
        arrivalPct
      })
    };
  }

  // ── Step 2: Find DC fast chargers via NREL AFDC ────────────────────────
  let chargers = [];
  try {
    const chargerPromises = routePoints.map(pt =>
      fetch(`https://developer.nrel.gov/api/alt-fuel-stations/v1/nearest.json?api_key=${NREL_API_KEY}&fuel_type=ELEC&ev_charging_level=dc_fast&latitude=${pt.lat}&longitude=${pt.lng}&radius=15&limit=5`)
        .then(r => r.json())
        .then(j => j.fuel_stations || [])
        .catch(() => [])
    );
    const results = await Promise.all(chargerPromises);
    const seen = new Set();
    const originLat = routeLegs[0].start_location.lat;
    const originLng = routeLegs[0].start_location.lng;

    results.flat().forEach(s => {
      const id = s.id;
      if (!id || seen.has(id)) return;
      seen.add(id);
      if (!s.latitude || !s.longitude) return;

      const distFromOrigin = haversine(originLat, originLng, s.latitude, s.longitude);
      const maxKw = s.ev_dc_fast_num ? (s.ev_connector_types?.includes("TESLA") ? 250 : 150) : 50;

      chargers.push({
        id,
        name: s.station_name || `Charger ${id}`,
        address: [s.street_address, s.city, s.state, s.zip].filter(Boolean).join(", "),
        lat: s.latitude,
        lng: s.longitude,
        network: s.ev_network || "Unknown network",
        kw: maxKw,
        typicalMinutes: estimateMinutes(maxKw),
        distanceFromOriginMi: Math.round(distFromOrigin / 1609.344)
      });
    });

    // Sort by distance from origin and keep top 4
    chargers.sort((a, b) => a.distanceFromOriginMi - b.distanceFromOriginMi);
    chargers = chargers.slice(0, 4);
  } catch (e) {
    return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: `Charger search failed: ${e.message}` }) };
  }

  if (!chargers.length) {
    return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ chargers: [], totalDistanceMi: Math.round(totalDistanceMeters / 1609.344) }) };
  }

  // ── Step 3: Grade each charger (Places + Claude Haiku) ────────────────
  const graded = await Promise.all(chargers.map(c => gradeCharger(c, travellerType, vehicle)));

  return {
    statusCode: 200,
    headers: HEADERS,
    body: JSON.stringify({
      chargers: graded,
      totalDistanceMi: Math.round(totalDistanceMeters / 1609.344)
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

function vehicleName(key) {
  const names = {
    tesla_model_y_lr: "Tesla Model Y Long Range",
    tesla_model_y_sr: "Tesla Model Y",
    tesla_model_3_lr: "Tesla Model 3 Long Range",
    tesla_model_3_sr: "Tesla Model 3",
    tesla_cybertruck: "Cybertruck",
    rivian_r1t: "R1T",
    rivian_r1s: "R1S",
    ford_mach_e: "Mach-E",
    ford_f150_lightning: "F-150 Lightning",
    chevy_equinox_ev: "Equinox EV",
    chevy_blazer_ev: "Blazer EV",
    hyundai_ioniq_5: "Ioniq 5",
    hyundai_ioniq_6: "Ioniq 6",
    kia_ev6: "EV6",
    kia_ev9: "EV9",
    bmw_ix: "iX",
    mercedes_eqs: "EQS",
    vw_id4: "ID.4",
    porsche_taycan: "Taycan",
    lucid_air: "Lucid Air",
    cadillac_lyriq: "Lyriq",
    polestar_2: "Polestar 2",
    nissan_ariya: "Ariya",
  };
  return names[key] || "EV";
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
