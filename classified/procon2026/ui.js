'use strict';
// ================================================================
// ui.js — 画面遷移・入力・再生制御
// sim.js(ロジック) / render.js(描画) に依存する。
//
// 画面フロー:
//   start → mode → (place) → type → [plan → play]×日数 → result
// ================================================================

const SAMPLE_MAP = {"startsAt":1778227200,"daySeconds":[60,60,60,60],"daySteps":[16,16,16,16],"map":{"height":8,"width":8,"cells":[[0,1,0,0,0,2,0,0],[0,0,0,1,0,0,0,2],[3,0,1,0,0,0,0,0],[0,0,0,0,1,0,2,0],[0,2,0,1,0,0,0,0],[0,0,0,0,0,1,0,2],[0,1,0,0,2,0,0,0],[0,0,0,1,0,0,0,0]]},"spots":[{"brand":0,"pos":10,"stocks":3},{"brand":1,"pos":20,"stocks":3},{"brand":0,"pos":36,"stocks":3},{"brand":1,"pos":50,"stocks":3}],"agents":[0,4,56,62],"fuelLimits":20,"players":1,"busyThreshold":3,"jammedThreshold":6};

// ---------------- アプリ状態 ----------------
// resetAll() で必ず初期値に戻すこと(前回セッション残留バグ対策 / 仕様G29)
const app = {
  screen: 'start',
  mapData: null,        // 検証済みマップ構成JSON
  inputMode: null,      // 'json' | 'gui'
  customPlace: false,
  placements: [],       // カスタム配置の初期位置(未使用時は mapData.agents)
  typeSel: [],          // タイプ選択画面の選択状態 (null|0|1)
  game: null,           // 進行中のゲーム状態(sim.js)
  timeline: [],         // 当日のフェーズタイムライン
  phaseIdx: -1,         // -1 = 日開始状態(フェーズ未実行)
  dayStartView: null,   // 日開始時点の表示用ビュー
  guiDraft: null,       // GUIモードの計画ドラフト
  guiSel: 0,            // GUIモードで選択中のエージェント
  selectedCell: null,   // セル詳細の選択セル
};

// ---------------- DOMユーティリティ ----------------
const $ = id => document.getElementById(id);
function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// ---------------- 描画器 ----------------
const renderers = {
  place: makeRenderer($('place-canvas')),
  type:  makeRenderer($('type-canvas')),
  plan:  makeRenderer($('plan-canvas')),
  play:  makeRenderer($('play-canvas')),
};

// ---------------- 画面遷移 ----------------
function showScreen(name) {
  app.screen = name;
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  $('screen-' + name).classList.add('active');
  requestAnimationFrame(renderCurrent);
}

function renderCurrent() {
  if (app.screen === 'place') renderPlaceScreen();
  else if (app.screen === 'type') renderTypeScreen();
  else if (app.screen === 'plan') renderPlanScreen();
  else if (app.screen === 'play') renderPlayScreen();
}
window.addEventListener('resize', renderCurrent);

// ================================================================
// 1. 起動画面
// ================================================================
function loadMap(json) {
  $('start-error').textContent = '';
  let data;
  try {
    data = (typeof json === 'string') ? JSON.parse(json) : json;
  } catch (err) {
    $('start-error').textContent = 'JSONの解析に失敗しました: ' + err.message;
    return;
  }
  const errs = validateMapData(data);
  if (errs.length) {
    $('start-error').textContent = 'マップ検証エラー:\n' + errs.map(e => '・' + e).join('\n');
    return;
  }
  app.mapData = data;
  showScreen('mode');
}

$('btn-sample').addEventListener('click', () => loadMap(structuredClone(SAMPLE_MAP)));

$('map-file-input').addEventListener('change', e => {
  const file = e.target.files[0];
  e.target.value = ''; // 同一ファイル再選択でもchangeを発火させる
  if (!file) return;
  const reader = new FileReader();
  reader.onload = ev => loadMap(ev.target.result);
  reader.onerror = () => { $('start-error').textContent = 'ファイルの読み込みに失敗しました。'; };
  reader.readAsText(file);
});

