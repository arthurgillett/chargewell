const GOOGLE_API_KEY    = process.env.GOOGLE_API_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const NREL_API_KEY      = process.env.NREL_API_KEY || "DEMO_KEY";

// Realistic highway range at 75mph (miles)
const VEHICLE_RANGE_MI = {
  tesla_model_y_lr: 240, tesla_model_y_sr: 200, tesla_model_3_lr: 260, tesla_model_3_sr: 210,
  tesla_cybertruck: 230, rivian_r1t: 220, rivian_r1s: 225, ford_mach_e: 210,
  ford_f150_lightning: 180, chevy_equinox_ev: 245, chevy_blazer_ev: 220,
  hyundai_ioniq_5: 230, hyundai_ioniq_6: 260, kia_ev6: 240, kia_ev9: 210,
  bmw_ix: 250, mercedes_eqs: 280, vw_id4: 210, porsche_taycan: 200,
  lucid_air: 375, cadillac_lyriq: 240, polestar_2: 210, nissan_ariya: 230,
};

// Usable battery capacity in kWh (approximate, for charging time calc)
const VEHICLE_BATTERY_KWH = {
  tesla_model_y_lr: 75, tesla_model_y_sr: 60, tesla_model_3_lr: 75, tesla_model_3_sr: 60,
  tesla_cybertruck: 123, rivian_r1t: 135, rivian_r1s: 135, ford_mach_e: 91,
  ford_f150_lightning: 131, chevy_equinox_ev: 85, chevy_blazer_ev: 102,
  hyundai_ioniq_5: 77, hyundai_ioniq_6: 77, kia_ev6: 77, kia_ev9: 100,
  bmw_ix: 105, mercedes_eqs: 108, vw_id4: 82, porsche_taycan: 84,
  lucid_air: 112, cadillac_lyriq: 102, polestar_2: 78, nissan_ariya: 87,
};

