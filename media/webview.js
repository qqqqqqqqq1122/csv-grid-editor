"use strict";
(() => {
  // src/webview/features/theme.ts
  function isDarkTheme() {
    const cls = document.body.classList;
    return cls.contains("vscode-dark") || cls.contains("vscode-high-contrast");
  }
  function applyGridTheme() {
    const container = document.getElementById("grid-container");
    if (!container) return;
    container.classList.remove("ag-theme-alpine", "ag-theme-alpine-dark");
    container.classList.add(isDarkTheme() ? "ag-theme-alpine-dark" : "ag-theme-alpine");
  }
  function setupTheme() {
    applyGridTheme();
    new MutationObserver(applyGridTheme).observe(document.body, {
      attributes: true,
      attributeFilter: ["class"]
    });
  }

  // src/webview/state.ts
  var state = {
    currentDelimiter: ",",
    rawCsvText: "",
    data: [],
    undoStack: [],
    redoStack: [],
    gridApi: null,
    focusedCellColId: null,
    focusedCellRowIndex: null,
    isCellEditing: false,
    ZOOM_STEPS: [60, 70, 80, 90, 100, 110, 125, 150, 175, 200],
    zoomIndex: 4,
    isAutoFitted: false,
    // Column color mode — when on, every data column gets a distinct, theme-adaptive
    // background tint so columns are easier to tell apart. Persisted globally via
    // VS Code globalState (csvGridEditor.colorMode), exactly like zoomIndex, so the
    // toggle is remembered across every CSV file and every session. The actual
    // colors are pure CSS (features/color-mode.ts + media/webview.css). In-memory
    // mirror of the persisted flag.
    colorMode: false,
    autoFitCache: null,
    autoFitCacheZoom: -1,
    colTypes: [],
    profileOpen: false,
    profileDock: "right",
    findMatches: [],
    findMatchIndex: -1,
    currentPage: 0,
    // Freeze rows — the data rows pinned to the top of the grid as always-visible
    // references. Tracked by their array references within state.data (NOT by
    // index) so each freeze follows its row through inserts/deletes/sorts and
    // clears itself automatically when state.data is replaced (paging, undo/redo,
    // re-parse). Empty = no row frozen. Multiple rows can be frozen at once, e.g.
    // a multi-line header. See features/freeze-rows.ts.
    frozenRowRefs: [],
    // Hidden columns — set of 0-based data-column indices the user has hidden via
    // the column chooser. Re-applied in buildGrid (so visibility survives a grid
    // rebuild, e.g. paging) and cleared on column insert/delete since those shift
    // indices. In-memory only. See features/column-chooser.ts.
    hiddenCols: /* @__PURE__ */ new Set(),
    // Frozen columns — set of 0-based data-column indices pinned to the left. Held
    // in state (not only in AG Grid) so the freeze survives a buildGrid rebuild
    // (column insert/delete, delimiter change, paging) — buildGrid rebuilds the
    // column defs from scratch, which would otherwise drop the pinning. Re-applied
    // via colDef.pinned in builder.ts and index-remapped on column insert/delete.
    // See features/freeze-columns.ts.
    pinnedCols: /* @__PURE__ */ new Set(),
    // Duplicate detection
    // dupRowSet — set of original 1-based row indices (i.e. _origIndex values) that
    // appear more than once. Empty set means dup detection is currently OFF.
    dupRowSet: /* @__PURE__ */ new Set(),
    dupGroupCount: 0,
    dupShowOnly: false,
    // Snapshot of the current rowData taken when entering "show only duplicates"
    // so we can restore the original row order on dismiss without re-parsing.
    dupOriginalRowData: null
  };
  function getNumCols(rows) {
    let max = 0;
    for (let i = 0; i < rows.length; i++) {
      if (rows[i].length > max) max = rows[i].length;
    }
    return max;
  }

  // src/webview/utils/csv.ts
  function parseCsv(text, delimiter, trimFields = true) {
    const rows = [];
    let row = [];
    let field = "";
    let inQuotes = false;
    const finalize = (s) => trimFields ? s.trim() : s;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (inQuotes) {
        if (ch === '"') {
          if (i + 1 < text.length && text[i + 1] === '"') {
            field += '"';
            i++;
          } else {
            inQuotes = false;
          }
        } else {
          field += ch;
        }
      } else if (ch === '"') {
        inQuotes = true;
      } else if (ch === delimiter) {
        row.push(finalize(field));
        field = "";
      } else if (ch === "\r") {
      } else if (ch === "\n") {
        row.push(finalize(field));
        if (row.length > 0) rows.push(row);
        row = [];
        field = "";
      } else {
        field += ch;
      }
    }
    row.push(finalize(field));
    if (row.some((f) => f !== "")) rows.push(row);
    return rows;
  }
  function toCsv(rows, delimiter) {
    return rows.map(
      (row) => row.map((cell) => {
        const s = String(cell);
        if (s.includes(delimiter) || s.includes('"') || s.includes("\n") || s.includes("\r")) {
          return '"' + s.replace(/"/g, '""') + '"';
        }
        return s;
      }).join(delimiter)
    ).join("\n");
  }
  function tsvCell(value) {
    if (value.includes("	") || value.includes("\n") || value.includes("\r") || value.includes('"')) {
      return '"' + value.replace(/"/g, '""') + '"';
    }
    return value;
  }

  // src/webview/features/color-mode.ts
  var HUE_STYLE_ID = "cm-col-hues";
  var GOLDEN_ANGLE = 137.50776405003785;
  var START_HUE = 25;
  function persistColorMode() {
    vscodeApi.postMessage({ type: "colorModeChanged", colorMode: state.colorMode });
  }
  function updateButton() {
    document.getElementById("btn-colormode")?.classList.toggle("btn-active", state.colorMode);
  }
  function applyColorMode() {
    const container = document.getElementById("grid-container");
    if (!container) return;
    container.classList.toggle("cm-on", state.colorMode);
    let styleEl = document.getElementById(HUE_STYLE_ID);
    if (!state.colorMode) {
      styleEl?.remove();
      return;
    }
    if (!styleEl) {
      styleEl = document.createElement("style");
      styleEl.id = HUE_STYLE_ID;
      document.head.appendChild(styleEl);
    }
    const numCols = getNumCols(state.data);
    let css = "";
    for (let c = 0; c < numCols; c++) {
      const hue = ((START_HUE + c * GOLDEN_ANGLE) % 360).toFixed(2);
      css += `#grid-container.cm-on [col-id="col_${c}"]{--cm-h:${hue};}`;
    }
    styleEl.textContent = css;
  }
  function toggleColorMode() {
    state.colorMode = !state.colorMode;
    updateButton();
    applyColorMode();
    persistColorMode();
  }
  function setupColorMode() {
    state.colorMode = !!INITIAL_COLOR_MODE;
    updateButton();
    applyColorMode();
    document.getElementById("btn-colormode")?.addEventListener("click", toggleColorMode);
  }

  // src/webview/grid/refresh.ts
  function partitionFrozenRows(rowData) {
    if (state.frozenRowRefs.length === 0) return { body: rowData, pinnedTop: [] };
    const idxOf = /* @__PURE__ */ new Map();
    state.data.forEach((row, i) => idxOf.set(row, i));
    state.frozenRowRefs = state.frozenRowRefs.filter((r) => idxOf.has(r));
    if (state.frozenRowRefs.length === 0) return { body: rowData, pinnedTop: [] };
    const frozenOrigs = new Set(state.frozenRowRefs.map((r) => idxOf.get(r)));
    const byOrig = /* @__PURE__ */ new Map();
    const body = [];
    for (const row of rowData) {
      const oi = Number(row._origIndex);
      if (frozenOrigs.has(oi)) byOrig.set(oi, row);
      else body.push(row);
    }
    const pinnedTop = [];
    for (const r of state.frozenRowRefs) {
      const row = byOrig.get(idxOf.get(r));
      if (row) pinnedTop.push(row);
    }
    return { body, pinnedTop };
  }
  function syncColumnHeaders() {
    if (!state.gridApi) return;
    const header = state.data[0] ?? [];
    const defs = state.gridApi.getColumnDefs();
    if (!defs) return;
    let changed = false;
    for (const d of defs) {
      if (typeof d.field === "string" && d.field.indexOf("col_") === 0) {
        const ci = parseInt(d.field.slice(4), 10);
        const name = header[ci] ?? "";
        if (d.headerName !== name) {
          d.headerName = name;
          changed = true;
        }
      }
    }
    if (changed) {
      state.gridApi.setGridOption("columnDefs", defs);
      state.gridApi.refreshHeader();
    }
  }
  function refreshGrid() {
    if (!state.gridApi) return;
    state.autoFitCache = null;
    state.colTypes = [];
    const numCols = getNumCols(state.data);
    const bodyRows = state.data.slice(1);
    const rowData = bodyRows.map((row, i) => {
      const obj = { _origIndex: i + 1 };
      for (let c = 0; c < numCols; c++) obj["col_" + c] = row[c] ?? "";
      return obj;
    });
    const { body, pinnedTop } = partitionFrozenRows(rowData);
    state.gridApi.setGridOption("rowData", body);
    state.gridApi.setGridOption("pinnedTopRowData", pinnedTop);
    updateCountsDisplay();
    applyColorMode();
  }
  function updateCountsDisplay() {
    const infoEl = document.getElementById("info");
    const statusEl = document.getElementById("status");
    if (!infoEl && !statusEl) return;
    const totalRows = Math.max(0, state.data.length - 1);
    const cols = getNumCols(state.data);
    const filtered = !!state.gridApi?.isAnyFilterPresent?.();
    if (filtered && state.gridApi) {
      let displayed = 0;
      state.gridApi.forEachNodeAfterFilter(() => displayed++);
      displayed += state.frozenRowRefs.length;
      if (infoEl) infoEl.textContent = `${displayed} of ${totalRows} rows \xD7 ${cols} columns`;
      if (statusEl) statusEl.textContent = `${displayed} of ${totalRows} records (filtered)`;
    } else {
      if (infoEl) infoEl.textContent = `${totalRows} rows \xD7 ${cols} columns`;
      if (statusEl) statusEl.textContent = `${totalRows} records`;
    }
  }

  // src/webview/grid/column-type.ts
  function getColumnType(bodyRows, colIndex) {
    const sampleSize = Math.min(bodyRows.length, 100);
    let numCount = 0, intCount = 0, dateCount = 0, datetimeCount = 0, timeCount = 0, boolCount = 0, nonEmpty = 0;
    const dateRe = /^\d{4}[-/]\d{1,2}[-/]\d{1,2}$/;
    const datetimeRe = /^\d{4}[-/]\d{1,2}[-/]\d{1,2}[ T]\d{2}:\d{2}/;
    const timeRe = /^\d{1,2}:\d{2}(:\d{2})?$/;
    const boolSet = { "true": 1, "false": 1, "yes": 1, "no": 1 };
    for (let r2 = 0; r2 < sampleSize; r2++) {
      const val = bodyRows[r2]?.[colIndex] != null ? String(bodyRows[r2][colIndex]).trim() : "";
      if (!val) continue;
      nonEmpty++;
      const num = Number(val);
      if (!isNaN(num) && val !== "") {
        numCount++;
        if (Number.isInteger(num)) intCount++;
      }
      if (datetimeRe.test(val)) datetimeCount++;
      else if (dateRe.test(val)) dateCount++;
      else if (timeRe.test(val)) timeCount++;
      if (boolSet[val.toLowerCase()]) boolCount++;
    }
    if (nonEmpty === 0) return "string";
    const r = nonEmpty;
    if (datetimeCount / r > 0.8) return "datetime";
    if (dateCount / r > 0.8) return "date";
    if (timeCount / r > 0.8) return "time";
    if (boolCount / r > 0.8 && numCount / r < 0.5) return "boolean";
    if (numCount / r > 0.8) return intCount === numCount ? "integer" : "float";
    return "string";
  }
  function applyHeaderClass(colId, type) {
    const cell = document.querySelector(`.ag-header-cell[col-id="${colId}"]`);
    if (!cell) return;
    Array.from(cell.classList).filter((c) => c.startsWith("col-type-")).forEach((c) => cell.classList.remove(c));
    cell.classList.add("col-type-" + type);
  }
  var typeRecomputeTimer = null;
  function scheduleRecomputeColTypes() {
    if (typeRecomputeTimer !== null) clearTimeout(typeRecomputeTimer);
    typeRecomputeTimer = setTimeout(recomputeColTypes, 200);
  }
  function recomputeColTypes() {
    typeRecomputeTimer = null;
    if (!state.data || state.data.length < 2) return;
    const bodyRows = state.data.slice(1);
    const numCols = state.data[0]?.length ?? 0;
    let anyChanged = false;
    for (let c = 0; c < numCols; c++) {
      const newType = getColumnType(bodyRows, c);
      if (newType !== state.colTypes[c]) {
        state.colTypes[c] = newType;
        applyHeaderClass("col_" + c, newType);
        anyChanged = true;
      }
    }
    if (anyChanged) document.dispatchEvent(new CustomEvent("csv-col-types-changed"));
  }

  // src/webview/features/freeze-rows.ts
  function freezeRows(origIndices) {
    let added = false;
    for (const oi of origIndices) {
      const row = state.data[oi];
      if (row && !state.frozenRowRefs.includes(row)) {
        state.frozenRowRefs.push(row);
        added = true;
      }
    }
    if (added) refreshGrid();
  }
  function unfreezeRows(origIndices) {
    const drop = new Set(origIndices.map((oi) => state.data[oi]).filter(Boolean));
    if (drop.size === 0) return;
    const before = state.frozenRowRefs.length;
    state.frozenRowRefs = state.frozenRowRefs.filter((r) => !drop.has(r));
    if (state.frozenRowRefs.length !== before) refreshGrid();
  }
  function unfreezeRow(origIndex) {
    unfreezeRows([origIndex]);
  }
  function unfreezeAllRows() {
    if (state.frozenRowRefs.length === 0) return;
    state.frozenRowRefs = [];
    refreshGrid();
  }
  function frozenRowCount() {
    return state.frozenRowRefs.length;
  }
  function frozenRowPositions() {
    return state.frozenRowRefs.map((r) => state.data.indexOf(r)).filter((i) => i >= 0);
  }
  function reanchorFrozenRows(positions) {
    state.frozenRowRefs = positions.map((i) => state.data[i]).filter(Boolean);
  }

  // src/webview/features/duplicates.ts
  var HASH_SEP = "\0";
  function computeDuplicates() {
    const result = { rowSet: /* @__PURE__ */ new Set(), groupCount: 0, rowHash: /* @__PURE__ */ new Map() };
    const bodyRows = state.data.slice(1);
    if (bodyRows.length < 2) return result;
    const numCols = getNumCols(state.data);
    const hashToOrigs = /* @__PURE__ */ new Map();
    for (let i = 0; i < bodyRows.length; i++) {
      const row = bodyRows[i];
      let h = "";
      for (let c = 0; c < numCols; c++) {
        h += row[c] ?? "";
        if (c < numCols - 1) h += HASH_SEP;
      }
      const origIndex = i + 1;
      const bucket = hashToOrigs.get(h);
      if (bucket) {
        bucket.push(origIndex);
      } else {
        hashToOrigs.set(h, [origIndex]);
      }
    }
    for (const [hash, origs] of hashToOrigs) {
      if (origs.length > 1) {
        result.groupCount++;
        for (const o of origs) {
          result.rowSet.add(o);
          result.rowHash.set(o, hash);
        }
      }
    }
    return result;
  }
  function setBannerText(rowCount, groupCount) {
    const el = document.getElementById("dup-banner-text");
    if (!el) return;
    if (rowCount === 0) {
      el.textContent = "No duplicate rows found";
    } else {
      el.textContent = rowCount.toLocaleString() + " duplicate row" + (rowCount === 1 ? "" : "s") + " in " + groupCount.toLocaleString() + " group" + (groupCount === 1 ? "" : "s");
    }
  }
  function showBanner() {
    document.getElementById("dup-banner")?.classList.remove("hidden");
  }
  function hideBanner() {
    document.getElementById("dup-banner")?.classList.add("hidden");
  }
  function updateToggleButton() {
    const btn = document.getElementById("dup-only-toggle");
    if (!btn) return;
    btn.textContent = state.dupShowOnly ? "Show all rows" : "Show only duplicates";
    btn.classList.toggle("dup-banner-btn-active", state.dupShowOnly);
    btn.disabled = state.dupRowSet.size === 0;
  }
  function updateGridButton() {
    const btn = document.getElementById("btn-duplicates");
    btn?.classList.toggle("btn-active", state.dupRowSet.size > 0);
  }
  function refreshHighlights() {
    if (!state.gridApi) return;
    state.gridApi.refreshCells({ force: true });
  }
  function applyShowOnlyOrdering(rowHash) {
    if (!state.gridApi) return;
    const current = [];
    state.gridApi.forEachNode((n) => {
      if (n.data) current.push(n.data);
    });
    if (state.dupOriginalRowData === null) {
      state.dupOriginalRowData = current.slice();
    }
    const grouped = state.dupOriginalRowData.filter((d) => d._origIndex != null && state.dupRowSet.has(Number(d._origIndex))).slice().sort((a, b) => {
      const ha = rowHash.get(Number(a._origIndex)) ?? "";
      const hb = rowHash.get(Number(b._origIndex)) ?? "";
      if (ha < hb) return -1;
      if (ha > hb) return 1;
      return Number(a._origIndex) - Number(b._origIndex);
    });
    state.gridApi.setGridOption("rowData", grouped);
  }
  function restoreOriginalOrdering() {
    if (!state.gridApi || state.dupOriginalRowData === null) return;
    state.gridApi.setGridOption("rowData", state.dupOriginalRowData);
    state.dupOriginalRowData = null;
  }
  function runDetect() {
    if (!state.gridApi) return;
    if (state.dupRowSet.size > 0) {
      dismiss();
      return;
    }
    unfreezeAllRows();
    const { rowSet, groupCount, rowHash } = computeDuplicates();
    state.dupRowSet = rowSet;
    state.dupGroupCount = groupCount;
    state._dupRowHash = rowHash;
    setBannerText(rowSet.size, groupCount);
    showBanner();
    updateToggleButton();
    updateGridButton();
    refreshHighlights();
  }
  function toggleShowOnly() {
    if (!state.gridApi || state.dupRowSet.size === 0) return;
    state.dupShowOnly = !state.dupShowOnly;
    if (state.dupShowOnly) {
      const rowHash = state._dupRowHash ?? /* @__PURE__ */ new Map();
      applyShowOnlyOrdering(rowHash);
      state.gridApi.onFilterChanged();
    } else {
      restoreOriginalOrdering();
      state.gridApi.onFilterChanged();
    }
    updateToggleButton();
    refreshHighlights();
  }
  function dismiss() {
    const wasShowingOnly = state.dupShowOnly;
    state.dupRowSet = /* @__PURE__ */ new Set();
    state.dupGroupCount = 0;
    state.dupShowOnly = false;
    state._dupRowHash = null;
    if (wasShowingOnly) {
      restoreOriginalOrdering();
      state.gridApi?.onFilterChanged();
    }
    hideBanner();
    updateToggleButton();
    updateGridButton();
    refreshHighlights();
  }
  function setupDuplicates() {
    if (IS_CHUNKED) return;
    document.getElementById("btn-duplicates")?.addEventListener("click", runDetect);
    document.getElementById("dup-only-toggle")?.addEventListener("click", toggleShowOnly);
    document.getElementById("dup-dismiss")?.addEventListener("click", dismiss);
  }
  function resetDuplicatesState() {
    if (state.dupRowSet.size === 0 && !state.dupShowOnly) return;
    dismiss();
  }

  // src/webview/features/profile.ts
  var BADGE_TEXT = {
    integer: "123",
    float: "1.0",
    string: "abc",
    boolean: "T/F",
    date: "date",
    datetime: "dt",
    time: "time"
  };
  function fmtNum(n, dec) {
    if (n == null || isNaN(n)) return "\u2014";
    if (dec !== void 0) return (+n.toFixed(dec)).toLocaleString(void 0, { maximumFractionDigits: dec });
    return Number.isInteger(n) ? n.toLocaleString() : (+n.toFixed(4)).toLocaleString();
  }
  function fmtPct(n) {
    if (!n) return "0%";
    return n < 0.1 ? "<0.1%" : n.toFixed(1) + "%";
  }
  function computeProfile() {
    if (!state.data || state.data.length < 2) return [];
    const headerRow = state.data[0];
    const bodyRows = state.data.slice(1);
    const profiles = [];
    for (let c = 0; c < headerRow.length; c++) {
      const ct = state.colTypes[c] || "string";
      const values = [];
      let nullCount = 0;
      bodyRows.forEach((row) => {
        const v = row?.[c] != null ? String(row[c]).trim() : "";
        if (v === "") nullCount++;
        else values.push(v);
      });
      const total = bodyRows.length;
      const p = {
        name: headerRow[c] || `(col ${c + 1})`,
        type: ct,
        total,
        nullCount,
        nullPct: total > 0 ? nullCount / total * 100 : 0,
        uniqueCount: new Set(values).size
      };
      if (ct === "integer" || ct === "float") {
        const nums = values.map(Number).filter((n) => !isNaN(n));
        if (nums.length) {
          nums.sort((a, b) => a - b);
          p.min = nums[0];
          p.max = nums[nums.length - 1];
          p.mean = nums.reduce((s, n) => s + n, 0) / nums.length;
          p.median = nums.length % 2 === 0 ? (nums[nums.length / 2 - 1] + nums[nums.length / 2]) / 2 : nums[Math.floor(nums.length / 2)];
          const variance = nums.reduce((s, n) => s + Math.pow(n - p.mean, 2), 0) / nums.length;
          p.stdDev = Math.sqrt(variance);
        }
      } else if (ct === "string") {
        const lens = values.map((v) => v.length);
        if (lens.length) {
          p.minLen = Math.min(...lens);
          p.maxLen = Math.max(...lens);
          p.avgLen = lens.reduce((s, l) => s + l, 0) / lens.length;
        }
        const freq = {};
        values.forEach((v) => {
          freq[v] = (freq[v] || 0) + 1;
        });
        p.topValues = Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 5);
      } else if (ct === "boolean") {
        const T = { "true": 1, "yes": 1, "1": 1, "t": 1, "y": 1 };
        const F = { "false": 1, "no": 1, "0": 1, "f": 1, "n": 1 };
        let tc = 0, fc = 0;
        values.forEach((v) => {
          const lo = v.toLowerCase();
          if (T[lo]) tc++;
          else if (F[lo]) fc++;
        });
        p.trueCount = tc;
        p.falseCount = fc;
      } else if (ct === "date" || ct === "datetime") {
        const dates = values.map((v) => new Date(v)).filter((d) => !isNaN(d.getTime()));
        if (dates.length) {
          dates.sort((a, b) => a.getTime() - b.getTime());
          p.minDate = dates[0].toISOString().slice(0, 10);
          p.maxDate = dates[dates.length - 1].toISOString().slice(0, 10);
          p.rangeDays = Math.round((dates[dates.length - 1].getTime() - dates[0].getTime()) / 864e5);
        }
      }
      profiles.push(p);
    }
    return profiles;
  }
  function stat(label, value) {
    const d = document.createElement("div");
    d.className = "profile-stat";
    const l = document.createElement("div");
    l.className = "profile-stat-label";
    l.textContent = label;
    const v = document.createElement("div");
    v.className = "profile-stat-value";
    v.textContent = value;
    v.title = value;
    d.appendChild(l);
    d.appendChild(v);
    return d;
  }
  function makeProfileCard(p) {
    const card = document.createElement("div");
    card.className = "profile-card";
    const hdr = document.createElement("div");
    hdr.className = "profile-card-header";
    const badge = document.createElement("span");
    badge.className = "profile-type-badge type-" + p.type;
    badge.textContent = BADGE_TEXT[p.type] ?? "abc";
    const nameEl = document.createElement("span");
    nameEl.className = "profile-col-name";
    nameEl.textContent = p.name;
    nameEl.title = p.name;
    hdr.appendChild(badge);
    hdr.appendChild(nameEl);
    card.appendChild(hdr);
    const ov = document.createElement("div");
    ov.className = "profile-stat-grid";
    ov.appendChild(stat("Rows", p.total.toLocaleString()));
    ov.appendChild(stat("Unique", p.uniqueCount.toLocaleString()));
    ov.appendChild(stat("Nulls", p.nullCount.toLocaleString()));
    ov.appendChild(stat("Fill %", fmtPct(100 - p.nullPct)));
    card.appendChild(ov);
    if (p.nullCount > 0) {
      const track = document.createElement("div");
      track.className = "profile-null-bar-track";
      const fill = document.createElement("div");
      fill.className = "profile-null-bar-fill";
      fill.style.width = p.nullPct + "%";
      track.appendChild(fill);
      card.appendChild(track);
    }
    const hr = document.createElement("hr");
    hr.className = "profile-divider";
    card.appendChild(hr);
    if ((p.type === "integer" || p.type === "float") && p.min != null) {
      const isF = p.type === "float";
      const ng = document.createElement("div");
      ng.className = "profile-stat-grid";
      ng.appendChild(stat("Min", fmtNum(p.min, isF ? 4 : 0)));
      ng.appendChild(stat("Max", fmtNum(p.max, isF ? 4 : 0)));
      ng.appendChild(stat("Mean", fmtNum(p.mean, 2)));
      ng.appendChild(stat("Median", fmtNum(p.median, isF ? 2 : 0)));
      ng.appendChild(stat("Std Dev", fmtNum(p.stdDev, 2)));
      ng.appendChild(stat("Unique", p.uniqueCount.toLocaleString()));
      card.appendChild(ng);
    } else if (p.type === "string") {
      const sg = document.createElement("div");
      sg.className = "profile-stat-grid";
      if (p.minLen != null) {
        sg.appendChild(stat("Min len", p.minLen.toLocaleString()));
        sg.appendChild(stat("Max len", p.maxLen.toLocaleString()));
        sg.appendChild(stat("Avg len", fmtNum(p.avgLen, 1)));
      }
      card.appendChild(sg);
      if (p.topValues?.length) {
        const tvl = document.createElement("div");
        tvl.className = "profile-top-values-label";
        tvl.textContent = "Top Values";
        card.appendChild(tvl);
        const maxCnt = p.topValues[0][1];
        p.topValues.forEach(([val, cnt]) => {
          const row = document.createElement("div");
          row.className = "profile-top-val";
          const txt = document.createElement("span");
          txt.className = "profile-top-val-text";
          txt.textContent = val;
          txt.title = val;
          const bw = document.createElement("div");
          bw.className = "profile-top-val-bar-wrap";
          const bf = document.createElement("div");
          bf.className = "profile-top-val-bar";
          bf.style.width = cnt / maxCnt * 100 + "%";
          bw.appendChild(bf);
          const ce = document.createElement("span");
          ce.className = "profile-top-val-count";
          ce.textContent = cnt.toLocaleString();
          row.appendChild(txt);
          row.appendChild(bw);
          row.appendChild(ce);
          card.appendChild(row);
        });
      }
    } else if (p.type === "boolean") {
      const boolTotal = (p.trueCount ?? 0) + (p.falseCount ?? 0);
      const bg = document.createElement("div");
      bg.className = "profile-stat-grid";
      bg.appendChild(stat("True", `${p.trueCount?.toLocaleString()} (${fmtPct(boolTotal > 0 ? (p.trueCount ?? 0) / boolTotal * 100 : 0)})`));
      bg.appendChild(stat("False", `${p.falseCount?.toLocaleString()} (${fmtPct(boolTotal > 0 ? (p.falseCount ?? 0) / boolTotal * 100 : 0)})`));
      card.appendChild(bg);
      if (boolTotal > 0) {
        const bb = document.createElement("div");
        bb.className = "profile-bool-bar";
        const bt = document.createElement("div");
        bt.className = "profile-bool-true";
        bt.style.width = (p.trueCount ?? 0) / boolTotal * 100 + "%";
        const bf2 = document.createElement("div");
        bf2.className = "profile-bool-false";
        bf2.style.width = (p.falseCount ?? 0) / boolTotal * 100 + "%";
        bb.appendChild(bt);
        bb.appendChild(bf2);
        card.appendChild(bb);
        const leg = document.createElement("div");
        leg.className = "profile-bool-legend";
        ["True", "False"].forEach((lbl, i) => {
          const li = document.createElement("div");
          li.className = "profile-bool-legend-item";
          const dot = document.createElement("div");
          dot.className = "profile-bool-dot";
          dot.style.background = i === 0 ? "rgba(78,201,176,0.7)" : "rgba(244,135,113,0.7)";
          const lt = document.createElement("span");
          lt.textContent = lbl;
          lt.style.opacity = "0.7";
          li.appendChild(dot);
          li.appendChild(lt);
          leg.appendChild(li);
        });
        card.appendChild(leg);
      }
    } else if (p.type === "date" || p.type === "datetime") {
      const dg = document.createElement("div");
      dg.className = "profile-stat-grid";
      if (p.minDate) {
        dg.appendChild(stat("Earliest", p.minDate));
        dg.appendChild(stat("Latest", p.maxDate));
        dg.appendChild(stat("Range", p.rangeDays.toLocaleString() + " days"));
      }
      card.appendChild(dg);
    }
    return card;
  }
  function makeOverviewTable(profiles) {
    const wrap = document.createElement("div");
    wrap.className = "profile-overview";
    const titleEl = document.createElement("div");
    titleEl.className = "profile-overview-title";
    titleEl.textContent = "Overview \u2014 " + profiles.length + " columns";
    wrap.appendChild(titleEl);
    const scrollWrap = document.createElement("div");
    scrollWrap.className = "profile-ov-scroll";
    const tbl = document.createElement("table");
    tbl.className = "profile-ov-table";
    const thead = document.createElement("thead");
    const htr = document.createElement("tr");
    [
      { label: "#", right: false },
      { label: "COLUMN", right: false },
      { label: "TYPE", right: false },
      { label: "FILL", right: true },
      { label: "NULL%", right: true },
      { label: "DIST", right: true },
      { label: "MIN / MAX", right: false }
    ].forEach((col) => {
      const th = document.createElement("th");
      th.textContent = col.label;
      if (col.right) th.className = "ov-th-r";
      htr.appendChild(th);
    });
    thead.appendChild(htr);
    tbl.appendChild(thead);
    const tbody = document.createElement("tbody");
    profiles.forEach((p, i) => {
      const tr = document.createElement("tr");
      tr.className = "profile-ov-row";
      tr.title = "Click to jump to detail card";
      tr.addEventListener("click", () => {
        document.getElementById("profile-card-" + i)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
      });
      const tdI = document.createElement("td");
      tdI.textContent = String(i + 1);
      tr.appendChild(tdI);
      const tdC = document.createElement("td");
      const ns = document.createElement("span");
      ns.className = "ov-col-name";
      ns.textContent = p.name;
      ns.title = p.name;
      tdC.appendChild(ns);
      tr.appendChild(tdC);
      const tdT = document.createElement("td");
      const bdg = document.createElement("span");
      bdg.className = "profile-type-badge type-" + p.type;
      bdg.textContent = BADGE_TEXT[p.type] ?? "abc";
      tdT.appendChild(bdg);
      tr.appendChild(tdT);
      const tdF = document.createElement("td");
      tdF.className = "ov-r";
      tdF.textContent = (p.total - p.nullCount).toLocaleString();
      tr.appendChild(tdF);
      const tdN = document.createElement("td");
      const nullCl = document.createElement("div");
      nullCl.className = "ov-null-cell";
      if (p.nullCount > 0) {
        const track = document.createElement("div");
        track.className = "ov-null-bar-track";
        const fill = document.createElement("div");
        fill.className = "ov-null-bar-fill";
        fill.style.width = p.nullPct + "%";
        track.appendChild(fill);
        nullCl.appendChild(track);
      }
      const pctS = document.createElement("span");
      pctS.style.cssText = "min-width:24px;text-align:right;";
      pctS.textContent = fmtPct(p.nullPct);
      nullCl.appendChild(pctS);
      tdN.appendChild(nullCl);
      tr.appendChild(tdN);
      const tdD = document.createElement("td");
      tdD.className = "ov-r";
      tdD.textContent = p.uniqueCount.toLocaleString();
      tr.appendChild(tdD);
      const tdMM = document.createElement("td");
      const mmSpan = document.createElement("span");
      mmSpan.className = "ov-minmax";
      let mmText = "";
      if (p.type === "integer" && p.min != null) mmText = fmtNum(p.min, 0) + " \u2013 " + fmtNum(p.max, 0);
      else if (p.type === "float" && p.min != null) mmText = fmtNum(p.min, 2) + " \u2013 " + fmtNum(p.max, 2);
      else if ((p.type === "date" || p.type === "datetime") && p.minDate) mmText = p.minDate + " \u2013 " + p.maxDate;
      else if (p.type === "string" && p.minLen != null) mmText = "len " + p.minLen + "\u2013" + p.maxLen;
      else if (p.type === "boolean") mmText = "T / F";
      mmSpan.textContent = mmText;
      mmSpan.title = mmText;
      tdMM.appendChild(mmSpan);
      tr.appendChild(tdMM);
      tbody.appendChild(tr);
    });
    tbl.appendChild(tbody);
    scrollWrap.appendChild(tbl);
    wrap.appendChild(scrollWrap);
    return wrap;
  }
  var profileRenderTimer = null;
  function renderProfile() {
    const scroll = document.getElementById("profile-scroll");
    if (!scroll) return;
    if (profileRenderTimer !== null) clearTimeout(profileRenderTimer);
    scroll.innerHTML = '<div style="padding:6px 0;font-size:12px;opacity:0.5;">Computing\u2026</div>';
    profileRenderTimer = setTimeout(() => {
      profileRenderTimer = null;
      scroll.innerHTML = "";
      const profiles = computeProfile();
      if (!profiles.length) {
        scroll.innerHTML = '<div style="padding:6px 0;font-size:12px;opacity:0.5;">No data loaded</div>';
        return;
      }
      scroll.appendChild(makeOverviewTable(profiles));
      profiles.forEach((p, i) => {
        const card = makeProfileCard(p);
        card.id = "profile-card-" + i;
        scroll.appendChild(card);
      });
    }, 0);
  }
  function refreshProfileIfOpen() {
    if (state.profileOpen) renderProfile();
  }
  function applyDock(dock) {
    state.profileDock = dock;
    const contentRow = document.getElementById("content-row");
    const panel = document.getElementById("profile-panel");
    contentRow.classList.remove("profile-dock-left", "profile-dock-bottom");
    if (dock === "left") contentRow.classList.add("profile-dock-left");
    if (dock === "bottom") contentRow.classList.add("profile-dock-bottom");
    if (dock === "bottom") panel.style.width = "";
    else panel.style.height = "";
    document.querySelectorAll(".profile-dock-btn").forEach((btn) => {
      btn.classList.toggle("profile-dock-btn--active", btn.dataset.dock === dock);
    });
  }
  function setupResizeHandle() {
    const handle = document.getElementById("profile-resize-handle");
    const panel = document.getElementById("profile-panel");
    if (!handle || !panel) return;
    let dragging2 = false;
    let startPos = 0;
    let startSize = 0;
    handle.addEventListener("mousedown", (e) => {
      dragging2 = true;
      handle.classList.add("resizing");
      const dock = state.profileDock;
      startPos = dock === "bottom" ? e.clientY : e.clientX;
      startSize = dock === "bottom" ? panel.offsetHeight : panel.offsetWidth;
      document.body.style.userSelect = "none";
      document.body.style.cursor = dock === "bottom" ? "row-resize" : "col-resize";
      e.preventDefault();
    });
    document.addEventListener("mousemove", (e) => {
      if (!dragging2) return;
      const dock = state.profileDock;
      if (dock === "bottom") {
        const newH = Math.max(80, Math.min(startSize + (startPos - e.clientY), window.innerHeight - 120));
        panel.style.height = newH + "px";
      } else if (dock === "right") {
        const newW = Math.max(180, Math.min(startSize + (startPos - e.clientX), window.innerWidth - 250));
        panel.style.width = newW + "px";
      } else {
        const newW = Math.max(180, Math.min(startSize + (e.clientX - startPos), window.innerWidth - 250));
        panel.style.width = newW + "px";
      }
    });
    document.addEventListener("mouseup", () => {
      if (!dragging2) return;
      dragging2 = false;
      handle.classList.remove("resizing");
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
    });
  }
  function toggleProfile() {
    state.profileOpen = !state.profileOpen;
    document.getElementById("profile-panel")?.classList.toggle("open", state.profileOpen);
    document.getElementById("btn-profile")?.classList.toggle("btn-active", state.profileOpen);
    if (state.profileOpen) {
      applyDock(state.profileDock);
      renderProfile();
    } else {
      document.getElementById("content-row")?.classList.remove("profile-dock-left", "profile-dock-bottom");
    }
  }
  function setupProfile() {
    document.getElementById("btn-profile")?.addEventListener("click", toggleProfile);
    document.getElementById("btn-profile-close")?.addEventListener("click", () => {
      state.profileOpen = true;
      toggleProfile();
    });
    document.querySelectorAll(".profile-dock-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        if (btn.dataset.dock) applyDock(btn.dataset.dock);
      });
    });
    setupResizeHandle();
    document.addEventListener("csv-col-types-changed", () => {
      if (state.profileOpen) renderProfile();
    });
  }

  // src/webview/features/undo-redo.ts
  function snapshot() {
    return {
      data: JSON.parse(JSON.stringify(state.data)),
      frozenRowIdx: state.frozenRowRefs.map((r) => state.data.indexOf(r)).filter((i) => i >= 0),
      pinnedCols: [...state.pinnedCols]
    };
  }
  function restore(snap) {
    state.data = snap.data;
    state.frozenRowRefs = snap.frozenRowIdx.map((i) => state.data[i]).filter(Boolean);
    state.pinnedCols = new Set(snap.pinnedCols);
  }
  function pushUndo() {
    state.undoStack.push(snapshot());
    state.redoStack = [];
    state.autoFitCache = null;
    updateButtons();
  }
  function undo() {
    if (state.undoStack.length === 0) return;
    state.redoStack.push(snapshot());
    restore(state.undoStack.pop());
    refreshGrid();
    syncColumnHeaders();
    notifyChange();
    updateButtons();
    recomputeColTypes();
  }
  function redo() {
    if (state.redoStack.length === 0) return;
    state.undoStack.push(snapshot());
    restore(state.redoStack.pop());
    refreshGrid();
    syncColumnHeaders();
    notifyChange();
    updateButtons();
    recomputeColTypes();
  }
  function updateButtons() {
    const u = document.getElementById("btn-undo");
    const r = document.getElementById("btn-redo");
    if (u) u.disabled = state.undoStack.length === 0;
    if (r) r.disabled = state.redoStack.length === 0;
  }
  function notifyChange() {
    resetDuplicatesState();
    refreshProfileIfOpen();
    vscodeApi.postMessage({ type: "edit", text: toCsv(state.data, state.currentDelimiter) });
  }
  function setupUndoRedo() {
    document.getElementById("btn-undo")?.addEventListener("click", undo);
    document.getElementById("btn-redo")?.addEventListener("click", redo);
  }

  // src/webview/features/zoom.ts
  var BASE_ROW_HEIGHT = 24;
  var BASE_HEADER_HEIGHT = 26;
  var BASE_FONT_SIZE = 13;
  var BASE_CELL_PADDING = 6;
  var BASE_TOOLBAR_HEIGHT = 28;
  var BASE_TOOLBAR_FONT = 14;
  var BASE_TOOLBAR_PAD = 5;
  var BASE_SEP_HEIGHT = 14;
  var BASE_INFO_FONT = 11;
  var BASE_FOOTER_HEIGHT = 22;
  var BASE_FOOTER_FONT = 11;
  var BASE_TEXT_BTN_FONT = 11;
  var BASE_PROFILE_FONT = 12;
  function applyZoom() {
    const pct = state.ZOOM_STEPS[state.zoomIndex];
    const scale = pct / 100;
    const container = document.getElementById("grid-container");
    container.style.setProperty("--ag-row-height", Math.round(BASE_ROW_HEIGHT * scale) + "px");
    container.style.setProperty("--ag-header-height", Math.round(BASE_HEADER_HEIGHT * scale) + "px");
    container.style.setProperty("--ag-font-size", Math.round(BASE_FONT_SIZE * scale) + "px");
    container.style.setProperty("--ag-cell-horizontal-padding", Math.round(BASE_CELL_PADDING * scale) + "px");
    const toolbar = document.querySelector(".toolbar");
    toolbar.style.height = Math.round(BASE_TOOLBAR_HEIGHT * scale) + "px";
    toolbar.style.fontSize = Math.round(BASE_TOOLBAR_FONT * scale) + "px";
    toolbar.querySelectorAll("button").forEach((btn) => {
      btn.style.fontSize = Math.round(BASE_TOOLBAR_FONT * scale) + "px";
      btn.style.padding = "2px " + Math.round(BASE_TOOLBAR_PAD * scale) + "px";
    });
    const clearBtn = document.getElementById("btn-clear-filters");
    if (clearBtn) clearBtn.style.fontSize = Math.round(BASE_TEXT_BTN_FONT * scale) + "px";
    toolbar.querySelectorAll(".separator").forEach((sep) => {
      sep.style.height = Math.round(BASE_SEP_HEIGHT * scale) + "px";
    });
    const info = document.getElementById("info");
    const zoomLabel = document.getElementById("zoom-level");
    if (info) info.style.fontSize = Math.round(BASE_INFO_FONT * scale) + "px";
    if (zoomLabel) zoomLabel.style.fontSize = Math.round(BASE_INFO_FONT * scale) + "px";
    if (zoomLabel) zoomLabel.textContent = pct + "%";
    const footer = document.querySelector(".footer");
    if (footer) {
      footer.style.height = Math.round(BASE_FOOTER_HEIGHT * scale) + "px";
      footer.style.fontSize = Math.round(BASE_FOOTER_FONT * scale) + "px";
    }
    const profilePanel = document.getElementById("profile-panel");
    if (profilePanel) profilePanel.style.fontSize = Math.round(BASE_PROFILE_FONT * scale) + "px";
    state.autoFitCache = null;
    if (state.gridApi) {
      state.gridApi.resetRowHeights();
      state.gridApi.refreshHeader();
    }
  }
  function persistZoom() {
    vscodeApi.postMessage({ type: "zoomChanged", zoomIndex: state.zoomIndex });
  }
  function zoomIn() {
    if (state.zoomIndex < state.ZOOM_STEPS.length - 1) {
      state.zoomIndex++;
      applyZoom();
      persistZoom();
    }
  }
  function zoomOut() {
    if (state.zoomIndex > 0) {
      state.zoomIndex--;
      applyZoom();
      persistZoom();
    }
  }
  function setupZoom() {
    document.getElementById("btn-zoom-in")?.addEventListener("click", zoomIn);
    document.getElementById("btn-zoom-out")?.addEventListener("click", zoomOut);
  }

  // src/webview/utils/loader.ts
  function showLoader(label) {
    const el = document.getElementById("loading-label");
    if (el) el.textContent = label ?? "Loading\u2026";
    document.getElementById("loading-overlay")?.classList.remove("hidden");
  }
  function hideLoader() {
    document.getElementById("loading-overlay")?.classList.add("hidden");
  }

  // src/webview/grid/filter.ts
  function createCombinedFilter(colType) {
    return class {
      constructor() {
        this.allValues = [];
        this.hasBlank = false;
        this.checkedValues = /* @__PURE__ */ new Set();
        this.conditions = [{ type: "none", value: "", join: "and" }];
        this._searchQuery = "";
        this.truncated = false;
        this._renderValuesList = null;
        this._displayedValues = [];
      }
      init(params) {
        this.params = params;
        this._buildValueList();
        this.checkedValues = new Set(this.allValues);
        if (this.hasBlank) this.checkedValues.add("__blank__");
        this.eGui = document.createElement("div");
        this.eGui.className = "csv-filter-panel";
        this._render();
      }
      _buildValueList() {
        const field = this.params.column.getColId();
        const vals = /* @__PURE__ */ new Set();
        this.hasBlank = false;
        this.params.api.forEachNode((n) => {
          const v = n.data[field];
          if (v == null || String(v).trim() === "") {
            this.hasBlank = true;
            return;
          }
          vals.add(String(v));
        });
        let arr = Array.from(vals);
        if (colType === "integer" || colType === "float") {
          arr.sort((a, b) => Number(a) - Number(b));
        } else {
          arr.sort((a, b) => a.localeCompare(b, void 0, { sensitivity: "base" }));
        }
        this.allValues = arr.slice(0, 2e3);
        this.truncated = arr.length > 2e3;
      }
      _conditionOptions() {
        if (colType === "integer" || colType === "float") {
          return [
            { id: "none", label: "\u2014 No condition \u2014" },
            { id: "eq", label: "= Equals" },
            { id: "neq", label: "\u2260 Does not equal" },
            { id: "gt", label: "> Greater than" },
            { id: "gte", label: "\u2265 Greater than or equal" },
            { id: "lt", label: "< Less than" },
            { id: "lte", label: "\u2264 Less than or equal" },
            { id: "blank", label: "Is blank" },
            { id: "notblank", label: "Is not blank" }
          ];
        } else if (colType === "date" || colType === "datetime" || colType === "time") {
          return [
            { id: "none", label: "\u2014 No condition \u2014" },
            { id: "eq", label: "= Equals" },
            { id: "neq", label: "\u2260 Does not equal" },
            { id: "gt", label: "> After" },
            { id: "gte", label: "\u2265 After or on" },
            { id: "lt", label: "< Before" },
            { id: "lte", label: "\u2264 Before or on" },
            { id: "blank", label: "Is blank" },
            { id: "notblank", label: "Is not blank" }
          ];
        } else {
          return [
            { id: "none", label: "\u2014 No condition \u2014" },
            { id: "contains", label: "Contains" },
            { id: "notcontains", label: "Does not contain" },
            { id: "eq", label: "Equals" },
            { id: "neq", label: "Does not equal" },
            { id: "startswith", label: "Begins with" },
            { id: "endswith", label: "Ends with" },
            { id: "blank", label: "Is blank" },
            { id: "notblank", label: "Is not blank" }
          ];
        }
      }
      // ── condition evaluation ───────────────────────────────────────────────
      _passesSingleCondition(valStr, cond) {
        const ct = cond.type;
        if (ct === "none") return true;
        const isBlank = valStr === "";
        if (ct === "blank") return isBlank;
        if (ct === "notblank") return !isBlank;
        if (!cond.value) return true;
        const cv = cond.value;
        const isNumeric = colType === "integer" || colType === "float";
        const isDateType = colType === "date" || colType === "datetime" || colType === "time";
        if (isNumeric) {
          const nCell = Number(valStr), nCond = Number(cv);
          if (isNaN(nCell)) return false;
          if (ct === "eq") return nCell === nCond;
          if (ct === "neq") return nCell !== nCond;
          if (ct === "gt") return nCell > nCond;
          if (ct === "gte") return nCell >= nCond;
          if (ct === "lt") return nCell < nCond;
          if (ct === "lte") return nCell <= nCond;
        } else if (isDateType) {
          const dCell = new Date(valStr), dCond = new Date(cv);
          if (isNaN(dCell.getTime())) return false;
          const ds = dCell.toISOString().slice(0, 10);
          const dc = dCond.toISOString().slice(0, 10);
          if (ct === "eq") return ds === dc;
          if (ct === "neq") return ds !== dc;
          if (ct === "gt") return dCell > dCond;
          if (ct === "gte") return dCell >= dCond;
          if (ct === "lt") return dCell < dCond;
          if (ct === "lte") return dCell <= dCond;
        } else {
          const lo = valStr.toLowerCase(), lc = cv.toLowerCase();
          if (ct === "contains") return lo.includes(lc);
          if (ct === "notcontains") return !lo.includes(lc);
          if (ct === "eq") return lo === lc;
          if (ct === "neq") return lo !== lc;
          if (ct === "startswith") return lo.startsWith(lc);
          if (ct === "endswith") return lo.endsWith(lc);
        }
        return true;
      }
      _passesConditions(valStr) {
        const active = this.conditions.filter((c) => c.type !== "none");
        if (active.length === 0) return true;
        const groups = [[]];
        active.forEach((c, idx) => {
          if (idx > 0 && c.join === "or") groups.push([]);
          groups[groups.length - 1].push(c);
        });
        return groups.some((g) => g.every((c) => this._passesSingleCondition(valStr, c)));
      }
      _valuesPassingCondition() {
        return this.allValues.filter((v) => this._passesConditions(v));
      }
      _showBlankInList() {
        return this.hasBlank && this._passesConditions("");
      }
      _hasAnyActiveCondition() {
        return this.conditions.some((c) => c.type !== "none");
      }
      // ── rendering ─────────────────────────────────────────────────────────
      _render() {
        this.eGui.innerHTML = "";
        const isNumeric = colType === "integer" || colType === "float";
        const isDate = colType === "date" || colType === "datetime";
        const condSec = document.createElement("div");
        condSec.className = "csv-filter-section";
        const condLabel = document.createElement("div");
        condLabel.className = "csv-filter-section-label";
        condLabel.textContent = "Condition";
        condSec.appendChild(condLabel);
        const condRowsDiv = document.createElement("div");
        condRowsDiv.className = "csv-filter-cond-rows";
        const rebuildCondRows = () => {
          condRowsDiv.innerHTML = "";
          this.conditions.forEach((cond, i) => {
            if (i > 0) {
              if (cond.join !== "or") cond.join = "and";
              const joinBtn = document.createElement("button");
              joinBtn.type = "button";
              joinBtn.className = "csv-filter-join-toggle";
              joinBtn.title = "Toggle AND / OR";
              joinBtn.textContent = cond.join === "or" ? "OR" : "AND";
              joinBtn.dataset.join = cond.join;
              joinBtn.addEventListener("click", () => {
                cond.join = cond.join === "or" ? "and" : "or";
                joinBtn.textContent = cond.join === "or" ? "OR" : "AND";
                joinBtn.dataset.join = cond.join;
                this._renderValuesList?.();
                this.params.filterChangedCallback();
              });
              condRowsDiv.appendChild(joinBtn);
            }
            const row = document.createElement("div");
            row.className = "csv-filter-cond-row";
            const sel = document.createElement("select");
            sel.className = "csv-filter-select";
            this._conditionOptions().forEach((opt) => {
              const o = document.createElement("option");
              o.value = opt.id;
              o.textContent = opt.label;
              if (opt.id === cond.type) o.selected = true;
              sel.appendChild(o);
            });
            sel.addEventListener("change", () => {
              cond.type = sel.value;
              const newNeedsInput = sel.value !== "none" && sel.value !== "blank" && sel.value !== "notblank";
              if (!newNeedsInput) cond.value = "";
              rebuildCondRows();
              this._renderValuesList?.();
              this.params.filterChangedCallback();
            });
            row.appendChild(sel);
            const needsInput = cond.type !== "none" && cond.type !== "blank" && cond.type !== "notblank";
            if (needsInput) {
              const inp = document.createElement("input");
              inp.className = "csv-filter-input csv-filter-cond-input";
              inp.type = isNumeric ? "number" : isDate ? "date" : "text";
              inp.value = cond.value;
              inp.placeholder = isNumeric ? "Value\u2026" : "Filter\u2026";
              inp.addEventListener("input", () => {
                cond.value = inp.value;
                this._renderValuesList?.();
                this.params.filterChangedCallback();
              });
              row.appendChild(inp);
            }
            const removeBtn = document.createElement("button");
            removeBtn.className = "csv-filter-remove-btn";
            removeBtn.title = "Remove condition";
            removeBtn.textContent = "\xD7";
            removeBtn.addEventListener("click", () => {
              if (this.conditions.length === 1) {
                this.conditions[0] = { type: "none", value: "", join: "and" };
              } else {
                this.conditions.splice(i, 1);
              }
              rebuildCondRows();
              this._renderValuesList?.();
              this.params.filterChangedCallback();
            });
            row.appendChild(removeBtn);
            condRowsDiv.appendChild(row);
          });
          const addBtn = document.createElement("button");
          addBtn.className = "csv-filter-add-btn";
          addBtn.textContent = "+ Add condition";
          const lastCond = this.conditions[this.conditions.length - 1];
          addBtn.disabled = lastCond.type === "none";
          addBtn.addEventListener("click", () => {
            this.conditions.push({ type: "none", value: "", join: "and" });
            rebuildCondRows();
            this.params.filterChangedCallback();
          });
          condRowsDiv.appendChild(addBtn);
        };
        rebuildCondRows();
        condSec.appendChild(condRowsDiv);
        this.eGui.appendChild(condSec);
        const valSec = document.createElement("div");
        valSec.className = "csv-filter-section";
        const valLabel = document.createElement("div");
        valLabel.className = "csv-filter-section-label";
        valLabel.textContent = "Values";
        valSec.appendChild(valLabel);
        const searchInp = document.createElement("input");
        searchInp.className = "csv-filter-input";
        searchInp.style.marginTop = "0";
        searchInp.placeholder = "Search values\u2026";
        searchInp.value = this._searchQuery;
        valSec.appendChild(searchInp);
        const masterRow = document.createElement("label");
        masterRow.className = "csv-filter-master";
        const masterCb = document.createElement("input");
        masterCb.type = "checkbox";
        const masterLabel = document.createElement("span");
        masterLabel.className = "csv-filter-master-label";
        masterLabel.textContent = "Select all";
        const masterCount = document.createElement("span");
        masterCount.className = "csv-filter-master-count";
        masterRow.appendChild(masterCb);
        masterRow.appendChild(masterLabel);
        masterRow.appendChild(masterCount);
        valSec.appendChild(masterRow);
        const listDiv = document.createElement("div");
        listDiv.className = "csv-filter-values-list";
        valSec.appendChild(listDiv);
        const syncMaster2 = () => {
          const displayed = this._displayedValues;
          const total = displayed.length;
          let checked = 0;
          for (const v of displayed) if (this.checkedValues.has(v)) checked++;
          masterCb.checked = total > 0 && checked === total;
          masterCb.indeterminate = checked > 0 && checked < total;
          masterCb.disabled = total === 0;
          masterCount.textContent = total > 0 ? `${checked} / ${total}` : "";
          masterLabel.textContent = this._searchQuery ? "Select all matches" : "Select all";
        };
        const renderList = () => {
          listDiv.innerHTML = "";
          const q = this._searchQuery.toLowerCase();
          let items = [];
          if (this._showBlankInList()) items.push({ label: "(Blank)", value: "__blank__", isBlank: true });
          this._valuesPassingCondition().forEach((v) => items.push({ label: v, value: v, isBlank: false }));
          if (q) items = items.filter((it) => it.label.toLowerCase().includes(q));
          this._displayedValues = items.map((it) => it.value);
          if (items.length === 0) {
            const empty = document.createElement("div");
            empty.className = "csv-filter-empty";
            empty.textContent = this._hasAnyActiveCondition() ? "No values match this condition" : "No matching values";
            listDiv.appendChild(empty);
            syncMaster2();
            return;
          }
          items.forEach((item) => {
            const row = document.createElement("label");
            row.className = "csv-filter-value-row";
            const cb = document.createElement("input");
            cb.type = "checkbox";
            cb.checked = this.checkedValues.has(item.value);
            cb.addEventListener("change", () => {
              if (cb.checked) this.checkedValues.add(item.value);
              else this.checkedValues.delete(item.value);
              syncMaster2();
              this.params.filterChangedCallback();
            });
            const span = document.createElement("span");
            span.className = "csv-filter-value-label" + (item.isBlank ? " blank" : "");
            span.textContent = item.label;
            row.appendChild(cb);
            row.appendChild(span);
            listDiv.appendChild(row);
          });
          if (this.truncated && !q) {
            const note = document.createElement("div");
            note.className = "csv-filter-empty";
            note.textContent = "Showing first 2000 unique values";
            listDiv.appendChild(note);
          }
          syncMaster2();
        };
        this._renderValuesList = renderList;
        masterCb.addEventListener("change", () => {
          const check = masterCb.checked;
          for (const v of this._displayedValues) {
            if (check) this.checkedValues.add(v);
            else this.checkedValues.delete(v);
          }
          renderList();
          this.params.filterChangedCallback();
        });
        searchInp.addEventListener("input", () => {
          this._searchQuery = searchInp.value;
          renderList();
        });
        renderList();
        this.eGui.appendChild(valSec);
      }
      getGui() {
        return this.eGui;
      }
      isFilterActive() {
        if (this._hasAnyActiveCondition()) return true;
        const allChecked = this.allValues.every((v) => this.checkedValues.has(v));
        return this.hasBlank ? !(allChecked && this.checkedValues.has("__blank__")) : !allChecked;
      }
      doesFilterPass(params) {
        const field = this.params.column.getColId();
        const raw = params.data[field];
        const valStr = raw != null ? String(raw).trim() : "";
        const isBlank = valStr === "";
        const allChecked = this.allValues.every((v) => this.checkedValues.has(v)) && (!this.hasBlank || this.checkedValues.has("__blank__"));
        if (!allChecked) {
          const key = isBlank ? "__blank__" : valStr;
          if (!this.checkedValues.has(key)) return false;
        }
        return this._passesConditions(valStr);
      }
      getModel() {
        if (!this.isFilterActive()) return null;
        return {
          conditions: this.conditions.map((c) => ({ type: c.type, value: c.value, join: c.join })),
          checkedValues: Array.from(this.checkedValues)
        };
      }
      setModel(model) {
        if (model == null) {
          this.conditions = [{ type: "none", value: "", join: "and" }];
          this._searchQuery = "";
          this.checkedValues = new Set(this.allValues);
          if (this.hasBlank) this.checkedValues.add("__blank__");
        } else {
          if (Array.isArray(model.conditions)) {
            this.conditions = model.conditions.map((c) => ({
              type: c.type || "none",
              value: c.value || "",
              join: c.join === "or" ? "or" : "and"
            }));
          } else if (model.condType) {
            this.conditions = [{ type: model.condType, value: model.condValue || "", join: "and" }];
          } else {
            this.conditions = [{ type: "none", value: "", join: "and" }];
          }
          if (this.conditions.length === 0) this.conditions = [{ type: "none", value: "", join: "and" }];
          this.checkedValues = new Set(model.checkedValues || this.allValues);
        }
        this._render();
      }
      destroy() {
      }
    };
  }

  // src/webview/grid/row-mapping.ts
  function dataRowIndexForNode(node) {
    const origIndex = node.data?._origIndex;
    return origIndex != null ? origIndex : (node.rowIndex ?? 0) + 1;
  }
  function dataRowIndexForFindMatch(m) {
    return m.origIndex != null ? m.origIndex : m.rowIndex + 1;
  }

  // src/webview/features/find-replace.ts
  function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  function isCaseSensitive() {
    return document.getElementById("find-case-btn")?.classList.contains("find-case-btn--active") ?? false;
  }
  function getFindCellClassRules() {
    return {
      "cell-find-match": (p) => state.findMatches.some((m) => m.rowIndex === p.rowIndex && m.colField === p.column.getColId()),
      "cell-find-active": (p) => state.findMatchIndex >= 0 && !!state.findMatches[state.findMatchIndex] && state.findMatches[state.findMatchIndex].rowIndex === p.rowIndex && state.findMatches[state.findMatchIndex].colField === p.column.getColId()
    };
  }
  function refreshRows(rowIndices) {
    if (!state.gridApi || rowIndices.size === 0) return;
    const nodes = Array.from(rowIndices).map((ri) => state.gridApi.getDisplayedRowAtIndex(ri)).filter(Boolean);
    if (nodes.length) state.gridApi.refreshCells({ rowNodes: nodes, force: true });
  }
  var debounceTimer = null;
  function execFind() {
    debounceTimer = null;
    if (!state.gridApi) return;
    const needle = document.getElementById("find-input").value;
    const cs = isCaseSensitive();
    const countEl = document.getElementById("find-count");
    const prevRows = new Set(state.findMatches.map((m) => m.rowIndex));
    state.findMatches = [];
    state.findMatchIndex = -1;
    if (!needle) {
      countEl.textContent = "";
      refreshRows(prevRows);
      return;
    }
    const cols = state.gridApi.getColumnDefs().filter((col) => col.colId !== "row-index" && col.field);
    const lowerNeedle = cs ? "" : needle.toLowerCase();
    state.gridApi.forEachNodeAfterFilterAndSort((node) => {
      for (const col of cols) {
        const raw = node.data[col.field];
        if (raw == null) continue;
        const val = cs ? String(raw) : String(raw).toLowerCase();
        if (val.includes(cs ? needle : lowerNeedle)) {
          state.findMatches.push({
            rowIndex: node.rowIndex,
            origIndex: Number(node.data._origIndex),
            colField: col.field
          });
        }
      }
    });
    if (state.findMatches.length) state.findMatchIndex = 0;
    countEl.textContent = state.findMatches.length ? state.findMatchIndex + 1 + " / " + state.findMatches.length : "0 matches";
    if (state.findMatchIndex >= 0) {
      state.gridApi.ensureIndexVisible(state.findMatches[0].rowIndex, "middle");
    }
    const newRows = new Set(state.findMatches.map((m) => m.rowIndex));
    refreshRows(/* @__PURE__ */ new Set([...prevRows, ...newRows]));
  }
  function runFind() {
    if (debounceTimer !== null) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(execFind, 120);
  }
  function navigateFind(dir) {
    if (!state.findMatches.length) return;
    const prevRow = state.findMatchIndex >= 0 ? state.findMatches[state.findMatchIndex].rowIndex : -1;
    state.findMatchIndex = (state.findMatchIndex + dir + state.findMatches.length) % state.findMatches.length;
    const nextRow = state.findMatches[state.findMatchIndex].rowIndex;
    state.gridApi?.ensureIndexVisible(nextRow, "middle");
    const countEl = document.getElementById("find-count");
    if (countEl) countEl.textContent = state.findMatchIndex + 1 + " / " + state.findMatches.length;
    refreshRows(new Set([prevRow, nextRow].filter((r) => r >= 0)));
  }
  function openFindBar() {
    document.getElementById("find-bar")?.classList.remove("hidden");
    document.getElementById("find-input")?.focus();
  }
  function closeFindBar() {
    document.getElementById("find-bar")?.classList.add("hidden");
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    const prevRows = new Set(state.findMatches.map((m) => m.rowIndex));
    state.findMatches = [];
    state.findMatchIndex = -1;
    refreshRows(prevRows);
  }
  function replaceOne() {
    if (state.findMatchIndex < 0 || IS_PREVIEW) return;
    const needle = document.getElementById("find-input").value;
    const repl = document.getElementById("replace-input").value;
    const cs = isCaseSensitive();
    const m = state.findMatches[state.findMatchIndex];
    const colIdx = parseInt(m.colField.replace("col_", ""));
    const dataIndex = dataRowIndexForFindMatch(m);
    const oldVal = String(state.data[dataIndex][colIdx] ?? "");
    const newVal = oldVal.replace(
      new RegExp(escapeRegExp(needle), cs ? "" : "i"),
      repl
    );
    pushUndo();
    state.data[dataIndex][colIdx] = newVal;
    notifyChange();
    scheduleRecomputeColTypes();
    execFind();
  }
  function replaceAll() {
    if (!state.findMatches.length || IS_PREVIEW) return;
    const needle = document.getElementById("find-input").value;
    const repl = document.getElementById("replace-input").value;
    const cs = isCaseSensitive();
    const regex = new RegExp(escapeRegExp(needle), cs ? "g" : "gi");
    pushUndo();
    state.findMatches.forEach((m) => {
      const colIdx = parseInt(m.colField.replace("col_", ""));
      const dataIndex = dataRowIndexForFindMatch(m);
      const oldVal = String(state.data[dataIndex][colIdx] ?? "");
      state.data[dataIndex][colIdx] = oldVal.replace(regex, repl);
    });
    notifyChange();
    scheduleRecomputeColTypes();
    execFind();
  }
  function setupFindReplace() {
    const fi = document.getElementById("find-input");
    if (fi) {
      fi.addEventListener("input", runFind);
      fi.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          navigateFind(e.shiftKey ? -1 : 1);
        }
        if (e.key === "Escape") closeFindBar();
      });
    }
    const caseBtn = document.getElementById("find-case-btn");
    caseBtn?.addEventListener("click", () => {
      caseBtn.classList.toggle("find-case-btn--active");
      execFind();
    });
    document.getElementById("btn-find-replace")?.addEventListener("click", openFindBar);
    document.getElementById("find-prev")?.addEventListener("click", () => navigateFind(-1));
    document.getElementById("find-next")?.addEventListener("click", () => navigateFind(1));
    document.getElementById("find-close")?.addEventListener("click", closeFindBar);
    document.getElementById("replace-one")?.addEventListener("click", replaceOne);
    document.getElementById("replace-all")?.addEventListener("click", replaceAll);
    document.getElementById("replace-input")?.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closeFindBar();
    });
  }

  // src/webview/features/popups.ts
  var POPUP_IDS = [
    "col-context-menu",
    "row-context-menu",
    "export-dropdown",
    "delim-dropdown",
    "col-chooser-popover",
    "goto-popover",
    "rename-popover"
  ];
  function closeAllPopups(except) {
    for (const id of POPUP_IDS) {
      if (id === except) continue;
      document.getElementById(id)?.classList.add("hidden");
    }
  }
  function isAnyPopupOpen() {
    return POPUP_IDS.some((id) => {
      const el = document.getElementById(id);
      return el != null && !el.classList.contains("hidden");
    });
  }
  function setupPopups() {
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      const agOpen = document.querySelector(".ag-popup .ag-menu, .ag-popup .ag-filter");
      if (agOpen) {
        state.gridApi?.hidePopupMenu?.();
        e.preventDefault();
        return;
      }
      if (!isAnyPopupOpen()) return;
      closeAllPopups();
      e.preventDefault();
    }, true);
  }

  // src/webview/features/range-select.ts
  var selActive = false;
  var selType = "cells";
  var anchorRow = 0;
  var anchorCol = 0;
  var focusRow = 0;
  var focusCol = 0;
  var selRowLo = 0;
  var selRowHi = -1;
  var selColIds = /* @__PURE__ */ new Set();
  var selCellCount = 0;
  var dragging = false;
  var dragMode = "cells";
  var statsTimer = null;
  function displayedColIds() {
    if (!state.gridApi) return [];
    return state.gridApi.getAllDisplayedColumns().map((c) => c.getColId()).filter((id) => id.startsWith("col_"));
  }
  function displayedRowCount() {
    return state.gridApi ? state.gridApi.getDisplayedRowCount() : 0;
  }
  function displayRowToOrig() {
    const map = [];
    state.gridApi?.forEachNodeAfterFilterAndSort((node) => {
      map.push(node.data?._origIndex != null ? Number(node.data._origIndex) : -1);
    });
    return map;
  }
  function recomputeCache() {
    const cols = displayedColIds();
    const rowCount = displayedRowCount();
    if (!selActive || cols.length === 0 || rowCount === 0) {
      selRowLo = 0;
      selRowHi = -1;
      selColIds = /* @__PURE__ */ new Set();
      selCellCount = 0;
      return;
    }
    let rLo, rHi, cLo, cHi;
    if (selType === "all") {
      rLo = 0;
      rHi = rowCount - 1;
      cLo = 0;
      cHi = cols.length - 1;
    } else if (selType === "rows") {
      rLo = Math.min(anchorRow, focusRow);
      rHi = Math.max(anchorRow, focusRow);
      cLo = 0;
      cHi = cols.length - 1;
    } else if (selType === "cols") {
      rLo = 0;
      rHi = rowCount - 1;
      cLo = Math.min(anchorCol, focusCol);
      cHi = Math.max(anchorCol, focusCol);
    } else {
      rLo = Math.min(anchorRow, focusRow);
      rHi = Math.max(anchorRow, focusRow);
      cLo = Math.min(anchorCol, focusCol);
      cHi = Math.max(anchorCol, focusCol);
    }
    rLo = Math.max(0, rLo);
    rHi = Math.min(rowCount - 1, rHi);
    cLo = Math.max(0, cLo);
    cHi = Math.min(cols.length - 1, cHi);
    selRowLo = rLo;
    selRowHi = rHi;
    selColIds = new Set(cols.slice(cLo, cHi + 1));
    selCellCount = Math.max(0, rHi - rLo + 1) * selColIds.size;
  }
  function repaint() {
    state.gridApi?.refreshCells({ force: true });
  }
  function selectionChanged() {
    recomputeCache();
    repaint();
    scheduleStats();
  }
  function getRangeCellClassRules() {
    return {
      "cell-range-sel": (p) => {
        if (!selActive || selCellCount <= 1) return false;
        if (p.rowIndex < selRowLo || p.rowIndex > selRowHi) return false;
        const colId = p.column.getColId();
        if (colId === "row-index") return selType === "rows" || selType === "all";
        return selColIds.has(colId);
      }
    };
  }
  function fmtNum2(n) {
    if (Number.isInteger(n)) return n.toLocaleString();
    return (+n.toFixed(2)).toLocaleString(void 0, { maximumFractionDigits: 2 });
  }
  function scheduleStats() {
    if (statsTimer !== null) clearTimeout(statsTimer);
    statsTimer = setTimeout(renderStats, 80);
  }
  function renderStats() {
    statsTimer = null;
    const el = document.getElementById("sel-stats");
    if (!el) return;
    if (!selActive || selCellCount <= 1) {
      el.textContent = "";
      return;
    }
    const cols = displayedColIds();
    const selCols = cols.filter((id) => selColIds.has(id));
    const rowMap = displayRowToOrig();
    let count = 0, numCount = 0, sum = 0;
    let min = Infinity, max = -Infinity;
    for (let r = selRowLo; r <= selRowHi; r++) {
      const orig = rowMap[r];
      if (orig == null || orig < 0) continue;
      const dataRow = state.data[orig];
      if (!dataRow) continue;
      for (const colId of selCols) {
        const ci = parseInt(colId.slice(4), 10);
        const raw = dataRow[ci];
        const v = raw != null ? String(raw).trim() : "";
        if (v === "") continue;
        count++;
        const n = Number(v);
        if (!isNaN(n)) {
          numCount++;
          sum += n;
          if (n < min) min = n;
          if (n > max) max = n;
        }
      }
    }
    const nRows = selRowHi - selRowLo + 1;
    const nCols = selColIds.size;
    let txt = `${nRows.toLocaleString()}R \xD7 ${nCols}C  \xB7  Count ${count.toLocaleString()}`;
    if (numCount > 0) {
      txt += `  \xB7  Sum ${fmtNum2(sum)}  \xB7  Avg ${fmtNum2(sum / numCount)}  \xB7  Min ${fmtNum2(min)}  \xB7  Max ${fmtNum2(max)}`;
    }
    el.textContent = txt;
  }
  function writeClipboard(text) {
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).catch(() => execCopy(text));
    } else {
      execCopy(text);
    }
  }
  function execCopy(text) {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.cssText = "position:fixed;left:-9999px;top:-9999px;opacity:0;";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    } catch {
    }
  }
  function hasMultiSelection() {
    return selActive && selCellCount > 1;
  }
  function copySelection(withHeader = false) {
    if (!state.gridApi || !selActive) return;
    const cols = displayedColIds();
    const selCols = cols.filter((id) => selColIds.has(id));
    const rowMap = displayRowToOrig();
    const lines = [];
    if (withHeader) {
      const header = state.data[0] ?? [];
      lines.push(selCols.map((colId) => {
        const ci = parseInt(colId.slice(4), 10);
        return tsvCell(String(header[ci] ?? ""));
      }).join("	"));
    }
    for (let r = selRowLo; r <= selRowHi; r++) {
      const orig = rowMap[r];
      const dataRow = orig != null && orig >= 0 ? state.data[orig] : void 0;
      lines.push(selCols.map((colId) => {
        const ci = parseInt(colId.slice(4), 10);
        const v = dataRow?.[ci];
        return tsvCell(v != null ? String(v) : "");
      }).join("	"));
    }
    writeClipboard(lines.join("\n"));
  }
  function clearSelectedCells() {
    if (!state.gridApi || !selActive || IS_PREVIEW || IS_CHUNKED) return;
    const cols = displayedColIds();
    const selCols = cols.filter((id) => selColIds.has(id));
    const rowMap = displayRowToOrig();
    let anyNonEmpty = false;
    scan: for (let r = selRowLo; r <= selRowHi; r++) {
      const orig = rowMap[r];
      if (orig == null || orig < 0) continue;
      const dataRow = state.data[orig];
      if (!dataRow) continue;
      for (const colId of selCols) {
        const ci = parseInt(colId.slice(4), 10);
        if ((dataRow[ci] ?? "") !== "") {
          anyNonEmpty = true;
          break scan;
        }
      }
    }
    if (!anyNonEmpty) return;
    pushUndo();
    for (let r = selRowLo; r <= selRowHi; r++) {
      const orig = rowMap[r];
      if (orig == null || orig < 0) continue;
      const dataRow = state.data[orig];
      if (!dataRow) continue;
      const node = state.gridApi.getDisplayedRowAtIndex(r);
      for (const colId of selCols) {
        const ci = parseInt(colId.slice(4), 10);
        while (dataRow.length <= ci) dataRow.push("");
        dataRow[ci] = "";
        if (node?.data) node.data[colId] = "";
      }
    }
    state.gridApi.refreshCells({ force: true });
    recomputeColTypes();
    notifyChange();
  }
  function clearRangeSelection() {
    if (!selActive && selCellCount === 0) return;
    selActive = false;
    dragging = false;
    document.body.style.userSelect = "";
    recomputeCache();
    repaint();
    const el = document.getElementById("sel-stats");
    if (el) el.textContent = "";
  }
  function getSelectedRowDisplayIndices() {
    if (!selActive || selType !== "rows" && selType !== "all" || selRowHi < selRowLo) return [];
    const out = [];
    for (let r = selRowLo; r <= selRowHi; r++) out.push(r);
    return out;
  }
  function getSelectedColIndices() {
    if (!selActive || selType !== "cols" && selType !== "all") return [];
    return [...selColIds].map((id) => parseInt(id.slice(4), 10)).filter((n) => !isNaN(n)).sort((a, b) => a - b);
  }
  function selectWholeColumn(colId) {
    const cpos = displayedColIds().indexOf(colId);
    if (cpos < 0) return;
    selActive = true;
    selType = "cols";
    anchorCol = focusCol = cpos;
    anchorRow = focusRow = 0;
    selectionChanged();
  }
  function selectColumnRangeTo(colId) {
    const cpos = displayedColIds().indexOf(colId);
    if (cpos < 0) return;
    if (selActive && selType === "cols") {
      focusCol = cpos;
    } else {
      selActive = true;
      selType = "cols";
      anchorCol = focusCol = cpos;
      anchorRow = focusRow = 0;
    }
    selectionChanged();
  }
  function selectAll() {
    if (displayedRowCount() === 0) return;
    selActive = true;
    selType = "all";
    selectionChanged();
  }
  function extendByKey(key) {
    const cols = displayedColIds();
    const rowCount = displayedRowCount();
    if (cols.length === 0 || rowCount === 0) return;
    if (!selActive) {
      const fr = state.focusedCellRowIndex;
      const fc = state.focusedCellColId;
      if (fr == null || fc == null) return;
      const cpos = fc === "row-index" ? 0 : cols.indexOf(fc);
      if (cpos < 0) return;
      selActive = true;
      anchorRow = focusRow = fr;
      anchorCol = focusCol = cpos;
    }
    if (selType !== "cells") selType = "cells";
    if (key === "ArrowUp") focusRow = Math.max(0, focusRow - 1);
    if (key === "ArrowDown") focusRow = Math.min(rowCount - 1, focusRow + 1);
    if (key === "ArrowLeft") focusCol = Math.max(0, focusCol - 1);
    if (key === "ArrowRight") focusCol = Math.min(cols.length - 1, focusCol + 1);
    state.gridApi?.ensureIndexVisible(focusRow);
    selectionChanged();
  }
  function onCellMouseDownHandler(e) {
    if (state.isCellEditing) return;
    const native = e.event;
    if (native && native.button !== 0) return;
    if (e.rowPinned) return;
    const colId = e.column?.getColId?.();
    const rowIndex = e.rowIndex;
    if (colId == null || rowIndex == null) return;
    const shift = !!native?.shiftKey;
    if (colId === "row-index") {
      if (shift && selActive && selType === "rows") {
        focusRow = rowIndex;
      } else {
        selActive = true;
        selType = "rows";
        anchorRow = focusRow = rowIndex;
        anchorCol = focusCol = 0;
      }
      dragging = true;
      dragMode = "rows";
    } else {
      const cpos = displayedColIds().indexOf(colId);
      if (cpos < 0) return;
      if (shift && selActive && selType !== "all") {
        selType = "cells";
        focusRow = rowIndex;
        focusCol = cpos;
      } else {
        selActive = true;
        selType = "cells";
        anchorRow = focusRow = rowIndex;
        anchorCol = focusCol = cpos;
      }
      dragging = true;
      dragMode = "cells";
    }
    document.body.style.userSelect = "none";
    selectionChanged();
  }
  function onCellMouseOverHandler(e) {
    if (!dragging) return;
    if (e.rowPinned) return;
    const rowIndex = e.rowIndex;
    if (rowIndex == null) return;
    const colId = e.column?.getColId?.();
    focusRow = rowIndex;
    if (dragMode === "cells") {
      if (colId === "row-index") {
        focusCol = 0;
      } else if (colId != null) {
        const cpos = displayedColIds().indexOf(colId);
        if (cpos >= 0) focusCol = cpos;
      }
    }
    selectionChanged();
  }
  function isTypingTarget(t) {
    if (t instanceof HTMLElement) {
      const tag = t.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || t.isContentEditable) return true;
    }
    return false;
  }
  var ARROWS = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"];
  function onKeyDown(e) {
    if (state.isCellEditing) return;
    if (isTypingTarget(e.target)) return;
    if (!state.gridApi) return;
    const ctrl = e.ctrlKey || e.metaKey;
    const key = e.key;
    if (ctrl && (key === "a" || key === "A")) {
      e.preventDefault();
      e.stopPropagation();
      selectAll();
      return;
    }
    if (ctrl && (key === "c" || key === "C")) {
      if (selActive && selCellCount > 1) {
        e.preventDefault();
        e.stopPropagation();
        copySelection();
      }
      return;
    }
    if (key === "Delete" || key === "Backspace") {
      if (selActive && selCellCount >= 1 && !IS_PREVIEW && !IS_CHUNKED) {
        e.preventDefault();
        e.stopPropagation();
        clearSelectedCells();
      }
      return;
    }
    if (ARROWS.includes(key)) {
      if (e.shiftKey && !ctrl) {
        e.preventDefault();
        e.stopPropagation();
        extendByKey(key);
      } else if (!e.shiftKey && !ctrl && selActive && selCellCount > 1) {
        clearRangeSelection();
      }
      return;
    }
  }
  function setupRangeSelect() {
    document.addEventListener(
      "keydown",
      onKeyDown,
      true
      /* capture */
    );
    document.addEventListener("mouseup", () => {
      if (!dragging) return;
      dragging = false;
      document.body.style.userSelect = "";
    });
    const container = document.getElementById("grid-container");
    container?.addEventListener(
      "click",
      (e) => {
        const headerCell = e.target.closest(".ag-header-cell[col-id]");
        const colId = headerCell?.getAttribute("col-id");
        if (colId === "row-index") {
          e.preventDefault();
          e.stopPropagation();
          closeAllPopups();
          if (selActive && selType === "all") clearRangeSelection();
          else selectAll();
          return;
        }
        if (!e.shiftKey) return;
        if (!colId || !colId.startsWith("col_")) return;
        e.preventDefault();
        e.stopPropagation();
        closeAllPopups();
        selectColumnRangeTo(colId);
      },
      true
      /* capture */
    );
    const colMenu = document.getElementById("col-context-menu");
    document.getElementById("col-ctx-select")?.addEventListener("click", () => {
      const colId = colMenu?.dataset.colId;
      if (colId) selectWholeColumn(colId);
      colMenu?.classList.add("hidden");
    });
  }

  // src/webview/features/freeze-columns.ts
  function attachHeaderContextMenus() {
  }
  function setupFreezeColumns() {
    const menu = document.getElementById("col-context-menu");
    if (!menu) return;
    const targetColIds = (colId) => {
      const colIndex = parseInt(colId.replace("col_", ""), 10);
      const sel = getSelectedColIndices();
      return sel.length > 1 && sel.includes(colIndex) ? sel.map((i) => "col_" + i) : [colId];
    };
    document.getElementById("col-ctx-freeze")?.addEventListener("click", () => {
      const colId = menu.dataset.colId;
      menu.classList.add("hidden");
      if (!colId || !state.gridApi) return;
      const ids = targetColIds(colId);
      for (const id of ids) {
        const ci = parseInt(id.slice(4), 10);
        if (!isNaN(ci)) state.pinnedCols.add(ci);
      }
      state.gridApi.applyColumnState({ state: ids.map((id) => ({ colId: id, pinned: "left" })) });
    });
    document.getElementById("col-ctx-unfreeze")?.addEventListener("click", () => {
      const colId = menu.dataset.colId;
      menu.classList.add("hidden");
      if (!colId || !state.gridApi) return;
      const ids = targetColIds(colId);
      for (const id of ids) {
        const ci = parseInt(id.slice(4), 10);
        state.pinnedCols.delete(ci);
      }
      state.gridApi.applyColumnState({ state: ids.map((id) => ({ colId: id, pinned: null })) });
    });
    document.getElementById("col-ctx-unfreeze-all")?.addEventListener("click", () => {
      menu.classList.add("hidden");
      if (!state.gridApi || state.pinnedCols.size === 0) return;
      const ids = [...state.pinnedCols].map((ci) => "col_" + ci);
      state.pinnedCols.clear();
      state.gridApi.applyColumnState({ state: ids.map((id) => ({ colId: id, pinned: null })) });
    });
    document.addEventListener("click", () => menu.classList.add("hidden"));
    const container = document.getElementById("grid-container");
    if (!container) return;
    container.addEventListener("contextmenu", (e) => {
      const target = e.target;
      const headerCell = target.closest(".ag-header-cell[col-id]");
      if (!headerCell) return;
      e.preventDefault();
      e.stopPropagation();
      const colId = headerCell.getAttribute("col-id");
      if (!colId || colId === "row-index") return;
      const colStateArr = state.gridApi?.getColumnState() ?? [];
      const col = colStateArr.find((s) => s.colId === colId);
      const isPinned = col?.pinned === "left";
      const colIndex = parseInt(colId.replace("col_", ""), 10);
      const selectedCols = getSelectedColIndices();
      const n = selectedCols.length > 1 && selectedCols.includes(colIndex) ? selectedCols.length : 1;
      const setLabel = (el, text) => {
        const lbl = el?.querySelector(".col-ctx-label");
        if (lbl) lbl.textContent = text;
      };
      const freezeEl = document.getElementById("col-ctx-freeze");
      const unfreezeEl = document.getElementById("col-ctx-unfreeze");
      if (freezeEl) {
        freezeEl.style.display = isPinned ? "none" : "flex";
        setLabel(freezeEl, n > 1 ? `Freeze ${n} columns` : "Freeze column");
      }
      if (unfreezeEl) {
        unfreezeEl.style.display = isPinned ? "flex" : "none";
        setLabel(unfreezeEl, n > 1 ? `Unfreeze ${n} columns` : "Unfreeze column");
      }
      const unfreezeAllEl = document.getElementById("col-ctx-unfreeze-all");
      if (unfreezeAllEl) {
        const lbl = unfreezeAllEl.querySelector(".col-ctx-label");
        if (lbl) lbl.textContent = `Unfreeze all columns (${state.pinnedCols.size})`;
        unfreezeAllEl.style.display = state.pinnedCols.size > 1 ? "flex" : "none";
      }
      setLabel(document.getElementById("col-ctx-delete"), n > 1 ? `Delete ${n} columns` : "Delete column");
      setLabel(document.getElementById("col-ctx-insert-left"), n > 1 ? `Insert ${n} columns left` : "Insert column left");
      setLabel(document.getElementById("col-ctx-insert-right"), n > 1 ? `Insert ${n} columns right` : "Insert column right");
      menu.dataset.colId = colId;
      closeAllPopups("col-context-menu");
      menu.classList.remove("hidden");
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const mw = menu.offsetWidth || 200;
      const mh = menu.offsetHeight || 240;
      menu.style.left = Math.max(4, Math.min(e.clientX, vw - mw - 4)) + "px";
      menu.style.top = Math.max(4, Math.min(e.clientY, vh - mh - 4)) + "px";
    });
  }

  // src/webview/grid/builder.ts
  var TYPE_LABELS = {
    integer: "Integer",
    float: "Float / Decimal",
    string: "Text",
    boolean: "Boolean",
    date: "Date",
    datetime: "Date & Time",
    time: "Time"
  };
  var codiconSvg = (inner, cls = "") => `<svg width="12" height="12" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="currentColor"${cls ? ` class="${cls}"` : ""}>${inner}</svg>`;
  var CHEVRON_UP = '<path d="M3.14603 9.85423C3.34103 10.0492 3.65803 10.0492 3.85303 9.85423L7.99903 5.70823L12.145 9.85423C12.34 10.0492 12.657 10.0492 12.852 9.85423C13.047 9.65923 13.047 9.34223 12.852 9.14723L8.35203 4.64723C8.15703 4.45223 7.84003 4.45223 7.64503 4.64723L3.14503 9.14723C2.95003 9.34223 2.95103 9.65923 3.14603 9.85423Z"/>';
  var CHEVRON_DOWN = '<path d="M3.14598 5.85423L7.64598 10.3542C7.84098 10.5492 8.15798 10.5492 8.35298 10.3542L12.853 5.85423C13.048 5.65923 13.048 5.34223 12.853 5.14723C12.658 4.95223 12.341 4.95223 12.146 5.14723L7.99998 9.29323L3.85398 5.14723C3.65898 4.95223 3.34198 4.95223 3.14698 5.14723C2.95198 5.34223 2.95098 5.65923 3.14598 5.85423Z"/>';
  var CHEVRON_LEFT = '<path d="M9.14601 3.14623L4.64601 7.64623C4.45101 7.84123 4.45101 8.15823 4.64601 8.35323L9.14601 12.8532C9.34101 13.0482 9.65801 13.0482 9.85301 12.8532C10.048 12.6582 10.048 12.3412 9.85301 12.1462L5.70701 8.00023L9.85301 3.85423C10.048 3.65923 10.048 3.34223 9.85301 3.14723C9.65801 2.95223 9.34101 2.95223 9.14601 3.14723V3.14623Z"/>';
  var CHEVRON_RIGHT = '<path d="M6.14601 3.14579C5.95101 3.34079 5.95101 3.65779 6.14601 3.85279L10.292 7.99879L6.14601 12.1448C5.95101 12.3398 5.95101 12.6568 6.14601 12.8518C6.34101 13.0468 6.65801 13.0468 6.85301 12.8518L11.353 8.35179C11.548 8.15679 11.548 7.83979 11.353 7.64478L6.85301 3.14479C6.65801 2.94979 6.34101 2.95079 6.14601 3.14579Z"/>';
  var GRID_ICONS = {
    sortAscending: codiconSvg('<path d="M4.95693 10.9989C4.14924 10.9989 3.67479 10.0909 4.13603 9.42784L6.76866 5.64342C7.36545 4.78555 8.6346 4.78555 9.23138 5.64342L11.864 9.42784C12.3253 10.0909 11.8508 10.9989 11.0431 10.9989H4.95693Z"/>'),
    sortDescending: codiconSvg('<path d="M4.95693 5C4.14924 5 3.67479 5.90803 4.13603 6.57107L6.76866 10.3555C7.36545 11.2134 8.6346 11.2133 9.23138 10.3555L11.864 6.57106C12.3253 5.90803 11.8508 5 11.0431 5H4.95693Z"/>'),
    // No unsort indicator — the sort glyph appears only once a column is sorted.
    sortUnSort: "",
    // Single funnel-silhouette path. CSS (webview.css → .ag-icon-filter path)
    // strokes it as a thin outline by default and fills it solid white when
    // the column is filtered.
    filter: codiconSvg('<path d="M9.5 14H6.5C6.224 14 6 13.776 6 13.5V9.329C6 8.928 5.844 8.552 5.561 8.268L1.561 4.268C1.205 3.911 1 3.418 1 2.914C1 1.858 1.858 1 2.914 1H13.086C14.142 1 15 1.858 15 2.914C15 3.417 14.796 3.911 14.439 4.267L10.439 8.267C10.156 8.551 10 8.927 10 9.328V13.499C10 13.775 9.776 13.999 9.5 13.999V14Z"/>'),
    menu: codiconSvg('<path d="M8 5C7.44772 5 7 4.55228 7 4C7 3.44772 7.44772 3 8 3C8.55228 3 9 3.44772 9 4C9 4.55228 8.55228 5 8 5ZM8 9C7.44771 9 7 8.55229 7 8C7 7.44772 7.44771 7 8 7C8.55228 7 9 7.44772 9 8C9 8.55229 8.55228 9 8 9ZM7 12C7 12.5523 7.44771 13 8 13C8.55228 13 9 12.5523 9 12C9 11.4477 8.55228 11 8 11C7.44771 11 7 11.4477 7 12Z"/>'),
    columns: codiconSvg('<path d="M2 3.5C2 3.224 2.224 3 2.5 3H10.5C10.776 3 11 3.224 11 3.5C11 3.776 10.776 4 10.5 4H2.5C2.224 4 2 3.776 2 3.5ZM13.5 6H2.5C2.224 6 2 6.224 2 6.5C2 6.776 2.224 7 2.5 7H13.5C13.776 7 14 6.776 14 6.5C14 6.224 13.776 6 13.5 6ZM9.5 9H2.5C2.224 9 2 9.224 2 9.5C2 9.776 2.224 10 2.5 10H9.5C9.776 10 10 9.776 10 9.5C10 9.224 9.776 9 9.5 9Z"/><path d="M2.5 12H11.5C11.776 12 12 12.224 12 12.5C12 12.776 11.776 13 11.5 13H2.5C2.224 13 2 12.776 2 12.5C2 12.224 2.224 12 2.5 12Z"/>'),
    cancel: codiconSvg('<path d="M8.70701 8.00001L12.353 4.35401C12.548 4.15901 12.548 3.84201 12.353 3.64701C12.158 3.45201 11.841 3.45201 11.646 3.64701L8.00001 7.29301L4.35401 3.64701C4.15901 3.45201 3.84201 3.45201 3.64701 3.64701C3.45201 3.84201 3.45201 4.15901 3.64701 4.35401L7.29301 8.00001L3.64701 11.646C3.45201 11.841 3.45201 12.158 3.64701 12.353C3.74501 12.451 3.87301 12.499 4.00101 12.499C4.12901 12.499 4.25701 12.45 4.35501 12.353L8.00101 8.70701L11.647 12.353C11.745 12.451 11.873 12.499 12.001 12.499C12.129 12.499 12.257 12.45 12.355 12.353C12.55 12.158 12.55 11.841 12.355 11.646L8.70901 8.00001H8.70701Z"/>'),
    check: codiconSvg('<path d="M13.6572 3.13573C13.8583 2.9465 14.175 2.95614 14.3643 3.15722C14.5535 3.35831 14.5438 3.675 14.3428 3.86425L5.84277 11.8642C5.64597 12.0494 5.33756 12.0446 5.14648 11.8535L1.64648 8.35351C1.45121 8.15824 1.45121 7.84174 1.64648 7.64647C1.84174 7.45121 2.15825 7.45121 2.35351 7.64647L5.50976 10.8027L13.6572 3.13573Z"/>'),
    first: codiconSvg(CHEVRON_LEFT),
    last: codiconSvg(CHEVRON_RIGHT),
    previous: codiconSvg(CHEVRON_LEFT),
    next: codiconSvg(CHEVRON_RIGHT),
    loading: codiconSvg('<path d="M13.5 8.5C13.224 8.5 13 8.276 13 8C13 5.243 10.757 3 8 3C5.243 3 3 5.243 3 8C3 8.276 2.776 8.5 2.5 8.5C2.224 8.5 2 8.276 2 8C2 4.691 4.691 2 8 2C11.309 2 14 4.691 14 8C14 8.276 13.776 8.5 13.5 8.5Z"/>', "csv-icon-spin"),
    smallUp: codiconSvg(CHEVRON_UP),
    smallDown: codiconSvg(CHEVRON_DOWN),
    smallLeft: codiconSvg(CHEVRON_LEFT),
    smallRight: codiconSvg(CHEVRON_RIGHT)
  };
  function parseTimeToSeconds(s) {
    const m = s.trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?/);
    if (!m) return NaN;
    return +m[1] * 3600 + +m[2] * 60 + +(m[3] ?? 0);
  }
  function textCompare(a, b) {
    return String(a ?? "").localeCompare(String(b ?? ""), void 0, {
      numeric: true,
      sensitivity: "base"
    });
  }
  function typedComparator(parse) {
    return (a, b) => {
      const va = a ? parse(a) : NaN;
      const vb = b ? parse(b) : NaN;
      const aOk = !isNaN(va), bOk = !isNaN(vb);
      if (aOk && bOk) return va - vb;
      if (aOk !== bOk) return aOk ? -1 : 1;
      return textCompare(a, b);
    };
  }
  function makeComparator(colType) {
    if (colType === "integer" || colType === "float") return typedComparator((s) => Number(s));
    if (colType === "date" || colType === "datetime") return typedComparator((s) => Date.parse(s));
    if (colType === "time") return typedComparator(parseTimeToSeconds);
    return textCompare;
  }
  var dblclickWired = false;
  function buildGrid() {
    if (!state.data?.length) return;
    const headerRow = state.data[0];
    const bodyRows = state.data.slice(1);
    const numCols = getNumCols(state.data);
    const columnDefs = [{
      headerName: "#",
      colId: "row-index",
      headerClass: "row-index-header",
      // The frozen (pinned) row shows a pin marker + its original row number so it
      // reads as "the frozen row N", not a duplicate of the body row that now
      // sits at display position N (the body renumbers positionally once a row is
      // pinned out). "Show only duplicates" mode shows the original number; every
      // other row shows its live display position.
      valueGetter: (p) => {
        if (p.node.rowPinned && p.data?._origIndex != null) return p.data._origIndex;
        if (state.dupShowOnly && p.data?._origIndex != null) return p.data._origIndex;
        return p.node.rowIndex + 1;
      },
      cellRenderer: (p) => {
        const txt = p.value == null ? "" : String(p.value);
        if (p.node.rowPinned) {
          return '<span class="row-pin-cell"><i class="codicon codicon-pinned"></i><span class="row-pin-num">' + txt + "</span></span>";
        }
        return txt;
      },
      cellClass: (p) => p.node.rowPinned ? "row-index-cell row-index-pinned" : "row-index-cell",
      width: 48,
      minWidth: 36,
      maxWidth: 80,
      pinned: "left",
      suppressHeaderMenuButton: true,
      sortable: false,
      filter: false,
      editable: false,
      resizable: false,
      suppressMovable: true
    }];
    for (let c = 0; c < numCols; c++) {
      const colType = getColumnType(bodyRows, c);
      state.colTypes[c] = colType;
      const colDef = {
        headerName: headerRow[c] ?? "",
        field: "col_" + c,
        headerClass: "col-type-" + colType,
        headerTooltip: TYPE_LABELS[colType] ?? "Text",
        minWidth: 60,
        editable: !IS_PREVIEW,
        sortable: true,
        filter: createCombinedFilter(colType),
        resizable: true,
        suppressMovable: false,
        // Re-apply column-chooser visibility so hidden columns survive a rebuild.
        hide: state.hiddenCols.has(c),
        // Re-apply the freeze so pinned columns survive a rebuild (column
        // insert/delete, delimiter change, paging) — without this, buildGrid
        // would silently drop the pinning.
        pinned: state.pinnedCols.has(c) ? "left" : void 0
      };
      colDef.comparator = makeComparator(colType);
      columnDefs.push(colDef);
    }
    const rowData = bodyRows.map((row, i) => {
      const obj = { _origIndex: i + 1 };
      for (let c = 0; c < numCols; c++) obj["col_" + c] = row[c] ?? "";
      return obj;
    });
    const { body: bodyRowData, pinnedTop: pinnedTopRowData } = partitionFrozenRows(rowData);
    const container = document.getElementById("grid-container");
    container.innerHTML = "";
    applyGridTheme();
    const ZOOM_SCALE = state.ZOOM_STEPS[state.zoomIndex] / 100;
    const BASE_TEXT_BTN_FONT2 = 11;
    const cellClassRules = {
      ...getFindCellClassRules(),
      ...getRangeCellClassRules(),
      "cell-dup-row": (p) => state.dupRowSet.size > 0 && p.data?._origIndex != null && state.dupRowSet.has(p.data._origIndex)
    };
    const gridOptions = {
      columnDefs,
      rowData: bodyRowData,
      pinnedTopRowData,
      defaultColDef: {
        flex: 0,
        width: 130,
        editable: !IS_PREVIEW,
        sortable: true,
        resizable: true,
        cellClassRules
      },
      // External filter for "show only duplicates" mode — kept independent of
      // user column filters so toggling dup-only doesn't clobber them.
      isExternalFilterPresent: () => state.dupShowOnly,
      doesExternalFilterPass: (node) => !!node.data && node.data._origIndex != null && state.dupRowSet.has(node.data._origIndex),
      // Codicon glyphs as inline SVG — defined in GRID_ICONS at the top of
      // this file. AG Grid's own icon font is blocked in VS Code webviews.
      icons: GRID_ICONS,
      animateRows: false,
      // Ctrl+click a second/third header to sort by multiple columns.
      multiSortKey: "ctrl",
      tooltipShowDelay: 400,
      tooltipHideDelay: 3e3,
      suppressFieldDotNotation: true,
      singleClickEdit: false,
      stopEditingWhenCellsLoseFocus: true,
      undoRedoCellEditing: false,
      // Issue #6 — after committing an edit with Enter, move the selection to
      // the cell below (Excel / Google Sheets behaviour). Deliberately NOT
      // enterNavigatesVertically: that variant hijacks Enter on a focused (not
      // editing) cell, which today is what opens the cell for editing.
      enterNavigatesVerticallyAfterEdit: true,
      // Issue #5 — give AG Grid a row id so a rowData swap (refreshGrid: delete
      // row, paste, insert, undo/redo, find-replace) does an incremental,
      // id-matched update instead of destroying every node, which is what reset
      // the scroll to the top. AG Grid takes the display order from the new
      // rowData array (matched ids are reused with their data refreshed, surplus
      // ids removed), so content stays correct; the ids that persist keep the
      // viewport's nodes alive, so the scroll position survives.
      //
      // The id is intentionally POSITIONAL: _origIndex is the row's current
      // 1-based slot in state.data, set identically by buildGrid/refreshGrid.
      // It is unique per refresh, and because it is positional the ids still
      // line up after undo — which deep-clones state.data (JSON round-trip), so
      // a *permanent* per-row uid would look all-new and reset the scroll on
      // every undo. Do NOT "stabilise" this into a per-row uid: positional ids
      // preserve scroll across more paths, and the shifted node-reuse after a
      // mid-list delete is harmless (each node re-reads its data from the array;
      // only the surplus tail node is dropped).
      getRowId: (p) => String(p.data._origIndex),
      onCellClicked: (event) => {
        if (event.rowPinned) return;
        const colId = event.column?.getColId?.() ?? event.column;
        if (colId != null && event.rowIndex != null) {
          state.focusedCellColId = colId;
          state.focusedCellRowIndex = event.rowIndex;
        }
      },
      onCellFocused: (event) => {
        if (!event.rowPinned && event.column && event.rowIndex != null) {
          const colId = typeof event.column === "string" ? event.column : event.column.getColId();
          state.focusedCellColId = colId;
          state.focusedCellRowIndex = event.rowIndex;
        } else {
          state.focusedCellColId = null;
          state.focusedCellRowIndex = null;
        }
      },
      onCellEditingStarted: () => {
        state.isCellEditing = true;
      },
      onCellEditingStopped: () => {
        state.isCellEditing = false;
      },
      // Range selection (Excel-style) — hand-rolled since AG Grid Community has no
      // built-in cell-range selection.
      onCellMouseDown: onCellMouseDownHandler,
      onCellMouseOver: onCellMouseOverHandler,
      // A rowData reset (undo/redo, row insert/delete, paste, dup-view) shifts
      // display indices, so the display-coordinate selection must be dropped.
      onRowDataUpdated: () => {
        clearRangeSelection();
        state.gridApi?.refreshCells({ columns: ["row-index"], force: true });
      },
      // Display indices shift when sorting or filtering — clear the selection so
      // the highlight doesn't appear on the wrong cells.
      onSortChanged: () => {
        clearRangeSelection();
        state.gridApi?.refreshCells({ columns: ["row-index"], force: true });
      },
      onFilterChanged: () => {
        clearRangeSelection();
        state.gridApi?.refreshCells({ columns: ["row-index"], force: true });
        const isAnyFilter = state.gridApi?.isAnyFilterPresent();
        const cfBtn = document.getElementById("btn-clear-filters");
        const sepBtn = document.getElementById("sep-filters");
        if (cfBtn) {
          cfBtn.style.display = isAnyFilter ? "" : "none";
          cfBtn.style.fontSize = Math.round(BASE_TEXT_BTN_FONT2 * ZOOM_SCALE) + "px";
        }
        if (sepBtn) sepBtn.style.display = isAnyFilter ? "" : "none";
        updateCountsDisplay();
      },
      onCellValueChanged: (event) => {
        const dataIndex = dataRowIndexForNode(event.node);
        const colField = event.colDef.field;
        if (!colField) return;
        const colIndex = parseInt(colField.replace("col_", ""));
        pushUndo();
        while (state.data[dataIndex].length <= colIndex) state.data[dataIndex].push("");
        state.data[dataIndex][colIndex] = event.newValue != null ? String(event.newValue) : "";
        notifyChange();
        scheduleRecomputeColTypes();
      }
    };
    state.gridApi = agGrid.createGrid(container, gridOptions);
    updateButtons();
    applyColorMode();
    if (!dblclickWired) {
      dblclickWired = true;
      container.addEventListener("dblclick", (e) => {
        const target = e.target;
        if (target?.classList.contains("ag-header-cell-resize")) {
          const headerCell = target.closest(".ag-header-cell");
          if (headerCell) {
            const colId = headerCell.getAttribute("col-id");
            if (colId) state.gridApi.autoSizeColumns([colId]);
          }
        }
      });
    }
    updateCountsDisplay();
    refreshProfileIfOpen();
    setTimeout(attachHeaderContextMenus, 80);
  }

  // src/webview/features/auto-fit.ts
  function measureTextWidths() {
    const { data, colTypes } = state;
    const headerRow = data[0];
    const bodyRows = data.slice(1);
    const numCols = getNumCols(data);
    const scale = state.ZOOM_STEPS[state.zoomIndex] / 100;
    const cellPad = Math.round(6 * scale) * 2;
    let fontFamily = '"Segoe UI", sans-serif';
    let fontSize = Math.round(13 * scale);
    let letterSpacing = 0;
    let wordSpacing = "";
    const sampleEl = document.querySelector(".ag-cell .ag-cell-value") ?? document.querySelector(".ag-cell-value") ?? document.querySelector(".ag-cell");
    if (sampleEl) {
      const cs = getComputedStyle(sampleEl);
      if (cs.fontFamily?.trim()) fontFamily = cs.fontFamily;
      const fs = parseFloat(cs.fontSize);
      if (fs > 0) fontSize = fs;
      const ls = parseFloat(cs.letterSpacing);
      if (!isNaN(ls)) letterSpacing = ls;
      if (cs.wordSpacing && cs.wordSpacing !== "normal") wordSpacing = cs.wordSpacing;
    }
    console.log(`[AutoFit-fonts] sampleEl="${sampleEl?.className ?? "NULL"}" fontFamily="${fontFamily}" fontSize=${fontSize}px letterSpacing=${letterSpacing}px wordSpacing="${wordSpacing}"`);
    const dcDiag = document.querySelector(".ag-cell:not(.row-index-cell)[col-id]") ?? document.querySelector('[col-id="col_1"]');
    if (dcDiag) {
      const dcs = getComputedStyle(dcDiag);
      console.log(`[AutoFit-datacell] col="${dcDiag.getAttribute("col-id")}" class="${dcDiag.className.substring(0, 80)}" fontSize=${dcs.fontSize} fontWeight=${dcs.fontWeight}`);
    } else {
      console.log("[AutoFit-datacell] no data cell found in DOM");
    }
    const CELL_EXTRA = cellPad + 20;
    const HEADER_EXTRA = cellPad + 44;
    const TOP_N = 50;
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    ctx.font = `400 ${fontSize}px ${fontFamily}`;
    const topCandidates = [];
    for (let c = 0; c < numCols; c++) {
      const top = [];
      let minTopW = 0;
      for (let r = 0; r < bodyRows.length; r++) {
        const val = bodyRows[r]?.[c] != null ? String(bodyRows[r][c]) : "";
        if (!val) continue;
        const m = ctx.measureText(val);
        const canvasW = m.actualBoundingBoxLeft !== void 0 && m.actualBoundingBoxRight !== void 0 && Math.abs(m.actualBoundingBoxLeft) + m.actualBoundingBoxRight > 0 ? Math.abs(m.actualBoundingBoxLeft) + m.actualBoundingBoxRight : m.width;
        const w = letterSpacing > 0 ? canvasW + (val.length - 1) * letterSpacing : canvasW;
        if (top.length < TOP_N || w > minTopW) {
          top.push({ val, w });
          if (top.length > TOP_N) {
            let minIdx = 0;
            for (let i = 1; i < top.length; i++) if (top[i].w < top[minIdx].w) minIdx = i;
            top.splice(minIdx, 1);
          }
          minTopW = top.length === TOP_N ? top.reduce((m2, t) => Math.min(m2, t.w), Infinity) : 0;
        }
      }
      const deduped = [...new Set(top.map((t) => t.val))];
      topCandidates.push(deduped);
      {
        let beV = "";
        for (let r = 0; r < bodyRows.length; r++) {
          const v = bodyRows[r]?.[c] != null ? String(bodyRows[r][c]) : "";
          if (v.includes("I'll Be There") && v.length > beV.length) beV = v;
        }
        if (beV) {
          const inTop = deduped.includes(beV);
          const m2 = ctx.measureText(beV);
          const cw2 = m2.actualBoundingBoxLeft !== void 0 && m2.actualBoundingBoxRight !== void 0 && Math.abs(m2.actualBoundingBoxLeft) + m2.actualBoundingBoxRight > 0 ? Math.abs(m2.actualBoundingBoxLeft) + m2.actualBoundingBoxRight : m2.width;
          const w2 = letterSpacing > 0 ? cw2 + (beV.length - 1) * letterSpacing : cw2;
          const topMin = top.length > 0 ? top.reduce((mn, t) => Math.min(mn, t.w), Infinity) : 0;
          console.log(`[AutoFit-rank] col_${c} "I'll Be There..."(len=${beV.length}) canvasScore=${w2.toFixed(1)} inTop50=${inTop} top50min=${topMin.toFixed(1)}`);
        }
      }
    }
    const probeParent = document.querySelector(".ag-root-wrapper") ?? document.querySelector(".ag-theme-alpine-dark") ?? document.getElementById("grid-container") ?? document.body;
    const probe = document.createElement("span");
    probe.style.position = "fixed";
    probe.style.top = "0";
    probe.style.left = "0";
    probe.style.opacity = "0";
    probe.style.pointerEvents = "none";
    probe.style.zIndex = "-9999";
    probe.style.whiteSpace = "nowrap";
    probe.style.fontFamily = fontFamily;
    probe.style.fontSize = fontSize + "px";
    if (letterSpacing !== 0) probe.style.letterSpacing = letterSpacing + "px";
    if (wordSpacing) probe.style.wordSpacing = wordSpacing;
    probeParent.appendChild(probe);
    let calibFactor = 1;
    {
      const samples = [];
      document.querySelectorAll(".ag-cell[col-id]").forEach((cell) => {
        if (cell.scrollWidth > cell.offsetWidth) return;
        const textEl = cell.querySelector(".ag-cell-value") ?? cell;
        const text = textEl.textContent?.trim() ?? "";
        if (text.length < 8) return;
        const findTextNode = (node) => {
          for (const child of Array.from(node.childNodes)) {
            if (child.nodeType === Node.TEXT_NODE && child.data.trim()) return child;
            const found = findTextNode(child);
            if (found) return found;
          }
          return null;
        };
        const textNode = findTextNode(textEl);
        if (!textNode) return;
        const range = document.createRange();
        range.selectNode(textNode);
        const rangeW = range.getBoundingClientRect().width;
        if (rangeW < 10) return;
        probe.style.fontWeight = getComputedStyle(textEl).fontWeight || "400";
        probe.textContent = text;
        const probeW = probe.offsetWidth;
        if (probeW < 10) return;
        samples.push(rangeW / probeW);
      });
      if (samples.length >= 3) {
        const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
        calibFactor = Math.min(1.5, Math.max(0.95, avg));
      }
      console.log(`[AutoFit-calib] factor=${calibFactor.toFixed(4)} from ${samples.length} cells`);
    }
    const badgeFontSize = Math.round(9 * scale);
    const TYPE_BADGE_TEXT = {
      integer: "123",
      float: "1.0",
      string: "abc",
      boolean: "T/F",
      date: "date",
      datetime: "dt",
      time: "time"
    };
    const badgeWidthCache = {};
    probe.style.fontSize = badgeFontSize + "px";
    probe.style.fontWeight = "700";
    for (const key in TYPE_BADGE_TEXT) {
      probe.textContent = TYPE_BADGE_TEXT[key];
      badgeWidthCache[key] = probe.offsetWidth + 13;
    }
    const colState = [];
    for (let c = 0; c < numCols; c++) {
      probe.style.fontSize = fontSize + "px";
      probe.style.fontWeight = "600";
      probe.textContent = headerRow?.[c] ?? "";
      const badgePx = badgeWidthCache[colTypes[c]] ?? badgeWidthCache["string"];
      const headerW = probe.offsetWidth + HEADER_EXTRA + badgePx;
      probe.style.fontWeight = "400";
      let maxBodyW = 0;
      for (const val of topCandidates[c]) {
        probe.textContent = val;
        const w = Math.ceil(probe.offsetWidth * calibFactor) + CELL_EXTRA;
        if (w > maxBodyW) maxBodyW = w;
      }
      const finalW = Math.max(60, Math.ceil(Math.max(headerW, maxBodyW)));
      console.log(
        `[AutoFit-A] col_${c} "${headerRow?.[c]}" \u2192 ${finalW}px (headerW=${Math.ceil(headerW)}, maxBodyW=${Math.ceil(maxBodyW)}) top1="${(topCandidates[c][0] ?? "").substring(0, 60)}"`
      );
      {
        let beV = "";
        for (let r = 0; r < bodyRows.length; r++) {
          const v = bodyRows[r]?.[c] != null ? String(bodyRows[r][c]) : "";
          if (v.includes("I'll Be There") && v.length > beV.length) beV = v;
        }
        if (beV) {
          const inTop = topCandidates[c].includes(beV);
          probe.style.fontWeight = "400";
          probe.textContent = beV;
          const rawProbeW = probe.offsetWidth;
          const calibW = Math.ceil(rawProbeW * calibFactor);
          const needed = calibW + CELL_EXTRA;
          console.log(`[AutoFit-probe] col_${c} "I'll Be There..."(len=${beV.length}) inTop50=${inTop} rawProbe=${rawProbeW} calibrated=${calibW} needed=${needed} colWidth=${finalW} ok=${needed <= finalW}`);
        }
      }
      colState.push({ colId: "col_" + c, width: finalW });
    }
    probeParent.removeChild(probe);
    return colState;
  }
  function toggleAutoFit() {
    if (!state.gridApi) return;
    if (!state.isAutoFitted) {
      if (state.autoFitCache && state.autoFitCacheZoom === state.zoomIndex) {
        state.gridApi.applyColumnState({ state: state.autoFitCache });
        state.isAutoFitted = true;
        return;
      }
      showLoader("Fitting columns\u2026");
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const numCols = getNumCols(state.data);
        const expandedState = Array.from({ length: numCols }, (_, i) => ({ colId: `col_${i}`, width: 3e3 }));
        state.gridApi.applyColumnState({ state: expandedState });
        requestAnimationFrame(() => requestAnimationFrame(() => {
          let phaseAWidths = [];
          try {
            phaseAWidths = measureTextWidths();
            state.gridApi.applyColumnState({ state: phaseAWidths });
          } catch (err) {
            console.error("[AutoFit Phase A]", err);
            hideLoader();
            return;
          }
          requestAnimationFrame(() => requestAnimationFrame(() => {
            try {
              const scale = state.ZOOM_STEPS[state.zoomIndex] / 100;
              const cellPadSingle = Math.round(6 * scale);
              let corrected = false;
              const finalState = phaseAWidths.map(({ colId, width }) => {
                let maxNeeded = 0;
                document.querySelectorAll(`.ag-cell[col-id="${colId}"]`).forEach((cell) => {
                  if (cell.scrollWidth > cell.offsetWidth) {
                    const needed = cell.scrollWidth + cellPadSingle + 12;
                    if (needed > maxNeeded) maxNeeded = needed;
                  }
                });
                if (maxNeeded > width) {
                  corrected = true;
                  return { colId, width: maxNeeded };
                }
                return { colId, width };
              });
              if (corrected) {
                const fixes = finalState.filter((f, i) => f.width !== phaseAWidths[i]?.width);
                console.log("[AutoFit-B] corrections:", fixes.map((f) => `${f.colId}=${f.width}px`).join(", "));
                state.gridApi.applyColumnState({ state: finalState });
              } else {
                console.log("[AutoFit-B] no corrections needed (all visible cells fit)");
              }
              state.autoFitCache = finalState;
              state.autoFitCacheZoom = state.zoomIndex;
              state.isAutoFitted = true;
            } catch (err) {
              console.error("[AutoFit verify]", err);
              state.autoFitCache = phaseAWidths;
              state.autoFitCacheZoom = state.zoomIndex;
              state.isAutoFitted = true;
            }
            hideLoader();
          }));
        }));
      }));
    } else {
      buildGrid();
      state.isAutoFitted = false;
    }
  }
  function setupAutoFit() {
    document.getElementById("btn-autofit")?.addEventListener("click", toggleAutoFit);
    document.getElementById("btn-clear-filters")?.addEventListener("click", () => {
      state.gridApi?.setFilterModel(null);
    });
  }

  // src/webview/features/delimiter.ts
  function updateDelimiterBadge(delimiter) {
    const badge = document.getElementById("delim-badge");
    if (badge) badge.textContent = "Delim: " + (delimiter === "	" ? "TAB" : delimiter);
  }
  function setupDelimiterBadge() {
    const badge = document.getElementById("delim-badge");
    const dropdown = document.getElementById("delim-dropdown");
    if (!badge || !dropdown) return;
    badge.addEventListener("click", (e) => {
      e.stopPropagation();
      const wasOpen = !dropdown.classList.contains("hidden");
      closeAllPopups();
      if (wasOpen) return;
      const r = badge.getBoundingClientRect();
      dropdown.style.left = r.left + "px";
      dropdown.style.top = r.bottom + 2 + "px";
      dropdown.classList.remove("hidden");
    });
    document.querySelectorAll(".delim-option").forEach((opt) => {
      opt.addEventListener("click", () => {
        const raw = opt.dataset.delim ?? ",";
        state.currentDelimiter = raw === "\\t" ? "	" : raw;
        updateDelimiterBadge(state.currentDelimiter);
        dropdown.classList.add("hidden");
        const frozen = frozenRowPositions();
        state.data = parseCsv(state.rawCsvText, state.currentDelimiter);
        reanchorFrozenRows(frozen);
        state.hiddenCols.clear();
        state.autoFitCache = null;
        state.colTypes = [];
        buildGrid();
      });
    });
    document.addEventListener("click", () => dropdown.classList.add("hidden"));
  }

  // src/webview/utils/export-formats.ts
  function uniqueKeys(headers) {
    const used = /* @__PURE__ */ new Set();
    return headers.map((h, i) => {
      const base = (h ?? "").trim() || `column_${i + 1}`;
      let key = base;
      for (let n = 2; used.has(key); n++) key = `${base}_${n}`;
      used.add(key);
      return key;
    });
  }
  var SAFE_NUMBER_RE = /^-?(0|[1-9]\d*)(\.\d+)?$/;
  function coerceValue(raw, type) {
    if (type === "string") return raw;
    const t = raw.trim();
    if (t === "") return null;
    if (type === "integer" || type === "float") {
      if (SAFE_NUMBER_RE.test(t)) {
        const n = Number(t);
        if (t.indexOf(".") >= 0 || Number.isSafeInteger(n)) return n;
      }
      return raw;
    }
    if (type === "boolean") {
      const lower = t.toLowerCase();
      if (lower === "true") return true;
      if (lower === "false") return false;
      return raw;
    }
    return raw;
  }
  function toObjects(headers, rows, types) {
    const keys = uniqueKeys(headers);
    return rows.map((row) => {
      const obj = {};
      for (let c = 0; c < keys.length; c++) {
        obj[keys[c]] = coerceValue(row[c] ?? "", types[c] ?? "string");
      }
      return obj;
    });
  }
  function toJson(headers, rows, types) {
    return JSON.stringify(toObjects(headers, rows, types), null, 2) + "\n";
  }
  function toJsonLines(headers, rows, types) {
    return toObjects(headers, rows, types).map((o) => JSON.stringify(o)).join("\n") + "\n";
  }
  function escapeMarkdownCell(value) {
    return value.replace(/\|/g, "\\|").replace(/\r\n|\r|\n/g, "<br>");
  }
  function toMarkdownTable(headers, rows, types) {
    const numCols = headers.length;
    const sep = headers.map((_, c) => {
      const t = types[c] ?? "string";
      return t === "integer" || t === "float" ? "---:" : "---";
    });
    const line = (cells) => "| " + cells.map(escapeMarkdownCell).join(" | ") + " |";
    const out = [line(headers), "| " + sep.join(" | ") + " |"];
    for (const row of rows) {
      const cells = [];
      for (let c = 0; c < numCols; c++) cells.push(row[c] ?? "");
      out.push(line(cells));
    }
    return out.join("\n") + "\n";
  }

  // src/webview/features/export.ts
  var FORMAT_EXT = {
    json: ".json",
    jsonl: ".jsonl",
    md: ".md"
  };
  function collectView() {
    const colDefs = state.gridApi.getColumnDefs().filter((c) => {
      const id = String(c.field ?? c.colId ?? "");
      if (c.colId === "row-index" || id === "") return false;
      const ci = parseInt(id.replace("col_", ""), 10);
      return !state.hiddenCols.has(ci);
    });
    const fields = colDefs.map((c) => String(c.field ?? c.colId));
    const headers = colDefs.map((c) => String(c.headerName ?? ""));
    const types = fields.map((f) => {
      const ci = parseInt(f.replace("col_", ""), 10);
      return state.colTypes[ci] ?? "string";
    });
    const rows = [];
    const pushRow = (data) => {
      if (!data) return;
      rows.push(fields.map((f) => data[f] != null ? String(data[f]) : ""));
    };
    const pinnedCount = state.gridApi.getPinnedTopRowCount?.() ?? 0;
    for (let i = 0; i < pinnedCount; i++) pushRow(state.gridApi.getPinnedTopRow(i)?.data);
    state.gridApi.forEachNodeAfterFilterAndSort((node) => pushRow(node.data));
    return { headers, rows, types };
  }
  function runExport(format) {
    if (!state.gridApi) return;
    const { headers, rows, types } = collectView();
    let text;
    if (format === "json") text = toJson(headers, rows, types);
    else if (format === "jsonl") text = toJsonLines(headers, rows, types);
    else text = toMarkdownTable(headers, rows, types);
    const base = FILENAME ? FILENAME.replace(/\.[^.]+$/, "") : "export";
    const name = (base || "export") + "_export" + FORMAT_EXT[format];
    vscodeApi.postMessage({ type: "export", text, filename: name });
  }
  function setupExport() {
    const btn = document.getElementById("btn-export");
    const dropdown = document.getElementById("export-dropdown");
    if (!btn || !dropdown) return;
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const wasOpen = !dropdown.classList.contains("hidden");
      closeAllPopups();
      if (wasOpen) return;
      const r = btn.getBoundingClientRect();
      dropdown.style.top = r.bottom + 2 + "px";
      dropdown.classList.remove("hidden");
      const w = dropdown.offsetWidth || 140;
      dropdown.style.left = Math.max(4, Math.min(r.left, window.innerWidth - w - 4)) + "px";
    });
    document.querySelectorAll(".export-option").forEach((opt) => {
      opt.addEventListener("click", () => {
        dropdown.classList.add("hidden");
        runExport(opt.dataset.format ?? "json");
      });
    });
    document.addEventListener("click", () => dropdown.classList.add("hidden"));
  }

  // src/webview/grid/mutations.ts
  function deleteColumnsFromData(data, colIndices) {
    const drop = /* @__PURE__ */ new Set();
    for (const c of colIndices) if (Number.isInteger(c) && c >= 0) drop.add(c);
    if (drop.size === 0) return data;
    return data.map((row) => row.filter((_, i) => !drop.has(i)));
  }
  function deleteRowsFromData(data, origIndices) {
    const drop = /* @__PURE__ */ new Set();
    for (const i of origIndices) if (Number.isInteger(i) && i >= 1) drop.add(i);
    if (drop.size === 0) return data;
    return data.filter((_, i) => i === 0 || !drop.has(i));
  }
  function insertRowsIntoData(data, atIndex, count, numCols) {
    if (count < 1) return data;
    const blanks = Array.from({ length: count }, () => Array(numCols).fill(""));
    const out = data.slice();
    out.splice(atIndex, 0, ...blanks);
    return out;
  }
  function insertColumnsIntoData(data, atIndex, count) {
    if (count < 1) return data;
    return data.map((row) => {
      const copy = row.slice();
      copy.splice(atIndex, 0, ...Array(count).fill(""));
      return copy;
    });
  }
  function shiftIndicesAfterDelete(indices, deleted) {
    const del = deleted instanceof Set ? deleted : new Set(deleted);
    const out = /* @__PURE__ */ new Set();
    for (const i of indices) {
      if (del.has(i)) continue;
      let shift = 0;
      for (const d of del) if (d < i) shift++;
      out.add(i - shift);
    }
    return out;
  }
  function shiftIndicesAfterInsert(indices, at, count) {
    const out = /* @__PURE__ */ new Set();
    for (const i of indices) out.add(i >= at ? i + count : i);
    return out;
  }

  // src/webview/features/delete-row-col.ts
  function deleteColumn(colId) {
    const colIndex = parseInt(colId.replace("col_", ""), 10);
    if (isNaN(colIndex)) return;
    deleteColumns([colIndex]);
  }
  function deleteColumns(colIndices) {
    const indices = colIndices.filter((c) => Number.isInteger(c) && c >= 0);
    if (indices.length === 0) return;
    pushUndo();
    const frozenIdxs = state.frozenRowRefs.map((r) => state.data.indexOf(r)).filter((i) => i >= 0);
    state.data = deleteColumnsFromData(state.data, indices);
    state.frozenRowRefs = frozenIdxs.map((i) => state.data[i]);
    state.pinnedCols = shiftIndicesAfterDelete(state.pinnedCols, indices);
    state.hiddenCols.clear();
    state.isAutoFitted = false;
    state.autoFitCache = null;
    clearRangeSelection();
    buildGrid();
    notifyChange();
  }
  function deleteRows(displayIndices) {
    if (displayIndices.length === 0 || !state.gridApi) return;
    pushUndo();
    const toDelete = /* @__PURE__ */ new Set();
    for (const di of displayIndices) {
      const oi = state.gridApi.getDisplayedRowAtIndex(di)?.data?._origIndex;
      if (oi != null) toDelete.add(Number(oi));
    }
    state.data = deleteRowsFromData(state.data, toDelete);
    state.isAutoFitted = false;
    state.autoFitCache = null;
    refreshGrid();
    recomputeColTypes();
    notifyChange();
  }
  function insertRows(anchorDisplayIndex, position, count) {
    if (!state.gridApi || count < 1) return;
    const targetNode = state.gridApi.getDisplayedRowAtIndex(anchorDisplayIndex);
    if (!targetNode?.data) return;
    const targetOrig = Number(targetNode.data._origIndex);
    if (!targetOrig || !state.data[targetOrig]) return;
    const targetRowRef = state.data[targetOrig];
    const colState = state.gridApi.getColumnState();
    const hasActiveSort = colState.some((s) => s.sort);
    pushUndo();
    if (hasActiveSort) {
      const header = state.data[0];
      const visible = [];
      const visibleOrigs = /* @__PURE__ */ new Set();
      state.gridApi.forEachNodeAfterFilterAndSort((node) => {
        const oi = Number(node.data?._origIndex);
        if (oi && state.data[oi]) {
          visible.push(state.data[oi]);
          visibleOrigs.add(oi);
        }
      });
      const hidden = [];
      for (let i = 1; i < state.data.length; i++) {
        if (!visibleOrigs.has(i)) hidden.push(state.data[i]);
      }
      state.data = [header, ...visible, ...hidden];
      state.gridApi.applyColumnState({
        state: colState.map((s) => ({ ...s, sort: null }))
      });
    }
    const targetIndex = state.data.indexOf(targetRowRef);
    if (targetIndex < 0) return;
    const insertAt = position === "above" ? targetIndex : targetIndex + 1;
    const numCols = getNumCols(state.data);
    state.data = insertRowsIntoData(state.data, insertAt, count, numCols);
    state.isAutoFitted = false;
    state.autoFitCache = null;
    refreshGrid();
    recomputeColTypes();
    notifyChange();
  }
  function insertColumns(baseIndex, position, count) {
    if (count < 1 || isNaN(baseIndex)) return;
    const insertAt = position === "left" ? baseIndex : baseIndex + 1;
    pushUndo();
    const frozenIdxs = state.frozenRowRefs.map((r) => state.data.indexOf(r)).filter((i) => i >= 0);
    state.data = insertColumnsIntoData(state.data, insertAt, count);
    state.frozenRowRefs = frozenIdxs.map((i) => state.data[i]);
    state.pinnedCols = shiftIndicesAfterInsert(state.pinnedCols, insertAt, count);
    state.hiddenCols.clear();
    state.isAutoFitted = false;
    state.autoFitCache = null;
    clearRangeSelection();
    buildGrid();
    notifyChange();
  }
  function makeRowItem(label, iconClass, danger = false) {
    const item = document.createElement("div");
    item.className = "row-ctx-item" + (danger ? " danger" : "");
    const icon = document.createElement("i");
    icon.className = "codicon " + iconClass;
    const span = document.createElement("span");
    span.className = "row-ctx-label";
    span.textContent = label;
    item.append(icon, span);
    return item;
  }
  function hideMenu() {
    document.getElementById("row-context-menu")?.classList.add("hidden");
  }
  function showContextMenu(x, y, rowIndex, colId, isPinnedRow = false, pinnedOrig = null) {
    const menu = document.getElementById("row-context-menu");
    if (!menu) return;
    closeAllPopups("row-context-menu");
    menu.innerHTML = "";
    const resolveNode = () => isPinnedRow ? state.gridApi?.getPinnedTopRow(rowIndex ?? 0) : rowIndex === null ? null : state.gridApi?.getDisplayedRowAtIndex(rowIndex);
    if (hasMultiSelection()) {
      const copyRange = makeRowItem("Copy", "codicon-copy");
      copyRange.addEventListener("click", () => {
        copySelection(false);
        hideMenu();
      });
      menu.appendChild(copyRange);
      const copyWithHeader = makeRowItem("Copy with header", "codicon-copy");
      copyWithHeader.addEventListener("click", () => {
        copySelection(true);
        hideMenu();
      });
      menu.appendChild(copyWithHeader);
      const sep = document.createElement("div");
      sep.className = "col-ctx-separator";
      menu.appendChild(sep);
    } else if (colId && rowIndex !== null && colId !== "row-index") {
      const node = resolveNode();
      const raw = node?.data?.[colId];
      const value = raw != null ? String(raw) : "";
      const copyItem = makeRowItem("Copy", "codicon-copy");
      copyItem.addEventListener("click", () => {
        navigator.clipboard.writeText(value).catch(() => {
        });
        hideMenu();
      });
      menu.appendChild(copyItem);
      const sep = document.createElement("div");
      sep.className = "col-ctx-separator";
      menu.appendChild(sep);
    }
    if (state.dupRowSet.size === 0 && !state.dupShowOnly) {
      if (isPinnedRow) {
        const clickedOrig = pinnedOrig;
        if (clickedOrig != null) {
          const item = makeRowItem("Unfreeze row", "codicon-pin");
          item.addEventListener("click", () => {
            unfreezeRow(clickedOrig);
            hideMenu();
          });
          menu.appendChild(item);
        }
      } else if (rowIndex !== null) {
        const selectedRows = getSelectedRowDisplayIndices();
        const inSel = selectedRows.length > 1 && selectedRows.includes(rowIndex);
        const displayRows = inSel ? selectedRows : [rowIndex];
        const origs = [];
        for (const di of displayRows) {
          const oi = state.gridApi?.getDisplayedRowAtIndex(di)?.data?._origIndex;
          if (oi != null) origs.push(Number(oi));
        }
        if (origs.length > 0) {
          const item = makeRowItem(origs.length > 1 ? `Freeze ${origs.length} rows` : "Freeze row", "codicon-pinned");
          item.addEventListener("click", () => {
            freezeRows(origs);
            hideMenu();
          });
          menu.appendChild(item);
        }
      }
      if (frozenRowCount() > 1) {
        const all = makeRowItem(`Unfreeze all rows (${frozenRowCount()})`, "codicon-pin");
        all.addEventListener("click", () => {
          unfreezeAllRows();
          hideMenu();
        });
        menu.appendChild(all);
      }
      const hasFreezeItem = isPinnedRow && pinnedOrig != null || !isPinnedRow && rowIndex !== null || frozenRowCount() > 1;
      if (hasFreezeItem) {
        const sep = document.createElement("div");
        sep.className = "col-ctx-separator";
        menu.appendChild(sep);
      }
    }
    if (rowIndex !== null && !IS_PREVIEW && !isPinnedRow) {
      const selectedRows = getSelectedRowDisplayIndices();
      const inSel = selectedRows.length > 1 && selectedRows.includes(rowIndex);
      const count = inSel ? selectedRows.length : 1;
      const topEdge = inSel ? Math.min(...selectedRows) : rowIndex;
      const bottomEdge = inSel ? Math.max(...selectedRows) : rowIndex;
      const insertAbove = makeRowItem(count > 1 ? `Insert ${count} rows above` : "Insert row above", "codicon-arrow-up");
      insertAbove.addEventListener("click", () => {
        insertRows(topEdge, "above", count);
        hideMenu();
      });
      menu.appendChild(insertAbove);
      const insertBelow = makeRowItem(count > 1 ? `Insert ${count} rows below` : "Insert row below", "codicon-arrow-down");
      insertBelow.addEventListener("click", () => {
        insertRows(bottomEdge, "below", count);
        hideMenu();
      });
      menu.appendChild(insertBelow);
      const sep = document.createElement("div");
      sep.className = "col-ctx-separator";
      menu.appendChild(sep);
    }
    if (rowIndex !== null && !IS_PREVIEW && !isPinnedRow) {
      const selectedRows = getSelectedRowDisplayIndices();
      const rowIndices = selectedRows.length > 1 && selectedRows.includes(rowIndex) ? selectedRows : [rowIndex];
      const delRowItem = makeRowItem(rowIndices.length > 1 ? `Delete ${rowIndices.length} rows` : "Delete row", "codicon-trash", true);
      delRowItem.addEventListener("click", () => {
        deleteRows(rowIndices);
        hideMenu();
      });
      menu.appendChild(delRowItem);
    }
    if (colId && colId !== "row-index" && !IS_PREVIEW) {
      const colIndex = parseInt(colId.replace("col_", ""), 10);
      const selectedCols = getSelectedColIndices();
      const useMulti = selectedCols.length > 1 && selectedCols.includes(colIndex);
      const delColItem = makeRowItem(useMulti ? `Delete ${selectedCols.length} columns` : "Delete column", "codicon-trash", true);
      delColItem.addEventListener("click", () => {
        if (useMulti) deleteColumns(selectedCols);
        else if (colId) deleteColumn(colId);
        hideMenu();
      });
      menu.appendChild(delColItem);
    }
    const items = Array.from(menu.children);
    let lastWasSep = true;
    for (const el of items) {
      const isSep = el.classList.contains("col-ctx-separator");
      if (isSep && lastWasSep) {
        el.remove();
        continue;
      }
      lastWasSep = isSep;
    }
    const last = menu.lastElementChild;
    if (last?.classList.contains("col-ctx-separator")) last.remove();
    if (menu.children.length === 0) return;
    menu.classList.remove("hidden");
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const mw = menu.offsetWidth || 160;
    const mh = menu.offsetHeight || 80;
    menu.style.left = Math.min(x, vw - mw - 4) + "px";
    menu.style.top = Math.min(y, vh - mh - 4) + "px";
    const closeHandler = (evt) => {
      if (!menu.contains(evt.target)) {
        hideMenu();
        document.removeEventListener("mousedown", closeHandler, true);
      }
    };
    setTimeout(() => document.addEventListener("mousedown", closeHandler, true), 0);
  }
  function setupDeleteRowCol() {
    const colMenu = document.getElementById("col-context-menu");
    document.getElementById("col-ctx-delete")?.addEventListener("click", () => {
      const colId = colMenu?.dataset.colId;
      colMenu?.classList.add("hidden");
      if (!colId) return;
      const colIndex = parseInt(colId.replace("col_", ""), 10);
      const selectedCols = getSelectedColIndices();
      if (selectedCols.length > 1 && selectedCols.includes(colIndex)) deleteColumns(selectedCols);
      else deleteColumn(colId);
    });
    document.getElementById("col-ctx-insert-left")?.addEventListener("click", () => {
      const colId = colMenu?.dataset.colId;
      colMenu?.classList.add("hidden");
      if (!colId) return;
      const baseIndex = parseInt(colId.replace("col_", ""), 10);
      const selectedCols = getSelectedColIndices();
      const inSel = selectedCols.length > 1 && selectedCols.includes(baseIndex);
      insertColumns(inSel ? Math.min(...selectedCols) : baseIndex, "left", inSel ? selectedCols.length : 1);
    });
    document.getElementById("col-ctx-insert-right")?.addEventListener("click", () => {
      const colId = colMenu?.dataset.colId;
      colMenu?.classList.add("hidden");
      if (!colId) return;
      const baseIndex = parseInt(colId.replace("col_", ""), 10);
      const selectedCols = getSelectedColIndices();
      const inSel = selectedCols.length > 1 && selectedCols.includes(baseIndex);
      insertColumns(inSel ? Math.max(...selectedCols) : baseIndex, "right", inSel ? selectedCols.length : 1);
    });
    const container = document.getElementById("grid-container");
    if (!container) return;
    container.addEventListener("contextmenu", (e) => {
      const target = e.target;
      const cell = target.closest(".ag-cell");
      if (!cell) return;
      e.preventDefault();
      const colId = cell.getAttribute("col-id");
      const agRow = cell.closest(".ag-row");
      const isPinnedRow = !!agRow?.closest(".ag-floating-top");
      const riStr = agRow?.getAttribute("row-index");
      const rowIndex = riStr != null ? parseInt(riStr, 10) : null;
      let pinnedOrig = null;
      if (isPinnedRow && agRow && riStr != null) {
        const ft = agRow.closest(".ag-floating-top");
        const gutter = ft?.querySelector(`.ag-row[row-index="${riStr}"] [col-id="row-index"]`);
        const m = (gutter?.textContent ?? "").match(/\d+/);
        pinnedOrig = m ? parseInt(m[0], 10) : null;
      }
      showContextMenu(e.clientX, e.clientY, rowIndex, colId, isPinnedRow, pinnedOrig);
    });
  }

  // src/webview/features/pagination.ts
  function requestPage(pageNum) {
    vscodeApi.postMessage({ type: "requestPage", pageNumber: pageNum });
  }
  function handlePageData(msg) {
    state.currentPage = msg.pageNumber;
    const pi = document.getElementById("page-info");
    if (pi) pi.textContent = "Page " + (msg.pageNumber + 1) + " / " + msg.totalPages;
    const btnPrev = document.getElementById("btn-page-prev");
    const btnFirst = document.getElementById("btn-page-first");
    const btnNext = document.getElementById("btn-page-next");
    const btnLast = document.getElementById("btn-page-last");
    if (btnPrev) btnPrev.disabled = msg.pageNumber === 0;
    if (btnFirst) btnFirst.disabled = msg.pageNumber === 0;
    if (btnNext) btnNext.disabled = msg.pageNumber >= msg.totalPages - 1;
    if (btnLast) btnLast.disabled = msg.pageNumber >= msg.totalPages - 1;
    state.data = parseCsv(msg.text, state.currentDelimiter);
    buildGrid();
    hideLoader();
  }
  function setupPagination() {
    if (!IS_CHUNKED) return;
    document.getElementById("pagination-bar")?.classList.remove("hidden");
    document.getElementById("btn-page-first")?.addEventListener("click", () => requestPage(0));
    document.getElementById("btn-page-prev")?.addEventListener("click", () => {
      if (state.currentPage > 0) requestPage(state.currentPage - 1);
    });
    document.getElementById("btn-page-next")?.addEventListener("click", () => requestPage(state.currentPage + 1));
    document.getElementById("btn-page-last")?.addEventListener("click", () => requestPage(-1));
  }

  // src/webview/features/go-to-row.ts
  var flashTimer = null;
  function flashRow(displayedRowIndex) {
    let el = document.getElementById("_row-flash");
    if (!el) {
      el = document.createElement("style");
      el.id = "_row-flash";
      document.head.appendChild(el);
    }
    el.textContent = `
#grid-container .ag-row[row-index="${displayedRowIndex}"] .ag-cell {
    animation: csv-row-flash 1.4s ease-out;
}`;
    if (flashTimer !== null) clearTimeout(flashTimer);
    flashTimer = setTimeout(() => {
      if (el) el.textContent = "";
      flashTimer = null;
    }, 1500);
  }
  function getDisplayedRowCount() {
    return state.gridApi?.getDisplayedRowCount?.() ?? 0;
  }
  function showError(msg) {
    const err = document.getElementById("goto-error");
    if (err) {
      err.textContent = msg;
      err.style.display = "";
    }
  }
  function clearError() {
    const err = document.getElementById("goto-error");
    if (err) {
      err.textContent = "";
      err.style.display = "none";
    }
  }
  function jumpToRow() {
    const input = document.getElementById("goto-input");
    if (!input || !state.gridApi) return;
    const raw = input.value.trim();
    if (raw === "") {
      showError("Enter a row number");
      return;
    }
    const target = parseInt(raw, 10);
    if (!Number.isFinite(target) || target < 1) {
      showError("Row number must be 1 or greater");
      return;
    }
    const total = getDisplayedRowCount();
    if (total === 0) {
      showError("No rows to navigate");
      return;
    }
    if (target > total) {
      showError("Only " + total.toLocaleString() + " row" + (total === 1 ? "" : "s") + " available");
      return;
    }
    const displayedIndex = target - 1;
    state.gridApi.ensureIndexVisible(displayedIndex, "middle");
    requestAnimationFrame(() => {
      const cols = state.gridApi.getAllDisplayedColumns?.();
      const firstDataCol = cols?.find((c) => c.getColId?.() !== "row-index");
      const colId = firstDataCol?.getColId?.() ?? "col_0";
      try {
        state.gridApi.setFocusedCell(displayedIndex, colId);
      } catch {
      }
      flashRow(displayedIndex);
    });
    closePopover();
  }
  function openPopover() {
    const pop = document.getElementById("goto-popover");
    const btn = document.getElementById("btn-go-to-row");
    const input = document.getElementById("goto-input");
    const hint = document.getElementById("goto-hint");
    if (!pop || !btn || !input) return;
    const total = getDisplayedRowCount();
    if (hint) hint.textContent = "of " + total.toLocaleString();
    input.max = String(Math.max(1, total));
    const r = btn.getBoundingClientRect();
    pop.classList.remove("hidden");
    const pw = pop.offsetWidth || 220;
    const vw = window.innerWidth;
    pop.style.top = r.bottom + 4 + "px";
    pop.style.left = Math.max(4, Math.min(r.left, vw - pw - 4)) + "px";
    clearError();
    input.value = "";
    setTimeout(() => input.focus(), 0);
  }
  function closePopover() {
    document.getElementById("goto-popover")?.classList.add("hidden");
    clearError();
  }
  function setupGoToRow() {
    if (IS_CHUNKED) return;
    const btn = document.getElementById("btn-go-to-row");
    btn?.addEventListener("click", (e) => {
      e.stopPropagation();
      const pop = document.getElementById("goto-popover");
      const wasOpen = pop != null && !pop.classList.contains("hidden");
      closeAllPopups();
      if (!wasOpen) openPopover();
    });
    document.getElementById("goto-go")?.addEventListener("click", jumpToRow);
    document.getElementById("goto-cancel")?.addEventListener("click", closePopover);
    const input = document.getElementById("goto-input");
    input?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        jumpToRow();
      }
      if (e.key === "Escape") {
        e.preventDefault();
        closePopover();
      }
    });
    input?.addEventListener("input", clearError);
    document.addEventListener("mousedown", (evt) => {
      const pop = document.getElementById("goto-popover");
      if (!pop || pop.classList.contains("hidden")) return;
      const target = evt.target;
      if (pop.contains(target)) return;
      if (btn?.contains(target)) return;
      closePopover();
    }, true);
    document.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "g" && !state.isCellEditing) {
        e.preventDefault();
        const pop = document.getElementById("goto-popover");
        if (pop?.classList.contains("hidden")) openPopover();
        else closePopover();
      }
    });
  }

  // src/webview/features/paste.ts
  function shouldHandlePaste(target) {
    if (target instanceof HTMLElement) {
      const tag = target.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || target.isContentEditable) return false;
    }
    if (state.isCellEditing) return false;
    if (IS_PREVIEW || IS_CHUNKED) return false;
    if (state.focusedCellRowIndex == null || state.focusedCellColId == null) return false;
    return true;
  }
  function pasteHandler(e) {
    if (!shouldHandlePaste(e.target)) return;
    if (!state.gridApi) return;
    const text = e.clipboardData?.getData("text/plain");
    if (!text) return;
    const block = parseCsv(text, "	", false);
    if (block.length === 0) return;
    e.preventDefault();
    const displayedOrigRows = [];
    state.gridApi.forEachNodeAfterFilterAndSort((node) => {
      if (node.data?._origIndex != null) {
        displayedOrigRows.push(Number(node.data._origIndex));
      }
    });
    const displayedDataCols = state.gridApi.getAllDisplayedColumns().map((c) => c.getColId()).filter((id) => id.startsWith("col_")).map((id) => parseInt(id.slice(4), 10));
    if (displayedDataCols.length === 0) return;
    const startRowDisplayed = state.focusedCellRowIndex;
    const startDisplayCol = state.focusedCellColId === "row-index" ? 0 : displayedDataCols.indexOf(parseInt(state.focusedCellColId.slice(4), 10));
    if (startDisplayCol < 0) return;
    pushUndo();
    const numCols = getNumCols(state.data);
    for (let i = 0; i < block.length; i++) {
      const row = block[i];
      const targetDisplayRow = startRowDisplayed + i;
      let dataRowIndex;
      if (targetDisplayRow < displayedOrigRows.length) {
        dataRowIndex = displayedOrigRows[targetDisplayRow];
      } else {
        state.data.push(Array(numCols).fill(""));
        dataRowIndex = state.data.length - 1;
      }
      for (let j = 0; j < row.length; j++) {
        const targetDisplayCol = startDisplayCol + j;
        if (targetDisplayCol >= displayedDataCols.length) break;
        const dataCol = displayedDataCols[targetDisplayCol];
        while (state.data[dataRowIndex].length <= dataCol) {
          state.data[dataRowIndex].push("");
        }
        state.data[dataRowIndex][dataCol] = row[j];
      }
    }
    state.isAutoFitted = false;
    state.autoFitCache = null;
    refreshGrid();
    recomputeColTypes();
    notifyChange();
  }
  function setupPaste() {
    if (IS_PREVIEW || IS_CHUNKED) return;
    document.addEventListener("paste", pasteHandler);
  }

  // src/webview/features/rename-column.ts
  var pendingColIndex = null;
  function renameColumn(colIndex, newName) {
    if (isNaN(colIndex) || !state.gridApi) return;
    const header = state.data[0] ?? (state.data[0] = []);
    if ((header[colIndex] ?? "") === newName) return;
    pushUndo();
    while (header.length <= colIndex) header.push("");
    header[colIndex] = newName;
    syncColumnHeaders();
    notifyChange();
  }
  function openRenamePopover(colId, anchorEl) {
    const colIndex = parseInt(colId.replace("col_", ""), 10);
    if (isNaN(colIndex)) return;
    const pop = document.getElementById("rename-popover");
    const input = document.getElementById("rename-input");
    if (!pop || !input) return;
    pendingColIndex = colIndex;
    input.value = state.data[0]?.[colIndex] ?? "";
    closeAllPopups("rename-popover");
    pop.classList.remove("hidden");
    const pw = pop.offsetWidth || 240;
    const vw = window.innerWidth;
    const r = anchorEl?.getBoundingClientRect();
    const top = r ? r.bottom + 4 : 80;
    const left = r ? r.left : 80;
    pop.style.top = top + "px";
    pop.style.left = Math.max(4, Math.min(left, vw - pw - 4)) + "px";
    setTimeout(() => {
      input.focus();
      input.select();
    }, 0);
  }
  function closeRenamePopover() {
    document.getElementById("rename-popover")?.classList.add("hidden");
    pendingColIndex = null;
  }
  function commitRename() {
    const input = document.getElementById("rename-input");
    if (input && pendingColIndex != null) renameColumn(pendingColIndex, input.value);
    closeRenamePopover();
  }
  function setupRenameColumn() {
    if (IS_PREVIEW) return;
    const colMenu = document.getElementById("col-context-menu");
    document.getElementById("col-ctx-rename")?.addEventListener("click", () => {
      const colId = colMenu?.dataset.colId;
      colMenu?.classList.add("hidden");
      if (colId && colId !== "row-index") {
        const headerCell = document.querySelector(`.ag-header-cell[col-id="${colId}"]`);
        openRenamePopover(colId, headerCell);
      }
    });
    document.getElementById("rename-ok")?.addEventListener("click", commitRename);
    document.getElementById("rename-cancel")?.addEventListener("click", closeRenamePopover);
    const input = document.getElementById("rename-input");
    input?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        commitRename();
      }
      if (e.key === "Escape") {
        e.preventDefault();
        closeRenamePopover();
      }
    });
    document.addEventListener("mousedown", (evt) => {
      const pop = document.getElementById("rename-popover");
      if (!pop || pop.classList.contains("hidden")) return;
      if (pop.contains(evt.target)) return;
      closeRenamePopover();
    }, true);
  }

  // src/webview/features/column-chooser.ts
  var searchQuery = "";
  function setColHidden(colIndex, hidden) {
    if (hidden) state.hiddenCols.add(colIndex);
    else state.hiddenCols.delete(colIndex);
    state.gridApi?.setColumnsVisible(["col_" + colIndex], !hidden);
    updateButton2();
    syncMaster();
  }
  function colLabel(header, c) {
    const name = header[c] ?? "";
    return name !== "" ? name : "(column " + (c + 1) + ")";
  }
  function visibleColIndices() {
    const header = state.data[0] ?? [];
    const q = searchQuery.trim().toLowerCase();
    const out = [];
    for (let c = 0; c < header.length; c++) {
      if (q && !colLabel(header, c).toLowerCase().includes(q)) continue;
      out.push(c);
    }
    return out;
  }
  function setVisibleColsHidden(hidden) {
    const cols = visibleColIndices();
    if (cols.length === 0) return;
    if (!hidden && searchQuery.trim() === "") {
      state.hiddenCols.clear();
      state.gridApi?.setColumnsVisible(allColIds(), true);
    } else {
      for (const c of cols) {
        if (hidden) state.hiddenCols.add(c);
        else state.hiddenCols.delete(c);
      }
      state.gridApi?.setColumnsVisible(cols.map((c) => "col_" + c), !hidden);
    }
    buildList();
    updateButton2();
  }
  function allColIds() {
    const n = (state.data[0] ?? []).length;
    const ids = [];
    for (let c = 0; c < n; c++) ids.push("col_" + c);
    return ids;
  }
  function syncMaster() {
    const cb = document.getElementById("col-chooser-master-cb");
    const count = document.getElementById("col-chooser-master-count");
    const label = document.getElementById("col-chooser-master-label");
    if (!cb) return;
    const cols = visibleColIndices();
    const visible = cols.reduce((n, c) => n + (state.hiddenCols.has(c) ? 0 : 1), 0);
    const total = cols.length;
    cb.checked = total > 0 && visible === total;
    cb.indeterminate = visible > 0 && visible < total;
    cb.disabled = total === 0;
    if (count) count.textContent = total > 0 ? `${visible} / ${total}` : "";
    if (label) label.textContent = searchQuery.trim() ? "Select all matches" : "Select all";
  }
  function buildList() {
    const list = document.getElementById("col-chooser-list");
    if (!list) return;
    list.innerHTML = "";
    const header = state.data[0] ?? [];
    const cols = visibleColIndices();
    for (const c of cols) {
      const row = document.createElement("label");
      row.className = "col-chooser-item";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = !state.hiddenCols.has(c);
      const idx = c;
      cb.addEventListener("change", () => setColHidden(idx, !cb.checked));
      const span = document.createElement("span");
      span.className = "col-chooser-label";
      span.textContent = colLabel(header, c);
      row.appendChild(cb);
      row.appendChild(span);
      list.appendChild(row);
    }
    if (cols.length === 0) {
      const empty = document.createElement("div");
      empty.className = "csv-filter-empty";
      empty.textContent = "No matching columns";
      list.appendChild(empty);
    }
    syncMaster();
  }
  function updateButton2() {
    document.getElementById("btn-columns")?.classList.toggle("btn-active", state.hiddenCols.size > 0);
  }
  function openChooser() {
    const pop = document.getElementById("col-chooser-popover");
    const btn = document.getElementById("btn-columns");
    if (!pop || !btn) return;
    searchQuery = "";
    const search = document.getElementById("col-chooser-search");
    if (search) search.value = "";
    buildList();
    pop.classList.remove("hidden");
    const r = btn.getBoundingClientRect();
    const pw = pop.offsetWidth || 220;
    const vw = window.innerWidth;
    pop.style.top = r.bottom + 4 + "px";
    pop.style.left = Math.max(4, Math.min(r.left, vw - pw - 4)) + "px";
    search?.focus();
  }
  function closeChooser() {
    document.getElementById("col-chooser-popover")?.classList.add("hidden");
  }
  function setupColumnChooser() {
    const btn = document.getElementById("btn-columns");
    btn?.addEventListener("click", (e) => {
      e.stopPropagation();
      const pop = document.getElementById("col-chooser-popover");
      const wasOpen = pop != null && !pop.classList.contains("hidden");
      closeAllPopups();
      if (!wasOpen) openChooser();
    });
    const master = document.getElementById("col-chooser-master-cb");
    master?.addEventListener("change", () => setVisibleColsHidden(!master.checked));
    const search = document.getElementById("col-chooser-search");
    search?.addEventListener("input", () => {
      searchQuery = search.value;
      buildList();
    });
    document.addEventListener("mousedown", (evt) => {
      const pop = document.getElementById("col-chooser-popover");
      if (!pop || pop.classList.contains("hidden")) return;
      const t = evt.target;
      if (pop.contains(t)) return;
      if (btn?.contains(t)) return;
      closeChooser();
    }, true);
  }

  // src/webview/keyboard.ts
  function writeToClipboard(text) {
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text);
    } else {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.cssText = "position:fixed;left:-9999px;top:-9999px;opacity:0;";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
  }
  function setupKeyboard() {
    document.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "c" && !state.isCellEditing) {
        if (state.gridApi && state.focusedCellColId !== null && state.focusedCellColId !== "row-index" && state.focusedCellRowIndex !== null) {
          const rowNode = state.gridApi.getDisplayedRowAtIndex(state.focusedCellRowIndex);
          if (rowNode?.data) {
            const val = rowNode.data[state.focusedCellColId];
            writeToClipboard(val != null ? String(val) : "");
            e.preventDefault();
          }
        }
      }
      if ((e.ctrlKey || e.metaKey) && e.key === "z" && !e.shiftKey) {
        undo();
        e.preventDefault();
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === "y" || e.key === "z" && e.shiftKey)) {
        redo();
        e.preventDefault();
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === "+" || e.key === "=")) {
        zoomIn();
        e.preventDefault();
      }
      if ((e.ctrlKey || e.metaKey) && e.key === "-") {
        zoomOut();
        e.preventDefault();
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === "f" || e.key === "h") && !state.isCellEditing) {
        e.preventDefault();
        openFindBar();
      }
    });
  }

  // src/webview/messaging.ts
  function initWithData(text, delimiter) {
    state.rawCsvText = text;
    state.currentDelimiter = delimiter;
    state.data = parseCsv(text, delimiter);
    state.isAutoFitted = false;
    state.autoFitCache = null;
    state.autoFitCacheZoom = -1;
    state.zoomIndex = Math.max(0, Math.min(INITIAL_ZOOM_INDEX, state.ZOOM_STEPS.length - 1));
    updateDelimiterBadge(delimiter);
    if (IS_PREVIEW) {
      const previewEl = document.getElementById("preview-text");
      if (previewEl) {
        const shownRows = state.data.length - 1;
        const totalRows = TOTAL_LINE_COUNT - 1;
        if (PREVIEW_MODE === "head") {
          previewEl.textContent = `Showing first ${shownRows.toLocaleString()} of ${totalRows.toLocaleString()} rows (read-only preview)`;
        } else if (PREVIEW_MODE === "tail") {
          previewEl.textContent = `Showing last ${shownRows.toLocaleString()} of ${totalRows.toLocaleString()} rows (read-only preview)`;
        }
      }
    }
    setTimeout(() => {
      applyZoom();
      buildGrid();
      hideLoader();
    }, 0);
  }
  function setupMessaging() {
    window.addEventListener("message", (event) => {
      const msg = event.data;
      if (msg.type === "init") {
        initWithData(msg.text, msg.delimiter);
      } else if (msg.type === "update") {
        const frozen = frozenRowPositions();
        state.data = parseCsv(msg.text, msg.delimiter);
        reanchorFrozenRows(frozen);
        resetDuplicatesState();
        refreshGrid();
      } else if (msg.type === "pageData") {
        handlePageData(msg);
      }
    });
  }

  // src/webview/index.ts
  setupTheme();
  setupUndoRedo();
  setupZoom();
  setupAutoFit();
  setupProfile();
  setupDelimiterBadge();
  setupExport();
  setupFreezeColumns();
  setupDeleteRowCol();
  setupFindReplace();
  setupPagination();
  setupGoToRow();
  setupDuplicates();
  setupPaste();
  setupRangeSelect();
  setupRenameColumn();
  setupColumnChooser();
  setupColorMode();
  setupKeyboard();
  setupMessaging();
  setupPopups();
  vscodeApi.postMessage({ type: "ready" });
})();