// ================================================================
// 2. モード選択画面
// ================================================================
function chooseMode(mode) {
  app.inputMode = mode;
  app.customPlace = $('chk-custom-place').checked;
  if (app.customPlace) {
    app.placements = [];
    showScreen('place');
  } else {
    app.placements = app.mapData.agents.slice();
    gotoTypeScreen();
  }
}
$('btn-mode-json').addEventListener('click', () => chooseMode('json'));
$('btn-mode-gui').addEventListener('click', () => chooseMode('gui'));

// ================================================================
// 3a. カスタム配置画面
// ================================================================
function placeableCell(pos) {
  if (terrainAt(app.mapData, pos) !== TERRAIN.PLAIN) return 'スポットのない平地のみ配置できます(地形: ' + TERRAIN_NAME[terrainAt(app.mapData, pos)] + ')。';
  if (app.mapData.spots.some(s => s.pos === pos)) return 'スポットのあるセルには配置できません。';
  if (app.placements.includes(pos)) return 'そのセルには既に配置済みです(重複不可 / 公式Q37)。';
  return null;
}

function renderPlaceScreen() {
  const n = app.mapData.agents.length;
  renderers.place.render({
    mapData: app.mapData,
    roadStatus: {},
    stocks: null,
    agents: app.placements.map((p, i) => ({ id: i, kind: KIND_PATROL, pos: p })),
    selectedCell: app.selectedCell,
  });
  const rows = [];
  for (let i = 0; i < n; i++) {
    const placed = i < app.placements.length;
    rows.push(
      `<div class="agent-row"><span class="agent-icon ${placed ? 'patrol' : 'none'}">${i}</span>` +
      `${placed ? 'セル' + app.placements[i] : '未配置(クリックで配置)'}</div>`);
  }
  $('place-list').innerHTML = rows.join('');
  $('btn-place-confirm').disabled = (app.placements.length !== n);
}

$('place-canvas').addEventListener('click', e => {
  const pos = renderers.place.hitTest(e.clientX, e.clientY);
  if (pos === null) return;
  $('place-error').textContent = '';
  if (app.placements.length >= app.mapData.agents.length) return;
  const err = placeableCell(pos);
  if (err) { $('place-error').textContent = 'セル' + pos + ': ' + err; return; }
  app.placements.push(pos);
  renderPlaceScreen();
});

$('btn-place-reset').addEventListener('click', () => {
  app.placements = [];
  $('place-error').textContent = '';
  renderPlaceScreen();
});

$('btn-place-confirm').addEventListener('click', () => {
  if (app.placements.length !== app.mapData.agents.length) return;
  gotoTypeScreen();
});

// ================================================================
// 3b. タイプ選択画面
// ================================================================
function gotoTypeScreen() {
  app.typeSel = app.placements.map(() => null);
  showScreen('type');
}

function renderTypeScreen() {
  const info = renderers.type.render({
    mapData: app.mapData,
    roadStatus: {},
    stocks: null,
    agents: app.placements.map((p, i) => ({
      id: i,
      kind: app.typeSel[i] === KIND_SUPPLY ? KIND_SUPPLY : KIND_PATROL,
      pos: p,
    })),
  });
  // セル内オーバーレイの「巡回」「補給」ボタン(仕様B5)
  const overlay = $('type-overlay');
  overlay.innerHTML = '';
  if (!info) return;
  app.placements.forEach((pos, i) => {
    const c = info.centers[pos];
    const div = document.createElement('div');
    div.className = 'type-btns';
    div.style.left = (info.ox + c.x) + 'px';
    div.style.top = (info.oy + c.y + info.hex * 0.55) + 'px';
    const bp = document.createElement('button');
    bp.textContent = '巡回';
    if (app.typeSel[i] === KIND_PATROL) bp.classList.add('sel-patrol');
    bp.addEventListener('click', () => { app.typeSel[i] = KIND_PATROL; renderTypeScreen(); });
    const bs = document.createElement('button');
    bs.textContent = '補給';
    if (app.typeSel[i] === KIND_SUPPLY) bs.classList.add('sel-supply');
    bs.addEventListener('click', () => { app.typeSel[i] = KIND_SUPPLY; renderTypeScreen(); });
    div.appendChild(bp);
    div.appendChild(bs);
    overlay.appendChild(div);
  });
  // 選択状況リスト
  $('type-list').innerHTML = app.placements.map((pos, i) => {
    const t = app.typeSel[i];
    const cls = t === KIND_SUPPLY ? 'supply' : t === KIND_PATROL ? 'patrol' : 'none';
    const label = t === KIND_SUPPLY ? '補給車' : t === KIND_PATROL ? '巡回車' : '未選択(→巡回車)';
    return `<div class="agent-row"><span class="agent-icon ${cls}">${i}</span> セル${pos} : ${label}</div>`;
  }).join('');
}