const MAX_CHARGE_RATE_KW = 140;

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

  // ── Step 0: Resolve vague locations via Geocoding ─────────────────────
  let resolvedOrigin = origin;
  let resolvedDest = destination;
  try {
    const [ro, rd] = await Promise.all([
      resolveLocation(origin),
      resolveLocation(destination)
    ]);
    resolvedOrigin = ro;
    resolvedDest = rd;
  } catch (e) {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: `Could not resolve locations: ${e.message}` }) };
  }

  // ── Step 1: Get route from Google Directions ──────────────────────────
  let routePoints = [];
  let totalDistanceMeters = 0;
  let totalDurationSeconds = 0;
  let routeLegs, routePolyline;
  try {
    const dirUrl = `https://maps.googleapis.com/maps/api/directions/json?origin=${encodeURIComponent(resolvedOrigin)}&destination=${encodeURIComponent(resolvedDest)}&key=${GOOGLE_API_KEY}`;
    const dirRes = await fetch(dirUrl);
    const dirJson = await dirRes.json();
    if (!dirJson.routes?.length) {
      throw new Error(`${dirJson.status || "UNKNOWN"}: ${dirJson.error_message || "No routes returned. Try a more specific address."}`);
    }
    const route = dirJson.routes[0];
    routeLegs = route.legs;
    routePolyline = route.overview_polyline?.points || "";
    totalDistanceMeters = route.legs.reduce((sum, leg) => sum + leg.distance.value, 0);
    totalDurationSeconds = route.legs.reduce((sum, leg) => sum + leg.duration.value, 0);
    routePoints = sampleRoutePoints(route, 20000);
  } catch (e) {
    return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: `Directions failed: ${e.message}` }) };
  }

  const rangeMi = VEHICLE_RANGE_MI[vehicle] || 210;
  const batteryKwh = VEHICLE_BATTERY_KWH[vehicle] || 75;
  const totalDistanceMi = totalDistanceMeters / 1609.344;
  const totalMi = Math.round(totalDistanceMi);
  const totalDriveMinutes = Math.round(totalDurationSeconds / 60);
  const arrivalPct = Math.round((1 - totalDistanceMi / rangeMi) * 100);

  // ── Check if trip is within range (arrive with 20%+ battery) ──────────
  if (arrivalPct >= 20) {
    const mi = Math.round(totalDistanceMi);
    const messages = [
      `Your ${vehicleName(vehicle)} eats ${mi} miles for breakfast. You'll arrive with about ${arrivalPct}% battery — skip the stop and enjoy the drive.`,
      `${mi} miles? That's a warm-up for your ${vehicleName(vehicle)}. You'll roll in with ~${arrivalPct}% battery. Save the charging for another day.`,
      `Good news — your ${vehicleName(vehicle)} can do this ${mi}-mile trip on a single charge. You'll arrive with roughly ${arrivalPct}% left. More time for snacks at the destination.`,
      `No pit stop required! At ${mi} miles, your ${vehicleName(vehicle)} will arrive with about ${arrivalPct}% battery to spare. That's what we call range confidence.`,
    ];

    // Check if a round trip would need charging
    const roundTripMi = mi * 2;
    const roundTripArrival = Math.round((1 - roundTripMi / rangeMi) * 100);
    let roundTripStop = null;

    if (roundTripArrival < 15) {
      // Need a charge for the return — find chargers near the destination (last third of route)
      const destPoints = routePoints.slice(Math.max(0, routePoints.length - 3));
      if (destPoints.length === 0 && routeLegs.length) {
        const lastLeg = routeLegs[routeLegs.length - 1];
        destPoints.push({ lat: lastLeg.end_location.lat, lng: lastLeg.end_location.lng });
      }
      try {
        const nearDestPromises = destPoints.map(pt =>
          fetch(`https://developer.nrel.gov/api/alt-fuel-stations/v1/nearest.json?api_key=${NREL_API_KEY}&fuel_type=ELEC&ev_charging_level=dc_fast&latitude=${pt.lat}&longitude=${pt.lng}&radius=25&limit=3`)
            .then(r => r.json()).then(j => j.fuel_stations || []).catch(() => [])
        );
        const nearResults = await Promise.all(nearDestPromises);
        const seen = new Set();
        const nearChargers = [];
        nearResults.flat().forEach(s => {
          if (!s.id || seen.has(s.id) || !s.latitude || !s.longitude) return;
          seen.add(s.id);
          nearChargers.push({
            id: s.id,
            name: s.station_name || `Charger ${s.id}`,
            address: [s.street_address, s.city, s.state, s.zip].filter(Boolean).join(", "),
            lat: s.latitude, lng: s.longitude,
            network: s.ev_network || "Unknown",
            kw: Math.min(s.ev_dc_fast_num ? (s.ev_connector_types?.includes("TESLA") ? 250 : 150) : 50, 350),
          });
        });

        if (nearChargers.length) {
          // Pick the first one (closest to destination area)
          const charger = nearChargers[0];
          // Calculate how much charge is needed: after round trip you want 15%
          const batteryAfterReturn = 1 - roundTripMi / rangeMi;
          const chargeNeeded = Math.max(0, 0.15 - batteryAfterReturn); // get to at least 15%
          const kwhNeeded = chargeNeeded * batteryKwh;
          const effectiveKw = Math.min(MAX_CHARGE_RATE_KW, charger.kw);
          const chargeMinutes = Math.max(8, Math.round((kwhNeeded / effectiveKw) * 60));
          const homeArrivalPct = Math.round((batteryAfterReturn + chargeNeeded) * 100);

          roundTripStop = {
            ...charger,
            chargeMinutes,
            homeArrivalPct,
            message: `Grab ${chargeMinutes} minutes at ${charger.name.split(' - ')[0].split(',')[0]} on your way back — you'll get home with about ${homeArrivalPct}% battery.`
          };
        }
      } catch (e) { /* no round trip suggestion */ }
    }

    return {
      statusCode: 200, headers: HEADERS,
      body: JSON.stringify({
        noStopNeeded: true,
        noStopMessage: messages[Math.floor(Math.random() * messages.length)],
        totalDistanceMi: mi, arrivalPct, polyline: routePolyline, totalDriveMinutes,
        roundTripNeedsCharge: roundTripArrival < 15,
        roundTripStop
      })
    };
  }

  // ── Step 2: Find DC fast chargers via NREL AFDC ────────────────────────
  let chargers = [];
  try {
    // Query each sample point for nearby chargers
    const chargerPromises = routePoints.map(pt =>
      fetch(`https://developer.nrel.gov/api/alt-fuel-stations/v1/nearest.json?api_key=${NREL_API_KEY}&fuel_type=ELEC&ev_charging_level=dc_fast&latitude=${pt.lat}&longitude=${pt.lng}&radius=20&limit=6`)
        .then(r => r.json()).then(j => j.fuel_stations || []).catch(() => [])
    );
    const results = await Promise.all(chargerPromises);
    const seen = new Set();

    // Process per-sample-point so we can use the point's known route distance/time
    results.forEach((stations, ptIdx) => {
      const pt = routePoints[ptIdx];
      const ptRouteMi = Math.round(pt.routeDistMeters / 1609.344);
      const ptRouteMin = Math.round(pt.routeTimeSec / 60);

      stations.forEach(s => {
        const id = s.id;
        if (!id || seen.has(id)) return;
        seen.add(id);
        if (!s.latitude || !s.longitude) return;

        const maxKw = s.ev_dc_fast_num ? (s.ev_connector_types?.includes("TESLA") ? 250 : 150) : 50;

        // Use the sample point's route distance as the charger's approximate route distance
        // This is much more accurate than haversine from origin for curvy routes
        chargers.push({
          id, name: s.station_name || `Charger ${id}`,
          address: [s.street_address, s.city, s.state, s.zip].filter(Boolean).join(", "),
          lat: s.latitude, lng: s.longitude,
          network: s.ev_network || "Unknown network",
          kw: Math.min(maxKw, 350),
          distanceFromOriginMi: ptRouteMi,
          driveMinutesFromOrigin: ptRouteMin
        });
      });
    });

    chargers.sort((a, b) => a.distanceFromOriginMi - b.distanceFromOriginMi);

    // Filter out very early stops
    const minDriveMinutes = Math.min(45, totalDriveMinutes * 0.2);
    chargers = chargers.filter(c => c.driveMinutesFromOrigin >= minDriveMinutes);

    chargers = chargers.slice(0, 10);
  } catch (e) {
    return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: `Charger search failed: ${e.message}` }) };
  }

  if (!chargers.length) {
    return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ chargers: [], strategies: [], totalDistanceMi: totalMi, polyline: routePolyline, totalDriveMinutes }) };
  }

  // Charging times are calculated per-strategy below (depends on stop sequence)

  // ── Step 3: Detect thin coverage zones ────────────────────────────────
  const thinCoverageInfo = detectThinCoverage(chargers, totalMi);

  // ── Step 4: Grade chargers + generate strategies in parallel ──────────
  const [graded, strategies] = await Promise.all([
    Promise.all(chargers.map(c => gradeCharger(c, travellerType, vehicle, thinCoverageInfo))),
    generateStrategies(chargers, origin, destination, totalMi, rangeMi, totalDriveMinutes, batteryKwh, travellerType, vehicle)
  ]);

  const gradedById = {};
  graded.forEach(c => { gradedById[String(c.id)] = c; });

  // Build strategies with full stop data and timing
  const strategiesWithGrades = strategies.map(s => {
    const stops = (s.stopIds || []).map(id => gradedById[String(id)]).filter(Boolean);
    stops.sort((a, b) => a.distanceFromOriginMi - b.distanceFromOriginMi);
    const timing = calculateStrategyTiming(stops, totalDriveMinutes, totalMi, rangeMi, batteryKwh);
    return { ...s, stops, ...timing };
  });

  return {
    statusCode: 200, headers: HEADERS,
    body: JSON.stringify({
      chargers: graded,
      strategies: strategiesWithGrades,
      totalDistanceMi: totalMi,
      totalDriveMinutes,
      polyline: routePolyline,
      _debug: { rawStrategies: strategies.length, withGrades: strategiesWithGrades.length, chargerCount: chargers.length, haiku: generateStrategies._lastResponse || null }
    })
  };
};

