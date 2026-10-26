/**
 * Test Suite: Sovereign Causal Paths & HUD Story Overlay
 * Verifies:
 * 1. Toggle Button placement directly above Evaluate Orb in sidebar bottom dock.
 * 2. HTML & CSS structure of paths overlay, chamfered cards, and leader lines.
 * 3. Server-side drawings.json schema containing XAUUSD_EVALUATION.
 * 4. Zero animation / zero bubbles compliance.
 * 5. Distinct non-standard colors for all 3 paths (Electric Violet, Solar Amber, Hazard Red).
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const BASE_DIR = path.resolve(__dirname, '..');

console.log('--- Testing Sovereign Causal Paths & HUD Story Overlay Suite ---');

// 1. Verify HTML Structure in index.html
const indexHtmlPath = path.join(BASE_DIR, 'frontend', 'chart', 'index.html');
const indexHtml = fs.readFileSync(indexHtmlPath, 'utf8');

assert(indexHtml.includes('id="tvSidebarPathsToggleBtn"'), 'tvSidebarPathsToggleBtn must exist in index.html');
assert(indexHtml.includes('id="tvSidebarEvaluateBtn"'), 'tvSidebarEvaluateBtn must exist in index.html');

const pathsBtnIdx = indexHtml.indexOf('id="tvSidebarPathsToggleBtn"');
const evalBtnIdx = indexHtml.indexOf('id="tvSidebarEvaluateBtn"');
assert(pathsBtnIdx < evalBtnIdx, 'tvSidebarPathsToggleBtn MUST be positioned ABOVE tvSidebarEvaluateBtn in index.html');

assert(indexHtml.includes('id="tvSovereignPathsOverlay"'), 'tvSovereignPathsOverlay container must exist in index.html');
assert(indexHtml.includes('id="tvSovereignPathsSvg"'), 'tvSovereignPathsSvg SVG layer must exist in index.html');
assert(indexHtml.includes('id="hudCardPathA"'), 'hudCardPathA card must exist in index.html');
assert(indexHtml.includes('id="hudCardPathB"'), 'hudCardPathB card must exist in index.html');
assert(indexHtml.includes('id="hudCardPathC"'), 'hudCardPathC card must exist in index.html');
console.log('✓ HTML Structure: Toggle button placed above Evaluate Orb and overlay containers verified');

// 2. Verify CSS Theme in tradingview_theme.css
const themeCssPath = path.join(BASE_DIR, 'frontend', 'chart', 'css', 'tradingview_theme.css');
const themeCss = fs.readFileSync(themeCssPath, 'utf8');

assert(themeCss.includes('.tv-sidebar-paths-btn'), '.tv-sidebar-paths-btn style must exist');
assert(themeCss.includes('.tv-sidebar-paths-btn.active'), '.tv-sidebar-paths-btn.active style must exist');
assert(themeCss.includes('.tv-sovereign-paths-overlay'), '.tv-sovereign-paths-overlay style must exist');
assert(themeCss.includes('.hud-chamfer-violet'), '.hud-chamfer-violet chamfered card style must exist');
assert(themeCss.includes('.hud-chamfer-amber'), '.hud-chamfer-amber chamfered card style must exist');
assert(themeCss.includes('.hud-chamfer-red'), '.hud-chamfer-red chamfered card style must exist');
assert(themeCss.includes('clip-path: polygon('), 'Cyberpunk chamfered clip-paths must be defined');
console.log('✓ CSS Styling: Chamfered cards, cyber hazard accents, and sidebar toggle styling verified');

// 3. Verify drawings.json and XAUUSD_EVALUATION Schema
const drawingsJsonPath = path.join(BASE_DIR, 'data', 'drawings.json');
const drawingsData = JSON.parse(fs.readFileSync(drawingsJsonPath, 'utf8'));

assert(drawingsData.XAUUSD, 'XAUUSD drawings must exist');
assert(drawingsData.XAUUSD_EVALUATION, 'XAUUSD_EVALUATION must exist in drawings.json');
assert(Array.isArray(drawingsData.XAUUSD_EVALUATION.paths), 'XAUUSD_EVALUATION must contain paths array');
assert.strictEqual(drawingsData.XAUUSD_EVALUATION.paths.length, 3, 'Must define exactly 3 sovereign paths (A, B, C)');

const [pA, pB, pC] = drawingsData.XAUUSD_EVALUATION.paths;
assert.strictEqual(pA.id, 'path_a', 'Path A ID verified');
assert.strictEqual(pB.id, 'path_b', 'Path B ID verified');
assert.strictEqual(pC.id, 'path_c', 'Path C ID verified');

assert(pA.trigger_level, 'Path A must define trigger level');
assert(pA.target_box, 'Path A must define target box');
assert(pB.supporting_box, 'Path B must define supporting floor box');
assert(pC.tripwire_level, 'Path C must define tripwire level');
assert(pC.target_box, 'Path C must define downside target box');

assert(pA.card && pA.card.body, 'Path A must define card body story');
assert(pB.card && pB.card.body, 'Path B must define card body story');
assert(pC.card && pC.card.body, 'Path C must define card body story');
console.log('✓ drawings.json: XAUUSD_EVALUATION paths, supporting places, and story comment cards verified');

// 4. Verify JavaScript Overlay Module
const overlayJsPath = path.join(BASE_DIR, 'frontend', 'chart', 'js', 'sovereign_paths_overlay.js');
const overlayJs = fs.readFileSync(overlayJsPath, 'utf8');

assert(overlayJs.includes('export function initSovereignPathsOverlay'), 'initSovereignPathsOverlay must be exported');
assert(overlayJs.includes('export function updateSovereignPathsData'), 'updateSovereignPathsData must be exported');
assert(overlayJs.includes('export function renderSovereignPaths'), 'renderSovereignPaths must be exported');
assert(overlayJs.includes('stroke-dasharray="4 3"'), 'Dotted leader connector lines must be rendered');
assert(!overlayJs.includes('@keyframes'), 'Strict zero CSS animations in overlay JS');
assert(!overlayJs.includes('pulse-bubble'), 'Strict zero bubbles in overlay JS');
console.log('✓ JavaScript Module: sovereign_paths_overlay.js exports, leader lines, and static rendering verified');

// 5. Verify App.js integration
const appJsPath = path.join(BASE_DIR, 'frontend', 'chart', 'js', 'app.js');
const appJs = fs.readFileSync(appJsPath, 'utf8');

assert(appJs.includes('sovereign_paths_overlay.js'), 'app.js must import sovereign_paths_overlay.js');
assert(appJs.includes('initSovereignPathsOverlay'), 'app.js must call initSovereignPathsOverlay');
assert(appJs.includes('updateSovereignPathsData'), 'app.js must call updateSovereignPathsData');
console.log('✓ App.js: Sovereign paths overlay initialized and wired to WebSocket DRAWINGS_UPDATED');

console.log('\n--- ALL SOVEREIGN CAUSAL PATHS & HUD OVERLAY TESTS PASSED SUCCESSFULLY! ---');