$('btn-type-confirm').addEventListener('click', () => {
  // 未選択は巡回車(公式Q53準拠)
  const types = app.typeSel.map(t => t === KIND_SUPPLY ? KIND_SUPPLY : KIND_PATROL);
  app.game = createGame(app.mapData, types, app.placements.slice());
  app.game.day = 1;
  beginDay();
});

// ================================================================
// 日の開始 → 行動計画入力画面
// ================================================================
function beginDay() {
  startDay(app.game); // 在庫補充 + 道路状態決定
  app.timeline = [];
  app.phaseIdx = -1;
  app.selectedCell = null;
  app.dayStartView = buildDayStartView();
  if (app.inputMode === 'gui') initGuiDraft();
  $('plan-textarea').value = '';
  $('plan-error').textContent = '';
  $('plan-cell-detail').textContent = 'セルをクリックすると詳細を表示します。';
  showScreen('plan');
}

function buildDayStartView() {
  const g = app.game;
  return {
    mapData: g.mapData,
    roadStatus: g.roadStatus,
    stocks: { ...g.stocks },
    agents: g.agents.map(a => ({
      id: a.id, kind: a.kind, pos: a.pos, fuel: a.fuel, action: null,
      totalUdon: a.totalUdon, brandCount: { ...a.brandCount }, refuelGiven: a.refuelGiven,
    })),
  };
}

// ================================================================
// 4. 行動計画入力画面
// ================================================================
function renderPlanScreen() {
  const g = app.game;
  const N = g.daySteps[g.day - 1];

  // モードでパネルを切替
  $('plan-json-panel').style.display = (app.inputMode === 'json') ? '' : 'none';
  $('plan-gui-panel').style.display = (app.inputMode === 'gui') ? '' : 'none';

  $('plan-day-title').textContent = `Day ${g.day} / ${g.days} 開始`;
  const rs = Object.values(g.roadStatus);
  const stCnt = [0, 1, 2].map(s => rs.filter(v => v === s).length);
  $('plan-day-info').innerHTML =
    `総ステップ数: ${N}<br>` +
    `道路: 順調${stCnt[0]} / 混雑${stCnt[1]} / 渋滞${stCnt[2]}<br>` +
    `在庫: 全スポット最大まで補充済み<br>` +
    `燃料上限: ${g.fuelLimits}`;

  // マップ(GUIモードはドラフトの仮想位置と移動可能セルを重ねる)
  const view = { ...app.dayStartView, selectedCell: app.selectedCell };
  if (app.inputMode === 'gui' && app.guiDraft) {
    view.ghosts = app.guiDraft
      .map((d, i) => ({ id: i, pos: d.pos }))
      .filter((gh, i) => gh.pos !== app.dayStartView.agents[i].pos || app.guiDraft[i].actions.length > 0);
    const d = app.guiDraft[app.guiSel];
    if (d && d.sum < N) {
      view.highlights = [];
      for (let dir = 0; dir < 6; dir++) {
        const nb = neighborPos(g.W, g.H, d.pos, dir);
        if (nb !== null && terrainAt(g.mapData, nb) !== TERRAIN.POND
            && d.sum + stepCostAt(g, d.pos) <= N) view.highlights.push(nb);
      }
    }
  }
  renderers.plan.render(view);
  if (app.inputMode === 'gui') renderGuiPanel();
  renderCellDetail('plan-cell-detail', app.dayStartView);
}