// ── Charging time estimate ──────────────────────────────────────────────
// Simulates DC fast charging with realistic taper curve + 5 min overhead.
// prevStopMi = where we last charged (0 = origin), nextStopMi = where we need to reach
function estimateChargingMinutes(charger, rangeMi, batteryKwh, totalDistanceMi, prevStopMi, nextStopMi) {
  const milesSinceCharge = charger.distanceFromOriginMi - (prevStopMi || 0);
  const socAtArrival = Math.max(0.05, 1 - milesSinceCharge / rangeMi);

  const milesToNext = (nextStopMi || totalDistanceMi) - charger.distanceFromOriginMi;
  const socNeeded = (milesToNext / rangeMi) + 0.10;
  const targetSoc = Math.min(0.90, Math.max(socAtArrival, socNeeded));

  if (targetSoc <= socAtArrival) return 15; // minimum real-world stop

  // Simulate charging in 5% SoC increments with taper
  // Typical DC fast charge curve: full power up to ~50%, then taper
  const peakKw = Math.min(MAX_CHARGE_RATE_KW, charger.kw || 150);
  let totalMinutes = 0;
  let soc = socAtArrival;
  const step = 0.05; // 5% increments

  while (soc < targetSoc) {
    const nextSoc = Math.min(targetSoc, soc + step);
    const midSoc = (soc + nextSoc) / 2;

    // Taper: 100% of peak below 20%, then linear drop to 25% of peak at 100% SoC
    let rateMultiplier;
    if (midSoc <= 0.20) rateMultiplier = 1.0;
    else if (midSoc <= 0.50) rateMultiplier = 1.0 - 0.15 * ((midSoc - 0.20) / 0.30); // 1.0 → 0.85
    else if (midSoc <= 0.80) rateMultiplier = 0.85 - 0.40 * ((midSoc - 0.50) / 0.30); // 0.85 → 0.45
    else rateMultiplier = 0.45 - 0.20 * ((midSoc - 0.80) / 0.20); // 0.45 → 0.25

    const effectiveKw = peakKw * Math.max(0.20, rateMultiplier);
    const kwhForStep = (nextSoc - soc) * batteryKwh;
    totalMinutes += (kwhForStep / effectiveKw) * 60;
    soc = nextSoc;
  }

  // Add 5 min overhead (plug in, start session, unplug)
  return Math.max(15, Math.round(totalMinutes + 5));
}

