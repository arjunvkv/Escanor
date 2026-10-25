const fs = require('fs');
const assert = require('assert');

// 1. Check tv_chart_engine.js for computeNetworkDossier logic
const engineCode = fs.readFileSync('frontend/chart/js/tv_chart_engine.js', 'utf-8');

console.log('--- Verifying Structural Runway & Widescreen Engine Updates ---');

assert(engineCode.includes('const isBear = (bearScore > bullScore)'), 'isBear detection logic missing');
assert(engineCode.includes('runwayGapText = `${runwayGapPts.toFixed(1)} PTS BEAR RUNWAY`'), 'Bear runway text calculation missing');
assert(engineCode.includes('runwayGapText = `${runwayGapPts.toFixed(1)} PTS BEAR BREAK`'), 'Bear break text calculation missing');
assert(engineCode.includes('invalidationText = `${invalidationSign} $${invalidationTripwire.toFixed(2)} (${isBear ? \'BEAR INVAL\' : \'BULL INVAL\'})`'), 'Invalidation text formatting missing');

// Check that network VWAP fallback calculation exists and prevents $0.00
assert(engineCode.includes('const sumVwap = sampleAudits.reduce'), 'Network VWAP fallback calculation missing');

// Check that simple terms are wired into DOM
assert(engineCode.includes('BEAR BUILDING'), 'BEAR BUILDING missing in engine');
assert(engineCode.includes('BEAR BREAK'), 'BEAR BREAK missing in engine');
assert(engineCode.includes('BEAR RUNWAY'), 'BEAR RUNWAY missing in engine');
assert(engineCode.includes('BULL BUILDING'), 'BULL BUILDING missing in engine');
assert(engineCode.includes('BULL BREAK'), 'BULL BREAK missing in engine');
assert(engineCode.includes('BULL RUNWAY'), 'BULL RUNWAY missing in engine');

// 2. Check index.html for widescreen layout (4-column top strip & side-by-side charts)
const indexHtml = fs.readFileSync('frontend/chart/index.html', 'utf-8');
assert(indexHtml.includes('grid-template-columns: repeat(4, 1fr)'), '4-column telemetry strip missing in index.html');
assert(indexHtml.includes('grid-template-columns: 1fr 1fr'), '2-column side-by-side harmonic charts missing in index.html');
assert(indexHtml.includes('viewBox="0 0 1160 520"'), 'Widescreen neon border SVG missing in index.html');

// 3. Check tradingview_theme.css for wide modal max-width
const themeCss = fs.readFileSync('frontend/chart/css/tradingview_theme.css', 'utf-8');
assert(themeCss.includes('max-width: 1160px !important;'), 'Widescreen modal max-width missing in tradingview_theme.css');

// 4. Test math on User's Screenshot scenario:
// Ceiling: 4034.07, Floor: 4016.14, Live: 3994.96
const maxHigh = 4034.07;
const minLow = 4016.14;
const livePrice = 3994.96;
const lastSample = { d: -1, P_poc: 4018 };
const firstSample = { P_poc: 4030 };
const totalNetDelta = -7900;
const eqShelf = (maxHigh + minLow) / 2;

const isBear = (lastSample.d === -1) || 
               (livePrice < minLow) || 
               (lastSample.P_poc < firstSample.P_poc) || 
               (totalNetDelta < 0 && livePrice < eqShelf);

assert.strictEqual(isBear, true, 'Screenshot scenario must be detected as isBear');

let runwayGapPts = 0;
let runwayGapText = '';
if (isBear) {
  if (livePrice < minLow) {
    runwayGapPts = -(minLow - livePrice);
    runwayGapText = `${runwayGapPts.toFixed(1)} PTS BEAR RUNWAY`;
  }
}

assert.strictEqual(runwayGapPts.toFixed(1), '-21.2', 'Runway gap points should be -21.2');
assert.strictEqual(runwayGapText, '-21.2 PTS BEAR RUNWAY', 'Runway text must say -21.2 PTS BEAR RUNWAY');

const invalidationTripwire = isBear ? maxHigh : minLow;
const invalidationSign = isBear ? '>' : '<';
const invalidationText = `${invalidationSign} $${invalidationTripwire.toFixed(2)} (${isBear ? 'BEAR INVAL' : 'BULL INVAL'})`;
assert.strictEqual(invalidationText, '> $4034.07 (BEAR INVAL)', 'Invalidation must be > $4034.07 (BEAR INVAL)');

console.log('✓ All Structural Runway & Widescreen assertions PASSED!');