// ---- JSONアップロードモード ----
$('plan-file-input').addEventListener('change', e => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  const reader = new FileReader();
  reader.onload = ev => { $('plan-textarea').value = ev.target.result; };
  reader.onerror = () => { $('plan-error').textContent = 'ファイルの読み込みに失敗しました。'; };
  reader.readAsText(file);
});

// ---- GUIモード ----
function initGuiDraft() {
  app.guiDraft = app.game.agents.map(a => ({ actions: [], pos: a.pos, sum: 0 }));
  app.guiSel = 0;
}

function guiPlans() {
  return app.guiDraft.map(d => d.actions.map(a => a.v));
}

function renderGuiPanel() {
  const g = app.game;
  const N = g.daySteps[g.day - 1];
  $('gui-agent-list').innerHTML = app.guiDraft.map((d, i) => {
    const ag = g.agents[i];
    const pct = Math.min(100, Math.round(d.sum / N * 100));
    return `<div class="gui-agent-row ${i === app.guiSel ? 'sel' : ''}" data-idx="${i}">` +
      `<span class="agent-icon ${ag.kind === KIND_SUPPLY ? 'supply' : 'patrol'}">${i}</span>` +
      `<span class="a-pos">仮想位置 セル${d.pos}</span>` +
      `<div class="bar sum-bar"><div class="bar-fill" style="width:${pct}%"></div></div>` +
      `<span class="gui-sum">${d.sum}/${N}</span></div>`;
  }).join('');
  document.querySelectorAll('.gui-agent-row').forEach(row => {
    row.addEventListener('click', () => {
      app.guiSel = Number(row.dataset.idx);
      renderPlanScreen();
    });
  });
  $('gui-json-view').value = JSON.stringify(guiPlans());
}

function guiError(msg) { $('plan-error').textContent = msg; }

function guiAppendMove(dir) {
  const g = app.game;
  const N = g.daySteps[g.day - 1];
  const d = app.guiDraft[app.guiSel];
  const nb = neighborPos(g.W, g.H, d.pos, dir);
  const cost = stepCostAt(g, d.pos);
  if (nb === null) {
    guiError(`A${app.guiSel}: セル${d.pos}から${DIR_NAME[dir]}はマップ外です。`);
  } else if (terrainAt(g.mapData, nb) === TERRAIN.POND) {
    guiError(`A${app.guiSel}: セル${nb}は池のため進入できません。`);
  } else if (d.sum + cost > N) {
    guiError(`A${app.guiSel}: この移動(${cost}step)を追加すると規定ステップ数${N}を超過します(現在${d.sum})。`);
  } else {
    d.actions.push({ v: dir, cost, from: d.pos });
    d.pos = nb;
    d.sum += cost;
    guiError('');
  }
  renderPlanScreen(); // エラー時もセル詳細等を最新化
}

$('btn-gui-wait').addEventListener('click', () => {
  const g = app.game;
  const N = g.daySteps[g.day - 1];
  const d = app.guiDraft[app.guiSel];
  const k = Math.floor(Number($('gui-wait-num').value));
  if (!Number.isInteger(k) || k < 1) { guiError('待機ステップ数は1以上の整数を指定してください。'); return; }
  if (d.sum + k > N) { guiError(`A${app.guiSel}: 待機${k}stepを追加すると規定ステップ数${N}を超過します(現在${d.sum})。`); return; }
  d.actions.push({ v: -k, cost: k, from: d.pos });
  d.sum += k;
  guiError('');
  renderPlanScreen();
});