// ── Strategy timing calculation ─────────────────────────────────────────
function calculateStrategyTiming(stops, totalDriveMinutes, totalMi, rangeMi, batteryKwh) {
  if (!stops.length) return { totalTripMinutes: totalDriveMinutes, totalChargingMinutes: 0, legs: [] };

  const legs = [];
  let prevMi = 0;
  let prevMinutes = 0;

  stops.forEach((stop, i) => {
    const nextStopMi = (i < stops.length - 1) ? stops[i + 1].distanceFromOriginMi : totalMi;
    const chargeMin = estimateChargingMinutes(stop, rangeMi, batteryKwh, totalMi, prevMi, nextStopMi);
    stop.chargingMinutes = chargeMin;

    const legDriveMin = stop.driveMinutesFromOrigin - prevMinutes;
    legs.push({
      type: "drive", label: i === 0 ? "Drive to first stop" : "Drive to next stop",
      minutes: Math.max(1, legDriveMin),
      miles: stop.distanceFromOriginMi - prevMi
    });
    legs.push({
      type: "charge", label: `Charge at ${stop.name.split(" - ")[0].split(",")[0]}`,
      minutes: chargeMin
    });
    prevMi = stop.distanceFromOriginMi;
    prevMinutes = stop.driveMinutesFromOrigin;
  });

  // Final leg to destination
  const finalDriveMin = totalDriveMinutes - prevMinutes;
  legs.push({
    type: "drive", label: "Drive to destination",
    minutes: Math.max(1, finalDriveMin),
    miles: totalMi - prevMi
  });

  const totalChargingMinutes = legs.filter(l => l.type === "charge").reduce((s, l) => s + l.minutes, 0);
  return {
    totalTripMinutes: totalDriveMinutes + totalChargingMinutes,
    totalChargingMinutes,
    legs
  };
}


