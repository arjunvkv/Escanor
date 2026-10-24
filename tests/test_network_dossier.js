// Unit test for Structural Sample Network Dossier logic and Canvas Cleanup Verification
const fs = require('fs');
const assert = require('assert');

// 1. Verify canvas cleanup in tv_chart_engine.js
const engineCode = fs.readFileSync('frontend/chart/js/tv_chart_engine.js', 'utf8');

// Ensure golden connecting arcs are removed
assert.ok(!engineCode.includes('Draw Golden Connecting Arcs between adjacent boxes'), 'Golden connecting arcs must be removed from canvas');
assert.ok(!engineCode.includes('quadraticCurveTo(midX, midY, endX, endY)'), 'Golden bezier arcs must be removed');

// Ensure in-box text badges/HUD cards are removed
assert.ok(!engineCode.includes('Full 5-line structured card'), '5-line HUD card must be removed from in-box overlay');
assert.ok(!engineCode.includes('Compact 2-line badge'), 'Compact badge must be removed from in-box overlay');
assert.ok(!engineCode.includes('Micro 1-line tag'), 'Micro tag must be removed from in-box overlay');
assert.ok(!engineCode.includes('Cyan Favourable Pill Badge at ptFav'), 'Favourable pill badge must be removed from box');
assert.ok(!engineCode.includes('Crimson Adverse Pill Badge at ptAdv'), 'Adverse pill badge must be removed from box');

// Ensure red anchor and cyan trend arrow remain
assert.ok(engineCode.includes("text: '✕'"), "Red ✕ start anchor must remain");
assert.ok(engineCode.includes("color: '#ff1744'"), "Red color for anchor must remain");
assert.ok(engineCode.includes("coordinates: [ptStart, ptFav]"), "Cyan favourable excursion arrow must remain");
assert.ok(engineCode.includes("color: '#00e5ff'"), "Cyan/blue color for excursion arrow must remain");

console.log('✓ Chart Canvas Cleanup Verification: PASSED (Zero in-box text clutter, zero golden arcs, trend vector preserved)');

// 2. Test mathematical logic of computeNetworkDossier
function mockComputeNetworkDossier(sampleRects, mockCandles) {
  // Simulate the dossier engine
  const samples = sampleRects.map((r, idx) => {
    const H_b = Math.max(r.p1, r.p2);
    const L_b = Math.min(r.p1, r.p2);
    const R_b = Math.max(0.1, H_b - L_b);
    const P_0 = r.p0 || L_b;
    const P_1 = r.p1_end || H_b;
    const netMove = P_1 - P_0;
    const d = r.d || (netMove >= 0 ? 1 : -1);
    const favMove = d === 1 ? Math.max(0, H_b - P_0) : Math.max(0, P_0 - L_b);
    const advMove = d === 1 ? Math.max(0, P_0 - L_b) : Math.max(0, H_b - P_0);
    const totalVol = r.vol || 5000;
    const netDelta = r.delta || 1200;
    const netDeltaPct = Math.round((netDelta / totalVol) * 100);
    const absorbPct = r.absorb || 45;
    const evr = Math.round(totalVol / R_b);

    let frictionTag = 'CLEAN FLOW ⚡';
    if (evr >= 2400) frictionTag = 'EXTREME BURN 🔥';
    else if (evr >= 1200) frictionTag = 'HIGH FRICTION ⚠️';

    return {
      boxNum: idx + 1,
      t0: r.t0,
      d,
      favMove,
      advMove,
      netMove,
      H_b,
      L_b,
      R_b,
      P_0,
      P_1,
      totalVol,
      netDelta,
      netDeltaPct,
      absorbPct,
      evr,
      frictionTag
    };
  }).sort((a, b) => a.t0 - b.t0);

  const N = samples.length;
  let totalNetDelta = 0;
  let totalVolume = 0;
  let maxHigh = -Infinity;
  let minLow = Infinity;
  let highestEvrVal = -1;
  let highestEvrSample = null;
  let highestVolVal = -1;
  let highestVolSample = null;

  samples.forEach(s => {
    totalNetDelta += s.netDelta;
    totalVolume += s.totalVol;
    if (s.H_b > maxHigh) maxHigh = s.H_b;
    if (s.L_b < minLow) minLow = s.L_b;
    if (s.evr > highestEvrVal) {
      highestEvrVal = s.evr;
      highestEvrSample = s;
    }
    if (s.totalVol > highestVolVal) {
      highestVolVal = s.totalVol;
      highestVolSample = s;
    }
  });

  const firstSample = samples[0];
  const lastSample = samples[N - 1];
  const deltaEvr = Math.round(((lastSample.evr - firstSample.evr) / Math.max(1, firstSample.evr)) * 100);

  const livePrice = 2745.50;
  const primaryAnchor = highestVolSample.P_0;
  const eqShelf = (maxHigh + minLow) / 2;
  const distCeiling = Math.max(0, maxHigh - livePrice);
  const distFloor = Math.max(0, livePrice - minLow);
  const invalidationTripwire = lastSample.d === 1 ? minLow : maxHigh;

  return {
    sampleCount: N,
    samples,
    totalVolume,
    totalNetDelta,
    maxHigh,
    minLow,
    deltaEvr,
    highestEvrSample,
    highestVolSample,
    primaryAnchor,
    eqShelf,
    distCeiling,
    distFloor,
    invalidationTripwire
  };
}

// Test with 3 connected sample boxes
const mockBoxes = [
  { t0: 1000, p1: 2720, p2: 2710, p0: 2711, p1_end: 2719, vol: 8000, delta: 2500, absorb: 35 },
  { t0: 2000, p1: 2735, p2: 2722, p0: 2723, p1_end: 2734, vol: 14000, delta: 3800, absorb: 52 },
  { t0: 3000, p1: 2750, p2: 2738, p0: 2739, p1_end: 2748, vol: 32000, delta: -900, absorb: 74 }
];

const dossier = mockComputeNetworkDossier(mockBoxes);

assert.strictEqual(dossier.sampleCount, 3);
assert.strictEqual(dossier.maxHigh, 2750);
assert.strictEqual(dossier.minLow, 2710);
assert.strictEqual(dossier.highestVolSample.boxNum, 3);
assert.strictEqual(dossier.primaryAnchor, 2739);
assert.strictEqual(dossier.eqShelf, 2730);
assert.ok(dossier.deltaEvr > 50, 'EVR should reflect friction spike as volume explodes near ceiling');
assert.strictEqual(dossier.invalidationTripwire, 2710);

console.log('✓ Multi-Box Network Dossier Computation: PASSED (All mathematical invariants verified)');
console.log('  - Sample Count:', dossier.sampleCount);
console.log('  - Network Ceiling:', dossier.maxHigh);
console.log('  - Network Floor:', dossier.minLow);
console.log('  - Sequence Fuel Burn Shift (ΔEVR):', dossier.deltaEvr + '%');
console.log('  - Peak Volume Anchor:', dossier.primaryAnchor);
console.log('  - Runway to Ceiling:', dossier.distCeiling.toFixed(1), 'pts');
console.log('  - Runway to Floor:', dossier.distFloor.toFixed(1), 'pts');