$('btn-gui-fill').addEventListener('click', () => {
  const g = app.game;
  const N = g.daySteps[g.day - 1];
  const d = app.guiDraft[app.guiSel];
  const k = N - d.sum;
  if (k <= 0) { guiError(`A${app.guiSel}: 既に規定ステップ数に達しています。`); return; }
  d.actions.push({ v: -k, cost: k, from: d.pos });
  d.sum += k;
  guiError('');
  renderPlanScreen();
});

$('btn-gui-undo').addEventListener('click', () => {
  const d = app.guiDraft[app.guiSel];
  const last = d.actions.pop();
  if (!last) { guiError(`A${app.guiSel}: 取り消す行動がありません。`); return; }
  d.pos = last.from;
  d.sum -= last.cost;
  guiError('');
  renderPlanScreen();
});

$('btn-gui-download').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(guiPlans())], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `plan_day${app.game.day}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
});

// マップクリック(plan画面): GUIモードは移動追加、共通でセル詳細更新
$('plan-canvas').addEventListener('click', e => {
  const pos = renderers.plan.hitTest(e.clientX, e.clientY);
  if (pos === null) return;
  app.selectedCell = pos;
  if (app.inputMode === 'gui' && app.guiDraft) {
    const d = app.guiDraft[app.guiSel];
    for (let dir = 0; dir < 6; dir++) {
      if (neighborPos(app.game.W, app.game.H, d.pos, dir) === pos) { guiAppendMove(dir); return; }
    }
  }
  renderPlanScreen();
});

// ---- 計画提出(両モード共通) ----
$('btn-plan-submit').addEventListener('click', () => {
  const g = app.game;
  let plans;
  if (app.inputMode === 'gui') {
    plans = guiPlans();
  } else {
    try {
      plans = JSON.parse($('plan-textarea').value);
    } catch (err) {
      $('plan-error').textContent = 'JSONの解析に失敗しました: ' + err.message;
      return;
    }
  }
  const result = submitDayPlans(g, plans);
  if (!result.valid) {
    $('plan-error').textContent = '回答をリジェクトしました:\n' + result.errors.map(e => '・' + e).join('\n');
    return;
  }
  // 有効: 確定してタイムライン再生へ(ログは試合を通して保持・上限で自動間引き)
  app.game = result.game;
  app.timeline = result.timeline;
  app.phaseIdx = -1;
  addLogHead(`===== Day ${g.day} 開始 (${g.daySteps[g.day - 1]}ステップ) =====`);
  showScreen('play');
});

// ================================================================
// 5. 再生画面
// ================================================================
function currentSnapshot() {
  if (app.phaseIdx >= 0) return app.timeline[app.phaseIdx].snapshot;
  return null; // 日開始状態
}

function renderPlayScreen() {
  const g = app.game;
  const snap = currentSnapshot();
  const day = snap ? snap.day : g.day; // g.dayは提出時点の日(runDay後もday値は同じ)
  const N = g.daySteps[day - 1];
  const step = snap ? snap.step : 0;

  // --- ステータスバー ---
  $('st-day').textContent = `Day ${day} / ${g.days}`;
  $('st-step').textContent = `Step ${step} / ${N}`;
  const next = app.timeline[app.phaseIdx + 1];
  $('st-next').textContent = '次: ' + (next ? `${next.kind === 'REF' ? '反映' : 'アクション'} (S${next.step})` : '日終了');
  $('st-day-fill').style.width = Math.round(step / N * 100) + '%';

  // --- コントロール ---
  if (next) {
    $('btn-next-phase').style.display = '';
    $('btn-skip-day').style.display = '';
    $('btn-day-end').style.display = 'none';
    $('btn-next-phase').textContent =
      `${next.kind === 'REF' ? '反映' : 'アクション'}フェーズを実行 ▶ (Day ${day} : Step ${next.step})`;
  } else {
    $('btn-next-phase').style.display = 'none';
    $('btn-skip-day').style.display = 'none';
    $('btn-day-end').style.display = '';
    $('btn-day-end').textContent = (day < g.days)
      ? `Day ${day} 終了 — 次の日の計画入力へ ▶`
      : '試合終了 — 結果を表示 ▶';
  }

  // --- マップ ---
  const agents = snap ? snap.agents : app.dayStartView.agents;
  const arrows = [];
  agents.forEach(a => {
    if (a.action && a.action.type === 'move' && a.action.remain > 0) {
      arrows.push({ from: a.pos, to: a.action.to, remain: a.action.remain });
    }
  });
  renderers.play.render({
    mapData: g.mapData,
    roadStatus: g.roadStatus,
    stocks: snap ? snap.stocks : app.dayStartView.stocks,
    agents,
    arrows,
    selectedCell: app.selectedCell,
  });

  // --- 系列バッジ ---
  const totalByBrand = snap ? snap.totalByBrand : dayStartTotalByBrand();
  const dayBrands = snap ? snap.dayBrands : [];
  const cumTypes = snap ? snap.cumTypes : app.game.dayHistory.slice(0, day - 1).reduce((a, h) => a + h.brands.length, 0);
  const totalBalls = snap ? snap.totalBalls : agents.reduce((a, x) => a + (x.totalUdon || 0), 0);
  const brandKeys = Object.keys(totalByBrand).sort((a, b) => a - b);
  const totalBrandsInMap = new Set(g.mapData.spots.map(s => s.brand)).size;
  $('brand-title').textContent = `獲得済み系列 (${brandKeys.length} / ${totalBrandsInMap}種)`;
  $('brand-badges').innerHTML =
    brandKeys.map(b =>
      `<span class="brand-badge" style="background:${brandColor(Number(b))}">系列${b} ×${totalByBrand[b]}</span>`).join('') +
    `<span class="sum-text">本日の種類: ${dayBrands.length} / 累積種類数: ${cumTypes} / 総玉数: ${totalBalls}</span>`;

  // --- エージェントパネル ---
  $('agent-panel').innerHTML = agents.map(a => {
    let posText = `セル${a.pos}`;
    if (a.action) {
      posText += a.action.type === 'move'
        ? ` → ${a.action.to} (残${a.action.remain})`
        : ` 待機(残${a.action.remain})`;
    }
    const fuelHtml = (a.kind === KIND_SUPPLY)
      ? `<div class="bar fuel-bar"><div class="bar-fill" style="width:100%;background:#ffa726"></div></div><span class="a-fuel">∞</span>`
      : `<div class="bar fuel-bar"><div class="bar-fill" style="width:${Math.round(a.fuel / g.fuelLimits * 100)}%"></div></div><span class="a-fuel">${a.fuel}/${g.fuelLimits}</span>`;
    const udon = (a.kind === KIND_SUPPLY)
      ? `補給${a.refuelGiven || 0}回`
      : Object.keys(a.brandCount || {}).sort((x, y) => x - y)
          .map(b => `<span style="color:${brandColor(Number(b))}">b${b}×${a.brandCount[b]}</span>`).join(' ') || '-';
    return `<div class="agent-row">` +
      `<span class="agent-icon ${a.kind === KIND_SUPPLY ? 'supply' : 'patrol'}">${a.id}</span>` +
      `<span class="a-pos">${esc(posText)}</span>${fuelHtml}` +
      `<span class="a-udon">${udon}</span></div>`;
  }).join('');

  // --- スポットパネル ---
  const stocks = snap ? snap.stocks : app.dayStartView.stocks;
  $('spot-panel').innerHTML = g.mapData.spots.map(s => {
    const cur = stocks[s.pos] ?? s.stocks;
    return `<div class="spot-row">` +
      `<span class="spot-dot" style="background:${brandColor(s.brand)}"></span>セル${s.pos} (系列${s.brand})` +
      `<div class="bar stock-bar"><div class="bar-fill" style="width:${Math.round(cur / s.stocks * 100)}%"></div></div>` +
      `<span>${cur}/${s.stocks}</span></div>`;
  }).join('');

  // --- セル詳細 ---
  renderCellDetail('play-cell-detail', { stocks, agents, trafficToday: snap ? snap.trafficToday : {} });
}

// phaseIdx=-1(提出直後・日開始状態)の系列合計。
// S0スナップショットの合計 = 前日までの累計(0ステップ目では獲得が発生しないため)。
function dayStartTotalByBrand() {
  return app.timeline.length ? app.timeline[0].snapshot.totalByBrand : {};
}

$('btn-next-phase').addEventListener('click', () => {
  if (app.phaseIdx + 1 >= app.timeline.length) return;
  app.phaseIdx++;
  appendPhaseLog(app.timeline[app.phaseIdx]);
  renderPlayScreen();
});

$('btn-skip-day').addEventListener('click', () => {
  while (app.phaseIdx + 1 < app.timeline.length) {
    app.phaseIdx++;
    appendPhaseLog(app.timeline[app.phaseIdx]);
  }
  renderPlayScreen();
});

$('btn-day-end').addEventListener('click', () => {
  const g = app.game;
  if (g.day < g.days) {
    g.day++;
    beginDay();
  } else {
    showResult();
  }
});

// マップクリック(play画面): セル詳細
$('play-canvas').addEventListener('click', e => {
  const pos = renderers.play.hitTest(e.clientX, e.clientY);
  if (pos === null) return;
  app.selectedCell = pos;
  renderPlayScreen();
});

// ---- セル詳細(plan/play共通) ----
function renderCellDetail(elId, view) {
  const el = $(elId);
  const pos = app.selectedCell;
  if (pos === null || pos === undefined) { el.textContent = 'セルをクリックすると詳細を表示します。'; return; }
  const g = app.game || { mapData: app.mapData };
  const t = terrainAt(g.mapData, pos);
  const lines = [`セル: ${pos} / 地形: ${TERRAIN_NAME[t]}`];
  if (t === TERRAIN.ROAD && app.game) {
    const st = app.game.roadStatus[pos] ?? 0;
    lines.push(`状態: ${ROAD_STATUS_NAME[st]} (${ROAD_STEPS[st]}step / 燃料${TERRAIN_FUEL[1]})`);
    const td = trafficDetail(app.game, pos);
    lines.push(`状態決定交通量: 前日${td.prev} + 前々日${td.prev2} = ${td.value} (÷${app.game.playersDivisor})`);
    lines.push(`基準値: 混雑${app.game.busy} / 渋滞${app.game.jammed}`);
    const today = (view.trafficToday && view.trafficToday[pos]) || 0;
    lines.push(`本日の滞在累計: ${today} (翌日以降に影響)`);
  } else if (t === TERRAIN.PLAIN) {
    lines.push(`移動: ${TERRAIN_STEPS[0]}step / 燃料${TERRAIN_FUEL[0]}`);
  } else if (t === TERRAIN.MOUNTAIN) {
    lines.push(`移動: ${TERRAIN_STEPS[2]}step / 燃料${TERRAIN_FUEL[2]}`);
  } else {
    lines.push('進入不可');
  }
  const spot = g.mapData.spots.find(s => s.pos === pos);
  if (spot) {
    const cur = (view.stocks && view.stocks[pos] != null) ? view.stocks[pos] : spot.stocks;
    lines.push(`スポット: 系列${spot.brand} / 在庫 ${cur}/${spot.stocks}`);
  }
  const here = (view.agents || []).filter(a => a.pos === pos);
  if (here.length) lines.push('滞在: ' + here.map(a => `A${a.id}(${a.kind === KIND_SUPPLY ? '補給' : '巡回'})`).join(', '));
  el.innerHTML = lines.map(esc).join('<br>');
}

// ---- イベントログ ----
const LOG_MAX_LINES = 300;
function clearLog() { $('log-body').innerHTML = ''; }
function addLogHead(text) {
  const div = document.createElement('div');
  div.className = 'log-head';
  div.textContent = text;
  $('log-body').prepend(div);
  trimLog();
}
function appendPhaseLog(phase) {
  const body = $('log-body');
  const frag = document.createDocumentFragment();
  const head = document.createElement('div');
  head.className = 'log-head';
  head.textContent = `--- Day ${phase.snapshot.day} Step ${phase.step} [${phase.kind === 'REF' ? '反映' : 'AC'}] ---`;
  frag.appendChild(head);
  (phase.logs.length ? phase.logs : ['(処理対象なし)']).forEach(l => {
    const div = document.createElement('div');
    div.textContent = l;
    frag.appendChild(div);
  });
  body.prepend(frag); // 新しい順
  trimLog();
}
function trimLog() {
  const body = $('log-body');
  while (body.childNodes.length > LOG_MAX_LINES) body.removeChild(body.lastChild);
}

// ================================================================
// 6. 終了サマリ画面
// ================================================================
function showResult() {
  const g = app.game;
  const brandKeys = Object.keys(g.totalByBrand).sort((a, b) => a - b);
  const cumTypes = g.dayHistory.reduce((a, h) => a + h.brands.length, 0);
  const totalBalls = g.agents.reduce((a, ag) => a + ag.totalUdon, 0);
  const totalBrandsInMap = new Set(g.mapData.spots.map(s => s.brand)).size;

  $('result-summary').innerHTML = [
    `獲得うどん種類数: ${brandKeys.length}種 / マップ内${totalBrandsInMap}種`,
    `日毎種類数の累積: ${cumTypes} (${g.dayHistory.map(h => `D${h.day}:${h.brands.length}`).join(' / ')})`,
    `総玉数: ${totalBalls}玉`,
    `内訳: ` + (brandKeys.map(b =>
      `<span class="brand-badge" style="background:${brandColor(Number(b))}">系列${b} ×${g.totalByBrand[b]}</span>`).join(' ') || 'なし'),
  ].join('<br>');

  $('result-agents').innerHTML = g.agents.map(a => {
    const detail = (a.kind === KIND_SUPPLY)
      ? `補給実行 ${a.refuelGiven}回`
      : `燃料${a.fuel}/${g.fuelLimits} / 獲得${a.totalUdon}玉` +
        (Object.keys(a.brandCount).length
          ? ' (' + Object.keys(a.brandCount).sort((x, y) => x - y).map(b => `b${b}×${a.brandCount[b]}`).join(', ') + ')'
          : '');
    return `<div class="agent-row">` +
      `<span class="agent-icon ${a.kind === KIND_SUPPLY ? 'supply' : 'patrol'}">${a.id}</span>` +
      ` 最終: セル${a.pos} / ${detail}</div>`;
  }).join('');

  $('result-days').innerHTML = g.dayHistory.map(h =>
    `D${h.day}: 種類${h.brands.length} (${h.brands.map(b => '系列' + b).join(',') || 'なし'}) / ${h.balls}玉`
  ).join('<br>');

  showScreen('result');
}

// ================================================================
// リセット(仕様G21/G29: 状態の完全初期化を徹底)
// ================================================================
function resetGameOnly() {
  // 同じマップ・同じ配置・同じ入力モードで、タイプ選択からやり直す
  app.game = null;
  app.timeline = [];
  app.phaseIdx = -1;
  app.dayStartView = null;
  app.guiDraft = null;
  app.guiSel = 0;
  app.selectedCell = null;
  $('plan-textarea').value = '';
  $('plan-error').textContent = '';
  $('gui-json-view').value = '';
  clearLog();
  gotoTypeScreen();
}

function resetAll() {
  resetGameOnly();
  app.mapData = null;
  app.inputMode = null;
  app.customPlace = false;
  app.placements = [];
  app.typeSel = [];
  $('start-error').textContent = '';
  $('place-error').textContent = '';
  $('chk-custom-place').checked = false;
  showScreen('start');
}

$('btn-reset-same').addEventListener('click', resetGameOnly);
$('btn-reset-all').addEventListener('click', resetAll);

// ================================================================
// 初期表示
// ================================================================
showScreen('start');