// ── Thin coverage detection ─────────────────────────────────────────────
function detectThinCoverage(chargers, totalMi) {
  const gaps = [];
  for (let i = 0; i < chargers.length - 1; i++) {
    const gap = chargers[i + 1].distanceFromOriginMi - chargers[i].distanceFromOriginMi;
    if (gap > 60) gaps.push({ afterChargerId: chargers[i].id, gapMi: gap });
  }
  if (chargers.length > 0) {
    const lastGap = totalMi - chargers[chargers.length - 1].distanceFromOriginMi;
    if (lastGap > 60) gaps.push({ afterChargerId: chargers[chargers.length - 1].id, gapMi: lastGap });
  }
  return { gaps, lastReliableIds: new Set(gaps.map(g => g.afterChargerId)) };
}

// ── Strategy generation via Claude Haiku ─────────────────────────────────
async function generateStrategies(chargers, origin, destination, totalMi, rangeMi, totalDriveMinutes, batteryKwh, travellerType, vehicle) {
  const chargerSummary = chargers.map(c =>
    `id:${c.id} "${c.name}" at mile ${c.distanceFromOriginMi} (${c.driveMinutesFromOrigin}min drive), ${c.network}, ${c.kw}kW`
  ).join("\n");

  // Pre-validate: which chargers can be standalone (single-stop) options?
  // A single stop works if: origin→stop < rangeMi AND stop→destination < rangeMi (charging to ~85%)
  const maxLegAfterCharge = rangeMi * 0.85; // after charging to 85%
  const singleStopIds = chargers.filter(c =>
    c.distanceFromOriginMi < rangeMi * 0.95 && (totalMi - c.distanceFromOriginMi) < maxLegAfterCharge
  ).map(c => c.id);

  const prompt = `You are a route strategy planner for an EV road trip app.

Route: ${origin} → ${destination} (${totalMi} miles, ${totalDriveMinutes} min drive)
Vehicle: ${vehicleName(vehicle)} (${rangeMi} mi HIGHWAY range at 75mph — this is already reduced from EPA, use this number as the real max between charges)
Travellers: ${travellerType || "Family"}

Available DC fast chargers along route (already filtered — no very early stops):
${chargerSummary}

CRITICAL FEASIBILITY RULE: The driver starts at 100% and after each charge gets to about 85% (${Math.round(rangeMi * 0.85)} miles of range). EVERY leg must be shorter than the available range:
- Origin to first stop: must be under ${rangeMi} miles (starting at 100%)
- Between stops: must be under ${Math.round(rangeMi * 0.85)} miles (charged to ~85%)
- Last stop to destination: must be under ${Math.round(rangeMi * 0.85)} miles

${singleStopIds.length > 0 ? 'Chargers that work as single stops (feasible alone): ids ' + singleStopIds.join(', ') : 'No single charger can cover this trip alone — every option needs 2+ stops.'}

Propose 2-3 route options. Each option uses a DIFFERENT charger or set of chargers. The user wants to compare alternatives — these can be at similar distances but different chargers (e.g. a Tesla Supercharger at a mall vs a rest stop charger — very different experiences even in the same area).

Rules:
- Every option MUST pass the feasibility check above
- Two options CAN use chargers at the same distance — what matters is the STOPS are different
- Recommend the option with the best stop experience
- Use creative names that hint at the stop vibe
- Each needs a short tagline about the tradeoff
- Mark exactly one as recommended:true

Reply ONLY with a JSON array:
[
  {
    "name": "The Scenic Pause",
    "tagline": "One great stop, arrive easy",
    "emoji": "☀️",
    "recommended": true,
    "stopIds": [123]
  }
]`;

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 600, messages: [{ role: "user", content: prompt }] })
    });
    const json = await res.json();
    const text = json.content?.[0]?.text || "[]";
    // Store for debug
    generateStrategies._lastResponse = { type: json.type, error: json.error, textPreview: text.slice(0, 200) };
    const match = text.match(/\[[\s\S]*\]/);
    if (match) {
      const strategies = JSON.parse(match[0]);
      // Use string keys to avoid number/string mismatch between NREL IDs and Haiku output
      const validIds = new Set(chargers.map(c => String(c.id)));
      const chargerById = {};
      chargers.forEach(c => { chargerById[String(c.id)] = c; });

      // Normalize: Haiku sometimes returns "stops" instead of "stopIds"
      strategies.forEach(s => {
        if (!s.stopIds && Array.isArray(s.stops)) {
          // "stops" might be an array of IDs or objects with id fields
          s.stopIds = s.stops.map(st => typeof st === 'object' ? (st.id || st.stopId) : st).filter(Boolean);
        }
      });

      // Validate feasibility of each strategy
      const validated = strategies.filter(s => {
        if (!Array.isArray(s.stopIds) || !s.stopIds.length) {
          console.log('Strategy rejected (no stopIds):', s.name);
          return false;
        }
        if (!s.stopIds.every(id => validIds.has(String(id)))) {
          console.log('Strategy rejected (invalid IDs):', s.name, 'ids:', s.stopIds, 'valid:', [...validIds]);
          return false;
        }
        const stops = s.stopIds.map(id => chargerById[String(id)]).filter(Boolean).sort((a, b) => a.distanceFromOriginMi - b.distanceFromOriginMi);
        let prevMi = 0;
        let maxLeg = rangeMi;
        for (const stop of stops) {
          if (stop.distanceFromOriginMi - prevMi > maxLeg) {
            console.log('Strategy rejected (leg too long):', s.name, 'leg:', prevMi, '→', stop.distanceFromOriginMi, 'max:', maxLeg);
            return false;
          }
          prevMi = stop.distanceFromOriginMi;
          maxLeg = rangeMi * 0.85;
        }
        if (totalMi - prevMi > maxLeg) {
          console.log('Strategy rejected (final leg):', s.name, 'leg:', prevMi, '→', totalMi, 'max:', maxLeg);
          return false;
        }
        return true;
      });
      console.log('Strategies from Haiku:', strategies.length, 'validated:', validated.length);
      if (validated.length > 0) return validated;
      // If all failed validation, return them anyway with a warning — the feasibility
      // check may be too strict and it's better to show options than none
      console.log('All strategies failed validation — returning best effort');
      const bestEffort = strategies.filter(s => Array.isArray(s.stopIds) && s.stopIds.length > 0 && s.stopIds.every(id => validIds.has(id)));
      if (bestEffort.length > 0) return bestEffort;
    }
  } catch (e) {
    console.log('Strategy generation error:', e.message, e.stack);
  }

  // Fallback: build a feasible route from available chargers
  const fallbackStops = [];
  let prevMi = 0, maxLeg = rangeMi;
  for (const c of chargers) {
    if (c.distanceFromOriginMi - prevMi > maxLeg * 0.8) {
      fallbackStops.push(c.id);
      prevMi = c.distanceFromOriginMi;
      maxLeg = rangeMi * 0.85;
    }
  }
  if (!fallbackStops.length && chargers.length) fallbackStops.push(chargers[0].id);
  return [{ name: "The Route", tagline: "Best available stops", emoji: "⚡", recommended: true, stopIds: fallbackStops }];
}

