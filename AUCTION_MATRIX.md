# ⚡ AUCTION MATRIX: SOVEREIGN OPERATIONAL MANUAL
**The Definitive Architecture & Field Manual for the Escanor Multi-Box Auction Engine**

---

## 1. THE SOVEREIGN PURPOSE: WHAT THIS ENGINE WAS BUILT FOR

The Escanor Box Engine is **NOT** a cosmetic charting ornament, nor is it a generic support/resistance rectangle drawer. 

It is an **Auction Market Theory (AMT) & Wyckoff Effort-vs-Result (EVR) Structural Engine**. It was engineered to mathematically quantify the **physics of market auctions** by dissecting price discovery into distinct chronological phases, measuring whether institutional capital is accelerating through liquidity vacuums or exhausting into passive limit absorption walls.

### The Core Paradigm:
In classic technical analysis, traders look at price candles in isolation. In Sovereign Auction Analysis:
1. **Volume is Effort.** The number of contracts/lots expended over a defined duration.
2. **Range is Result.** The vertical distance ($ points) the market traversed as a result of that expenditure.
3. **EVR is Efficiency.** $\text{EVR} = \frac{\text{Total Volume}}{\text{Price Range}} \text{ (Contracts per Point)}$.
4. **CVD is Aggression.** Cumulative Volume Delta measures whether buyers or sellers are lifting asks or hitting bids.

When properly utilized, the Auction Matrix answers three sovereign questions:
- *Did this move take massive effort to achieve minimal progress?* (Absorption / Trapped Liquidity / Climax).
- *Did this move slice through price with low effort?* (Liquidity Vacuum / Initiative Aggression).
- *Where is value accepted vs where is price rejected?* (High Volume Shelves / Point of Control).

---

## 2. THE DUAL-LAYER RULE: CHART CANVAS VS DEEP DOSSIER

To keep the live visual interface pristine, razor-sharp, and institutional while preserving forensic analytical depth, the system operates on a strict **Two-Layer Separation**:

```
┌────────────────────────────────────────────────────────────────────────┐
│                        LAYER 1: LIVE CHART CANVAS                      │
│  • Auction Phase Boxes (Clean boundaries, distinct chronological waves)│
│  • Visual In-Box Vectors: Red ✕ Start Anchor, Cyan Trend Ray, +pts Yield│
│  • Scenario Forecast Vectors: Causal Paths (Path A, B, C)              │
│  • Tactical Scenario Cards (HUD float cards at the live edge)          │
│  • Optional Inflection Lines (Ceiling, 50% Eq, VWAP, POC Anchor, Floor)│
└────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                   LAYER 2: DEEP TEXT ANALYSIS DOSSIER                  │
│  • Latest Live Macro News Wires (Real yields, DXY, Geopolitical flows) │
│  • Box-by-Box Perspectives:                                            │
│      - Highest Volume Node (POC / Peak Volume Shelf) of each box       │
│      - Value Area High (VAH) & Value Area Low (VAL) of each box        │
│      - Derived Support & Resistance coordinates for each box           │
│      - Effort-vs-Result (EVR) & Friction classification                │
│  • Combined Composite Volume Profile across all active boxes           │
│  • Cumulative Volume Delta (CVD) & Trapped Trader Physics              │
│  • Sovereign Living Tape Reaction & Invalidation Tripwires             │
└────────────────────────────────────────────────────────────────────────┘
```

> **Mandate**: Deep structural lines (POCs, VAH/VAL shelves, individual S/R zones) do **NOT** clutter the chart canvas. They are computed mathematically and reported in the textual dossier report. The chart remains clean, showing only the active boxes, their vectors, and causal paths.

---

## 3. UNRESTRICTED BOX COUNT: SCALING TO MARKET REALITY

The engine is **NOT** limited to 3 boxes. It supports any dynamic number of boxes ($N = 2, 3, 4, 5+$) dictated strictly by the natural rhythm of the market session.

Each box must encapsulate **one single, non-overlapping chronological market wave**:

```
  Wave Phase 1              Wave Phase 2              Wave Phase 3              Wave Phase 4
┌──────────────────┐      ┌──────────────────┐      ┌──────────────────┐      ┌──────────────────┐
│ Capitulation &   │ ───► │ Initiative       │ ───► │ Climax High &    │ ───► │ Re-Accumulation  │
│ Liquidity Sweep  │      │ Squeeze Breakout │      │ Absorption Wall  │      │ Compression Coil │
└──────────────────┘      └──────────────────┘      └──────────────────┘      └──────────────────┘
  [t0 → t1]                 [t1 → t2]                 [t2 → t3]                 [t3 → t4 (Live)]
```

### The Cardinal Rule of Box Construction:
- **NEVER** stretch a box across hours of unrelated market action. Horizontally stretching a box over 25+ bars across multiple swings artificially inflates volume (e.g. 20,000 contracts over a tiny 3-point strip), triggering a false `+3000% FRICTION SPIKE`.
- **ALWAYS** bound the box tightly from the exact start time ($t_0$) and initial price ($P_0$) of a structural swing to its exact completion time ($t_1$) and terminal price ($P_1$).
- **Box IDs**: Never prefix custom auction boxes with `sov_` (which suppresses the in-box vector). Use standard structural IDs: `box_phase_1_...`, `box_phase_2_...`, `box_phase_3_...`, etc.

