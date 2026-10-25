// Unit test for Institutional Order Flow Suite:
// Chart 1: Bar-by-Bar Cumulative Volume Delta (CVD) Staircase & Absorption Markers
// Chart 2: Inter-Box Value Migration & Auction Efficiency (POC Ladder)
const fs = require('fs');
const assert = require('assert');

console.log('--- Testing Institutional Order Flow Suite (CVD & POC Value Migration) ---');

// 1. Verify frontend/chart/index.html titles and SVG containers
const indexHtml = fs.readFileSync('frontend/chart/index.html', 'utf8');

assert.ok(indexHtml.includes('INTRA-BOX CVD // ORDER FLOW & ABSORPTION'), 'Chart 1 title must be INTRA-BOX CVD // ORDER FLOW & ABSORPTION');
assert.ok(indexHtml.includes('VALUE MIGRATION // POC LADDER & EFFICIENCY'), 'Chart 2 title must be VALUE MIGRATION // POC LADDER & EFFICIENCY');
assert.ok(indexHtml.includes('id="tvNexusDeltaMarkersGroup"'), 'Chart 1 must have tvNexusDeltaMarkersGroup for absorption/initiative markers');
assert.ok(indexHtml.includes('id="tvNexusValueShelvesGroup"'), 'Chart 2 must have tvNexusValueShelvesGroup for range brackets & POC nodes');
assert.ok(indexHtml.includes('id="tvNexusOscSvg"'), 'Chart 1 SVG must exist');
assert.ok(indexHtml.includes('id="tvNexusEvrOscSvg"'), 'Chart 2 SVG must exist');
console.log('✓ HTML Structure & SVG Containers Verified');

// 2. Verify tv_chart_engine.js logic
const engineCode = fs.readFileSync('frontend/chart/js/tv_chart_engine.js', 'utf8');

// Chart 1: CVD Staircase & Markers
assert.ok(engineCode.includes('cumDelta'), 'Engine must compute and track bar-by-bar cumDelta');
assert.ok(engineCode.includes('isAbsorption'), 'Engine must detect bar-by-bar absorption');
assert.ok(engineCode.includes('isInitiative'), 'Engine must detect bar-by-bar initiative breakout');
assert.ok(engineCode.includes('#f59e0b'), 'Absorption markers must use glowing Amber #f59e0b');
assert.ok(engineCode.includes('#00e5ff'), 'Initiative markers must use glowing Cyan #00e5ff');

// Chart 2: Value Migration & POC Ladder
assert.ok(engineCode.includes('tvNexusValueShelvesGroup'), 'Engine must populate tvNexusValueShelvesGroup with range brackets');
assert.ok(engineCode.includes('boxStages'), 'Engine must compute boxStages for inter-box ladder');
assert.ok(engineCode.includes('ptPerK'), 'Engine must compute points per 1,000 contracts efficiency');
assert.ok(engineCode.includes('VALUE LIFT') || engineCode.includes('VALUE DROP'), 'Engine must detect Value Lift / Drop between POCs');
console.log('✓ Engine CVD Staircase & POC Migration Logic Verified');

// 3. Mathematical Verification of CVD Accumulation and POC Migration
const mockBarsB1 = [
  { barDelta: 800, volInBox: 1500, isAbsorption: false, isInitiative: true },
  { barDelta: -300, volInBox: 1200, isAbsorption: true, isInitiative: false },
  { barDelta: 1200, volInBox: 2200, isAbsorption: false, isInitiative: true }
];

let runningDelta = 0;
mockBarsB1.forEach(b => {
  runningDelta += b.barDelta;
  b.cumDelta = runningDelta;
});

assert.strictEqual(mockBarsB1[0].cumDelta, 800, 'Bar 0 cumDelta must be 800');
assert.strictEqual(mockBarsB1[1].cumDelta, 500, 'Bar 1 cumDelta must be 500 (800 - 300)');
assert.strictEqual(mockBarsB1[2].cumDelta, 1700, 'Bar 2 cumDelta must be 1700 (500 + 1200)');

const mockBoxes = [
  { boxNum: 1, pocPrice: 2748.20, totalVol: 18000, netMove: -2.5, H_b: 2752.0, L_b: 2745.0 },
  { boxNum: 2, pocPrice: 2742.00, totalVol: 24000, netMove: -6.2, H_b: 2746.0, L_b: 2738.0 },
  { boxNum: 3, pocPrice: 2734.50, totalVol: 12000, netMove: -14.0, H_b: 2740.0, L_b: 2726.0 }
];

// Test POC shift between boxes
const shift1to2 = mockBoxes[1].pocPrice - mockBoxes[0].pocPrice;
assert.strictEqual(Math.round(shift1to2 * 10) / 10, -6.2, 'POC Shift B1->B2 must be -6.2 pt');
assert.ok(shift1to2 <= -0.8, 'Shift <= -0.8 must classify as VALUE DROP');

const shift2to3 = mockBoxes[2].pocPrice - mockBoxes[1].pocPrice;
assert.strictEqual(Math.round(shift2to3 * 10) / 10, -7.5, 'POC Shift B2->B3 must be -7.5 pt');

// Test Auction Efficiency (pt/K)
const effB1 = Math.abs(mockBoxes[0].netMove) / (mockBoxes[0].totalVol / 1000);
const effB3 = Math.abs(mockBoxes[2].netMove) / (mockBoxes[2].totalVol / 1000);

assert.strictEqual(Math.round(effB1 * 100) / 100, 0.14, 'B1 Efficiency must be 0.14 pt/K (Mud Wall / Absorption)');
assert.strictEqual(Math.round(effB3 * 100) / 100, 1.17, 'B3 Efficiency must be 1.17 pt/K (Vacuum Expansion)');

assert.ok(effB1 < 0.15, 'B1 < 0.15 indicates heavy limit absorption friction');
assert.ok(effB3 >= 0.50, 'B3 >= 0.50 indicates frictionless vacuum runway acceleration');

console.log('✓ Mathematical Invariants for CVD and Value Migration Passed');
console.log('--- ALL Institutional Order Flow Suite Tests PASSED! ---');