async function gradeCharger(charger, travellerType, vehicle, thinCoverageInfo) {
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

  let grade = { score: 50, scoreWord: "Decent", food: null, coffee: null, outdoors: null, kids: null, caveat: null, foodTier: "chain" };
  try {
    const prompt = `You're helping a family decide if an EV charging stop is worth their time. Grade this stop honestly — a great stop makes the whole trip better, a bad one is just dead time.

Charger: ${charger.name} · ${charger.network} · ${charger.kw}kW
Travellers: ${travellerType || "Family with kids"}
Nearby places within walking distance (750m): ${JSON.stringify(places)}

Think about what it's actually like to stop here for 20-30 minutes with ${travellerType || "a family"}. Is there somewhere genuinely good to eat, not just a drive-through? Can the kids run around? Is there a coffee shop worth walking to, or just gas station coffee? Can the dog stretch its legs somewhere green?

Write like a knowledgeable friend giving honest advice, not a review aggregator. Be specific about what's there. If there's nothing good, say so — don't dress up a highway rest stop.

Food descriptions:
- If there's a real local restaurant or bakery: name it, say what makes it worth stopping for. E.g. "Rosie's Diner — great breakfast spot, known for homemade pies. Worth the walk."
- If it's decent chains: just name them honestly. E.g. "Panera and Chipotle — solid enough for a quick bite."
- If it's just fast food: say so plainly. E.g. "Just Burger King and a gas station."

For kids: only mention genuinely kid-friendly things (playgrounds, parks, open space) — a fast food restaurant is not a kids' amenity.
For outdoors/dogs: only mention if there's actual green space, a park, or a trail nearby. A parking lot doesn't count.

Reply ONLY with JSON:
{
  "score": <0-100>,
  "scoreWord": <"Wonderful"|"Great stop"|"Decent"|"Basic">,
  "food": "<honest readable description of best food options within walking distance, or null if nothing notable>",
  "coffee": "<specific coffee option if there's a real cafe, or null — don't mention gas station coffee>",
  "outdoors": "<specific park, trail, or green space if walkable, or null>",
  "kids": "<specific playground, park, or kid-friendly spot if walkable, or null — not restaurants>",
  "caveat": "<one honest sentence about the main downside, or null>",
  "foodTier": <"local"|"mid"|"chain">
}
Scoring guide: 85-100 exceptional (local gems + outdoor space), 70-84 genuinely good (a real find nearby), 55-69 decent (walkable chains, somewhere to sit), 40-54 bare minimum (fast food only), 0-39 nothing worth mentioning.`;

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 450, messages: [{ role: "user", content: prompt }] })
    });
    const json = await res.json();
    const text = json.content?.[0]?.text || "{}";
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) grade = JSON.parse(jsonMatch[0]);
  } catch (e) { /* use default */ }

  return { ...charger, ...grade, lastReliable: thinCoverageInfo.lastReliableIds.has(charger.id) };
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
    tesla_model_y_lr: "Tesla Model Y Long Range", tesla_model_y_sr: "Tesla Model Y",
    tesla_model_3_lr: "Tesla Model 3 Long Range", tesla_model_3_sr: "Tesla Model 3",
    tesla_cybertruck: "Cybertruck", rivian_r1t: "R1T", rivian_r1s: "R1S",
    ford_mach_e: "Mach-E", ford_f150_lightning: "F-150 Lightning",
    chevy_equinox_ev: "Equinox EV", chevy_blazer_ev: "Blazer EV",
    hyundai_ioniq_5: "Ioniq 5", hyundai_ioniq_6: "Ioniq 6", kia_ev6: "EV6", kia_ev9: "EV9",
    bmw_ix: "iX", mercedes_eqs: "EQS", vw_id4: "ID.4", porsche_taycan: "Taycan",
    lucid_air: "Lucid Air", cadillac_lyriq: "Lyriq", polestar_2: "Polestar 2", nissan_ariya: "Ariya",
  };
  return names[key] || "EV";
}

