// Unit test for 4+ Boxes Dynamic Oscilloscope, Comparative Findings Matrix, and Studio Maximize
const fs = require('fs');
const assert = require('assert');

console.log('--- Testing 4+ Boxes Dynamic Oscilloscope & Studio Maximize ---');

// 1. Verify frontend/chart/index.html
const indexHtml = fs.readFileSync('frontend/chart/index.html', 'utf8');
assert.ok(indexHtml.includes('id="tvNexusOscSvgBox"'), 'tvNexusOscSvgBox container must exist in index.html');
assert.ok(indexHtml.includes('id="tvNexusEvrSvgBox"'), 'tvNexusEvrSvgBox container must exist in index.html');
assert.ok(indexHtml.includes('id="tvNexusMaxTable"'), 'tvNexusMaxTable container must exist in index.html');
assert.ok(indexHtml.includes('id="tvNexusStudioToggleBtn"'), 'tvNexusStudioToggleBtn must exist in index.html');
assert.ok(indexHtml.includes('window.__toggleNexusMaximized'), 'Toggle maximize must be bound in index.html');

// 2. Verify frontend/chart/css/tradingview_theme.css
const cssContent = fs.readFileSync('frontend/chart/css/tradingview_theme.css', 'utf8');
assert.ok(cssContent.includes('.tv-nexus-chamfer-frame.tv-nexus-maximized'), '.tv-nexus-maximized styling must exist in CSS');
assert.ok(cssContent.includes('.tv-nexus-max-btn'), '.tv-nexus-max-btn styles must exist in CSS');

// 3. Verify tv_chart_engine.js
const engineCode = fs.readFileSync('frontend/chart/js/tv_chart_engine.js', 'utf8');

// Ensure BOX_PALETTE supports at least 6 boxes
assert.ok(engineCode.includes('BOX_PALETTE'), 'BOX_PALETTE must be defined for multi-box styling');

// Ensure dynamic Box 4+ element creation exists for Delta chart
assert.ok(engineCode.includes('tvNexusOscLineBox${idx + 1}'), 'Dynamic Delta line path creation for N boxes must exist');
assert.ok(engineCode.includes('tvNexusCalloutBox${idx + 1}'), 'Dynamic Delta callout creation for N boxes must exist');

// Ensure dynamic Box 4+ element creation exists for EVR chart
assert.ok(engineCode.includes('tvNexusEvrLineBox${idx + 1}'), 'Dynamic EVR line path creation for N boxes must exist');
assert.ok(engineCode.includes('tvNexusEvrCalloutBox${idx + 1}'), 'Dynamic EVR callout creation for N boxes must exist');

// Ensure Multi-Box Comparative Findings Matrix generator exists
assert.ok(engineCode.includes('window.__renderNexusMaxTable'), 'window.__renderNexusMaxTable must be defined');
assert.ok(engineCode.includes('MULTI-BOX COMPARATIVE FINDINGS MATRIX'), 'Matrix table header must be generated');
assert.ok(engineCode.includes('AUTHENTIC STRUCTURAL FINDING'), 'Matrix table must have findings column');

// Ensure Maximize Studio toggle function exists
assert.ok(engineCode.includes('window.__toggleNexusMaximized'), 'window.__toggleNexusMaximized must be defined');

console.log('✓ All 4+ Boxes & Studio Maximize assertions PASSED successfully!');