---

## 4. ENGINE MATHEMATICS & METRICS CHEAT SHEET

### A. In-Box Visual Excursion Vector
When properly bounded, the chart engine automatically computes:
1. **Red ✕ Start Anchor**: Drawn precisely at $(t_0, P_0)$ where the phase began.
2. **Cyan Diagonal Excursion Vector (`#00e5ff`)**: Traced from $(t_0, P_0)$ to the peak or trough $(t_{\text{peak}}, P_{\text{peak}})$ or $(t_{\text{trough}}, P_{\text{trough}})$.
3. **Numeric Yield Badge**: Floating coordinate badge displaying the exact favourable excursion points (e.g. `+37.9`).

### B. Effort-vs-Result (EVR) Classifications
Calculated as:
$$\text{EVR} = \frac{\text{Total Traded Volume}}{\max(0.1, \text{High}_b - \text{Low}_b)}$$

- **$\text{EVR} < 1,200 \text{ v/pt}$ $\rightarrow$ `CLEAN FLOW ⚡` (Cyan/Bullish)**
  - Price is gliding effortlessly through a liquidity vacuum. Low volume moves the market substantial distances. Trend continuation is highly probable.
- **$1,200 \le \text{EVR} < 2,400 \text{ v/pt}$ $\rightarrow$ `HIGH FRICTION ⚠️` (Warm Amber)**
  - Significant two-way trading. Volume is building relative to price range. Caution warranted.
- **$\text{EVR} \ge 2,400 \text{ v/pt}$ $\rightarrow$ `EXTREME BURN 🔥` (Crimson/Bearish)**
  - Massive contract turnover with negligible price displacement. Aggressive market orders are being absorbed by passive institutional limit orders. Imminent reversal or exhaustion.

### C. Sequence Shift ($\Delta\text{EVR}$)
Measures how friction is evolving across consecutive boxes from Box 1 to Box $N$:
$$\Delta\text{EVR} = \frac{\text{EVR}_N - \text{EVR}_1}{\max(1, \text{EVR}_1)} \times 100\%$$

- **$\Delta\text{EVR} < -30\%$ $\rightarrow$ `VACUUM ACCELERATION ⚡`**: Market entered an air pocket; initiative buyers/sellers took total control.
- **$\Delta\text{EVR} > +40\%$ $\rightarrow$ `FRICTION SPIKE 🔥`**: Market hit an institutional roadblock; heavy absorbing friction entered.
- **$-30\% \le \Delta\text{EVR} \le +40\%$ $\rightarrow$ `SUSTAINED FLOW ⚖️`**: Balanced auction progression.

---

## 5. THE 5 STRUCTURAL INFLECTION LINES (`SHOW LINES ON CHART`)

The system features an on-demand structural overlay toggled via the interactive modal or Card 3 (`tvToggleInflectionLinesBtn`):

| Line Name | Visual Style | Color | Sovereign Calculation |
| :--- | :--- | :--- | :--- |
| **🧱 CEILING** | Dashed (2px) | `#ef4444` Crimson Red | $\max(\text{High}_1, \dots, \text{High}_N)$ across all drawn boxes. The terminal liquidity barrier. |
| **⚖️ 50% EQ** | Dashed (2px) | `#fbbf24` Warm Yellow | $\frac{\text{Ceiling} + \text{Floor}}{2}$. The fair-value equilibrium dividing premium from discount. |
| **🌊 NET VWAP** | Dashed (2px) | `#3b82f6` Royal Blue | $\frac{\sum (\text{Typical Price} \times \text{Volume})}{\sum \text{Volume}}$ across all bars inside active boxes. |
| **🎯 ANCHOR** | Solid (2px) | `#00e5ff` Electric Cyan | The single price coordinate with the highest total volume turnover (Network POC). |
| **🛡️ FLOOR** | Dashed (2px) | `#10b981` Emerald Green | $\min(\text{Low}_1, \dots, \text{Low}_N)$ across all drawn boxes. The base absorption support. |

---

## 6. COMPLETE EVALUATION WORKFLOW (THE 5-STEP PROTOCOL)

1. **Step 1: Ingest Live Telemetry**: Read `data/active_evaluation_view.json` and MT5 live tick. Identify current session bounds and recent swing extrema.
2. **Step 2: Identify Auction Waves**: Divide the session into $N$ distinct chronological phases (Flush/Absorption, Impulse, Ceiling Test, Compression Coil).
3. **Step 3: Forensic Mathematical Profiling (Python)**:
   - For each box: Calculate start/end time, price range, volume, EVR, POC (peak volume shelf), and VAH/VAL.
   - For composite network: Calculate combined volume profile, network POC, Net VWAP, and $\Delta\text{EVR}$.
4. **Step 4: Update Chart Overlay (`data/drawings.json`)**:
   - Write cleanly bounded boxes with standard IDs (`box_phase_1_...`).
   - Anchor Path A (Initiative Continuation), Path B (Inflection Retest & Rotation), and Path C (Failure/Breakdown) directly to the box boundaries and inflection levels.
   - Post to `/api/drawings`.
5. **Step 5: Deliver Sovereign Report**:
   - Synthesize live macro news, box perspectives (POCs & S/R), composite volume profile, and causal path trade triggers.

---

*Authored by Escanor Macro CIO & Structural Execution Arbiter*