// Resolve locations that Directions can't route to directly.
// Uses Places Find Place to turn vague regions into specific addresses.
async function resolveLocation(input) {
  if (!input) throw new Error("Empty location");

  // Raw lat,lng — use directly (Directions handles these fine)
  if (/^-?\d+\.\d+\s*,\s*-?\d+\.\d+$/.test(input.trim())) return input.trim();

  // Try Places Find Place to get a specific routable location
  try {
    const url = `https://maps.googleapis.com/maps/api/place/findplacefromtext/json?input=${encodeURIComponent(input)}&inputtype=textquery&fields=formatted_address,geometry&key=${GOOGLE_API_KEY}`;
    const res = await fetch(url);
    const json = await res.json();
    if (json.candidates && json.candidates.length > 0) {
      const c = json.candidates[0];
      // If we got a formatted address, use it — more specific than the input
      if (c.formatted_address) return c.formatted_address;
      // Otherwise use the lat/lng
      if (c.geometry?.location) return `${c.geometry.location.lat},${c.geometry.location.lng}`;
    }
  } catch (e) { /* fall through to original input */ }

  return input;
}

function sampleRoutePoints(route, intervalMeters) {
  const points = [];
  let accumulated = 0;
  let totalDist = 0;
  let totalTime = 0;
  for (const leg of route.legs) {
    for (const step of leg.steps) {
      totalDist += step.distance.value;
      totalTime += step.duration.value;
      accumulated += step.distance.value;
      if (accumulated >= intervalMeters) {
        points.push({
          lat: step.end_location.lat,
          lng: step.end_location.lng,
          routeDistMeters: totalDist,
          routeTimeSec: totalTime
        });
        accumulated = 0;
      }
    }
  }
  return points;
}
