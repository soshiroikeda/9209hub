'use strict';
// ================================================================
// sim.js — ヘキサうどん シミュレーションエンジン
// DOM非依存の純ロジック。マップ検証 / 行動計画検証 / 1日分の
// フェーズタイムライン生成を担う。
//
// 【重要な座標系】偶数行(0,2,4...)が右にずれる敷き詰め(公式Q&A Q1)
// 【フェーズ】0step:ACのみ / 1..N-1step:反映→AC / Nstep:反映のみ
// 【反映フェーズ内】燃料消費→移動反映→うどん獲得→補給→交通量更新
//
// 将来の複数チーム対応: game.playersDivisor と交通量集計部を
// 他チーム分に拡張すれば対応できる構造にしてある。
// ================================================================

const TERRAIN = { PLAIN: 0, ROAD: 1, MOUNTAIN: 2, POND: 3 };
const TERRAIN_NAME = ['平地', '道路', '山地', '池'];
const ROAD_STATUS_NAME = ['順調', '混雑', '渋滞'];
const ROAD_STEPS = [1, 2, 4];              // 順調/混雑/渋滞の移動ステップ数
const TERRAIN_STEPS = { 0: 2, 2: 3 };      // 平地2 / 山地3 (道路は状態依存)
const TERRAIN_FUEL = { 0: 1, 1: 2, 2: 2 }; // 平地1 / 道路2 / 山地2
const DIR_NAME = ['左上', '右上', '右', '右下', '左下', '左'];
const KIND_PATROL = 0, KIND_SUPPLY = 1;

// ---------------- 六角形の幾何 ----------------

// 隣接セル位置を返す。マップ外は null。
// dir: 0左上 1右上 2右 3右下 4左下 5左 (公式Q47)
// 偶数行が右にずれる敷き詰め(公式Q1)に基づくオフセット表。
function neighborPos(W, H, pos, dir) {
  const r = Math.floor(pos / W), c = pos % W;
  const even = (r % 2 === 0);
  const T = even
    ? [[-1, 0], [-1, 1], [0, 1], [1, 1], [1, 0], [0, -1]]   // 偶数行(右ずれ)
    : [[-1, -1], [-1, 0], [0, 1], [1, 0], [1, -1], [0, -1]]; // 奇数行
  const nr = r + T[dir][0], nc = c + T[dir][1];
  if (nr < 0 || nr >= H || nc < 0 || nc >= W) return null;
  return nr * W + nc;
}

function terrainAt(mapData, pos) {
  const W = mapData.map.width;
  return mapData.map.cells[Math.floor(pos / W)][pos % W];
}

// 現在地セルからの移動に必要なステップ数(道路は当日の状態を参照)
function stepCostAt(game, pos) {
  const t = terrainAt(game.mapData, pos);
  if (t === TERRAIN.ROAD) return ROAD_STEPS[game.roadStatus[pos] ?? 0];
  return TERRAIN_STEPS[t];
}

// ---------------- マップ構成JSONの検証 ----------------
// 戻り値: エラーメッセージ配列(空 = 合格)。
// 連結性チェックは仕様により省略(公式データは保証されている前提)。
function validateMapData(d) {
  const e = [];
  const isInt = Number.isInteger;
  if (typeof d !== 'object' || d === null) return ['JSONのルートがオブジェクトではありません。'];

  // --- map / cells ---
  if (typeof d.map !== 'object' || d.map === null) { e.push('"map" キーがありません。'); return e; }
  const H = d.map.height, W = d.map.width;
  if (!isInt(H) || !isInt(W)) { e.push('"map.height" / "map.width" は整数である必要があります。'); return e; }
  if (H < 8 || H > 32 || W < 8 || W > 32) e.push(`マップサイズは縦横それぞれ8〜32セルです (指定: 縦${H}×横${W})。`);
  if (!Array.isArray(d.map.cells) || d.map.cells.length !== H) {
    e.push(`"cells" の行数(${Array.isArray(d.map.cells) ? d.map.cells.length : '不正'})が height(${H})と一致しません。`);
    return e;
  }
  for (let r = 0; r < H; r++) {
    const row = d.map.cells[r];
    if (!Array.isArray(row) || row.length !== W) { e.push(`"cells" の${r}行目の列数が width(${W})と一致しません。`); return e; }
    for (let c = 0; c < W; c++) {
      if (!isInt(row[c]) || row[c] < 0 || row[c] > 3) e.push(`セル(${r},${c})の地形値 ${row[c]} が不正です(0〜3)。`);
    }
  }
  if (e.length) return e;
  const total = W * H;
  const cnt = [0, 0, 0, 0];
  for (let p = 0; p < total; p++) cnt[terrainAt(d, p)]++;
  for (let t = 0; t < 4; t++) if (cnt[t] === 0) e.push(`地形「${TERRAIN_NAME[t]}」がマップ上に1つも存在しません(公式Q35)。`);

  // --- 日程 ---
  if (!Array.isArray(d.daySteps) || d.daySteps.length === 0) e.push('"daySteps" が配列ではありません。');
  else {
    const D = d.daySteps.length;
    if (D < 4 || D > 10) e.push(`試合日数は4〜10日です (指定: ${D}日)。`);
    d.daySteps.forEach((n, i) => {
      if (!isInt(n) || n <= 0) e.push(`daySteps[${i}] が正の整数ではありません。`);
      else if (n < W + H || n > 4 * (W + H)) e.push(`daySteps[${i}]=${n} が範囲 [W+H=${W + H}, 4(W+H)=${4 * (W + H)}] を外れています(公式Q20)。`);
    });
    if (!Array.isArray(d.daySeconds) || d.daySeconds.length !== D) e.push('"daySeconds" が daySteps と同じ長さの配列ではありません。');
  }

  // --- 燃料・交通パラメータ ---
  if (!isInt(d.fuelLimits) || d.fuelLimits <= 0) e.push('"fuelLimits" が正の整数ではありません(公式Q31)。');
  else if (Array.isArray(d.daySteps) && isInt(d.daySteps[0])) {
    const s0 = d.daySteps[0];
    if (d.fuelLimits < s0 || d.fuelLimits > 3 * s0) e.push(`fuelLimits=${d.fuelLimits} が1日目ステップ数の1〜3倍 [${s0}, ${3 * s0}] を外れています(公式Q14)。`);
  }
  if (!isInt(d.players) || d.players < 1) e.push('"players" が1以上の整数ではありません。');
  if (!isInt(d.busyThreshold) || d.busyThreshold < 1 || d.busyThreshold > 5) e.push(`busyThreshold=${d.busyThreshold} が範囲1〜5を外れています(公式Q13)。`);
  if (!isInt(d.jammedThreshold) || d.jammedThreshold < 2 || d.jammedThreshold > 10) e.push(`jammedThreshold=${d.jammedThreshold} が範囲2〜10を外れています(公式Q13)。`);

  // --- エージェント ---
  if (!Array.isArray(d.agents)) e.push('"agents" が配列ではありません。');
  else {
    if (d.agents.length < 3 || d.agents.length > 8) e.push(`エージェント数は3〜8体です (指定: ${d.agents.length})。`);
    const seen = new Set();
    d.agents.forEach((p, i) => {
      if (!isInt(p) || p < 0 || p >= total) { e.push(`agents[${i}]=${p} がマップ範囲外です。`); return; }
      if (seen.has(p)) e.push(`agents[${i}]=${p} が他のエージェントと重複しています(公式Q37)。`);
      seen.add(p);
      if (terrainAt(d, p) !== TERRAIN.PLAIN) e.push(`agents[${i}] の初期位置セル${p}が平地ではありません(地形: ${TERRAIN_NAME[terrainAt(d, p)]})。`);
    });
  }

  // --- スポット ---
  if (!Array.isArray(d.spots)) e.push('"spots" が配列ではありません。');
  else {
    const agentN = Array.isArray(d.agents) ? d.agents.length : 0;
    const maxSpots = Math.max(W, H);
    if (d.spots.length < agentN || d.spots.length > maxSpots)
      e.push(`スポット数は エージェント数(${agentN})〜max(縦,横)(${maxSpots}) です (指定: ${d.spots.length})(公式Q15)。`);
    const seenPos = new Set();
    d.spots.forEach((s, i) => {
      if (typeof s !== 'object' || s === null) { e.push(`spots[${i}] がオブジェクトではありません。`); return; }
      if (!isInt(s.pos) || s.pos < 0 || s.pos >= total) { e.push(`spots[${i}].pos=${s.pos} がマップ範囲外です。`); return; }
      if (seenPos.has(s.pos)) e.push(`spots[${i}].pos=${s.pos} が他のスポットと重複しています(公式Q34)。`);
      seenPos.add(s.pos);
      if (terrainAt(d, s.pos) !== TERRAIN.PLAIN) e.push(`spots[${i}] のセル${s.pos}が平地ではありません。`);
      if (!isInt(s.brand) || s.brand < 0 || s.brand >= d.spots.length) e.push(`spots[${i}].brand=${s.brand} が範囲外です(0〜スポット数-1)。`);
      if (!isInt(s.stocks) || s.stocks < 1 || s.stocks > agentN) e.push(`spots[${i}].stocks=${s.stocks} が範囲1〜エージェント数(${agentN})を外れています。`);
      if (Array.isArray(d.agents) && d.agents.includes(s.pos)) e.push(`spots[${i}] のセル${s.pos}にエージェント初期位置が重なっています(初期位置は非スポット平地)。`);
    });
  }
  return e;
}

// ---------------- ゲーム状態 ----------------
// game は純データオブジェクト(関数・Map禁止: structuredClone 可能に保つ)
function createGame(mapData, agentTypes, initPositions) {
  const spotByPos = {};
  mapData.spots.forEach(s => { spotByPos[s.pos] = { brand: s.brand, stocks: s.stocks }; });
  return {
    mapData,
    W: mapData.map.width, H: mapData.map.height,
    spotByPos,
    fuelLimits: mapData.fuelLimits,
    daySteps: mapData.daySteps.slice(),
    days: mapData.daySteps.length,
    busy: mapData.busyThreshold,
    jammed: mapData.jammedThreshold,
    playersDivisor: 1, // 単一チームモード: 自チームのみで割る(仕様確定事項)
    day: 1,
    agents: initPositions.map((p, i) => ({
      id: i,
      kind: agentTypes[i],       // 0:巡回車 1:補給車
      pos: p,
      fuel: mapData.fuelLimits,  // 補給車では未使用
      totalUdon: 0,
      brandCount: {},            // 系列→玉数(累計)
      refuelGiven: 0,            // 補給車: 補給実行回数
    })),
    roadStatus: {},   // 道路セルpos→0/1/2 (startDayで決定)
    trafficDays: [],  // trafficDays[d-1] = d日目の {道路pos→滞在step数}
    stocks: {},       // スポットpos→現在在庫 (startDayで補充)
    dayHistory: [],   // 完了日ごとの {day, brands:[], balls}
    totalByBrand: {}, // 系列→総玉数(チーム)
  };
}

// 各日の開始処理: 在庫補充 + 道路状態の決定
function startDay(game) {
  for (const pos in game.spotByPos) game.stocks[pos] = game.spotByPos[pos].stocks;
  game.roadStatus = computeRoadStatus(game);
}

// 道路状態: 1日目は全て順調。2日目は前日分のみ、3日目以降は前日+前々日の
// 滞在step合算(将来: 全チーム合算) ÷ playersDivisor を基準値と小数のまま比較。
function computeRoadStatus(game) {
  const st = {};
  const total = game.W * game.H;
  for (let p = 0; p < total; p++) {
    if (terrainAt(game.mapData, p) !== TERRAIN.ROAD) continue;
    if (game.day === 1) { st[p] = 0; continue; }
    const prev = game.trafficDays[game.day - 2] || {};
    const prev2 = (game.day >= 3) ? (game.trafficDays[game.day - 3] || {}) : {};
    const t = ((prev[p] || 0) + (prev2[p] || 0)) / game.playersDivisor;
    st[p] = (t >= game.jammed) ? 2 : (t >= game.busy) ? 1 : 0;
  }
  return st;
}

// 状態決定に使う交通量の内訳を返す(セル詳細表示用)
function trafficDetail(game, pos) {
  const prev = (game.day >= 2) ? ((game.trafficDays[game.day - 2] || {})[pos] || 0) : 0;
  const prev2 = (game.day >= 3) ? ((game.trafficDays[game.day - 3] || {})[pos] || 0) : 0;
  return { prev, prev2, value: (prev + prev2) / game.playersDivisor };
}

// ---------------- 行動計画の検証 ----------------

// 構造チェック: 配列の形と値域
function checkPlanStructure(plans, agentCount) {
  const e = [];
  if (!Array.isArray(plans)) return ['回答のルートが配列ではありません。'];
  if (plans.length !== agentCount)
    e.push(`行動列の数(${plans.length})がエージェント数(${agentCount})と一致しません。`);
  plans.forEach((plan, i) => {
    if (!Array.isArray(plan)) { e.push(`エージェント${i}: 行動列が配列ではありません。`); return; }
    plan.forEach((v, k) => {
      if (!Number.isInteger(v)) e.push(`エージェント${i}: ${k + 1}番目の値 ${JSON.stringify(v)} が整数ではありません。`);
      else if (v > 5) e.push(`エージェント${i}: ${k + 1}番目の値 ${v} が不正です(待機は-1以下、移動は0〜5)。`);
    });
  });
  return e;
}

// 経路チェック: マップ外・池・合計ステップ数(各エージェント独立に検証可能)
function validatePlanPaths(game, plans) {
  const e = [];
  const N = game.daySteps[game.day - 1];
  plans.forEach((plan, i) => {
    let sum = 0, pos = game.agents[i].pos, broken = false;
    for (let k = 0; k < plan.length; k++) {
      const v = plan[k];
      if (v <= -1) { sum += -v; continue; }
      const nb = neighborPos(game.W, game.H, pos, v);
      if (nb === null) {
        e.push(`エージェント${i}: ${k + 1}番目の行動(${DIR_NAME[v]}) はセル${pos}からマップ外への移動です。`);
        broken = true; break;
      }
      if (terrainAt(game.mapData, nb) === TERRAIN.POND) {
        e.push(`エージェント${i}: ${k + 1}番目の行動(${DIR_NAME[v]}) はセル${pos}→${nb}(池)への移動です。池には進入できません。`);
        broken = true; break;
      }
      sum += stepCostAt(game, pos);
      pos = nb;
    }
    if (!broken && sum !== N) {
      const hint = sum < N ? ` 不足分は末尾に待機(-${N - sum})を追加してください。` : ' 移動を完了するためのステップ数が不足しています。';
      e.push(`エージェント${i}: 行動の合計ステップ数(${sum})が規定ステップ数(${N})と一致しません。${hint}`);
    }
  });
  return e;
}

// ---------------- 1日分のシミュレーション ----------------
// game を変更しないよう複製上で実行する。
// 戻り値: { valid, errors, timeline, game(進行後の複製), dayResult }
// timeline[i] = { kind:'AC'|'REF', step, logs:[], snapshot }
function runDay(origGame, plans) {
  const game = structuredClone(origGame);
  const N = game.daySteps[game.day - 1];
  const errors = [];
  const timeline = [];

  const cumTypesBefore = game.dayHistory.reduce((a, h) => a + h.brands.length, 0);

  // エージェントごとの実行時状態
  const rt = game.agents.map((a, i) => ({
    queue: plans[i], qi: 0,
    action: null, // {type:'move',dir,from,to,cost,fuelCost,remain} | {type:'wait',len,remain}
  }));
  const acquiredToday = game.agents.map(() => new Set()); // スポットpos集合
  const trafficToday = {};
  const dayBrands = new Set();
  let ballsToday = 0;

  function snapshot(step) {
    return {
      day: game.day, step, dayN: N,
      agents: game.agents.map((ag, i) => ({
        id: i, kind: ag.kind, pos: ag.pos, fuel: ag.fuel,
        totalUdon: ag.totalUdon, brandCount: { ...ag.brandCount },
        refuelGiven: ag.refuelGiven,
        action: rt[i].action ? { ...rt[i].action } : null,
      })),
      stocks: { ...game.stocks },
      trafficToday: { ...trafficToday },
      dayBrands: [...dayBrands],
      totalByBrand: { ...game.totalByBrand },
      cumTypes: cumTypesBefore + dayBrands.size,
      totalBalls: game.agents.reduce((a, ag) => a + ag.totalUdon, 0),
    };
  }

  // ----- アクションフェーズ(step t): 完了済みエージェントに次の行動を予約 -----
  function acPhase(t) {
    const logs = [];
    rt.forEach((r, i) => {
      if (r.action && r.action.remain > 0) return;
      r.action = null;
      if (r.qi >= r.queue.length) return; // 合計一致検証済みのため通常発生しない
      const v = r.queue[r.qi++];
      const ag = game.agents[i];
      if (v <= -1) {
        r.action = { type: 'wait', len: -v, remain: -v };
        logs.push(`A${i}: 待機予約 ${-v}step (S${t + (-v)}まで)`);
      } else {
        const from = ag.pos;
        const to = neighborPos(game.W, game.H, from, v);
        const terr = terrainAt(game.mapData, from);
        const cost = (terr === TERRAIN.ROAD) ? ROAD_STEPS[game.roadStatus[from] ?? 0] : TERRAIN_STEPS[terr];
        r.action = { type: 'move', dir: v, from, to, cost, fuelCost: TERRAIN_FUEL[terr], remain: cost };
        logs.push(`A${i}: 移動予約 ${DIR_NAME[v]}(${v}) セル${from}→${to} 所要${cost}step (S${t + cost}完了)`);
      }
    });
    return logs;
  }

  // ----- 反映フェーズ(step t) -----
  // 1.1燃料消費 → 1.2移動反映 → 1.3うどん獲得 → 1.4補給 → 1.5交通量更新
  function refPhase(t) {
    const logs = [];
    const doneMoves = [], doneWaits = [];
    rt.forEach((r, i) => {
      if (!r.action) return;
      r.action.remain--;
      if (r.action.remain === 0) (r.action.type === 'move' ? doneMoves : doneWaits).push(i);
    });

    // 1.1 燃料消費(巡回車のみ / 補給車は燃料を使わない)
    for (const i of doneMoves) {
      const ag = game.agents[i], act = rt[i].action;
      if (ag.kind !== KIND_PATROL) continue;
      if (ag.fuel < act.fuelCost) {
        errors.push(
          `エージェント${i}: Step${t} 時点でセル${act.from}(${TERRAIN_NAME[terrainAt(game.mapData, act.from)]})→` +
          `セル${act.to} の移動に必要な燃料が不足しています (必要:${act.fuelCost} / 残:${ag.fuel})。` +
          `燃料が補給されるまで待機を指定してください。回答全体をリジェクトしました。`);
        return { logs, fatal: true };
      }
      ag.fuel -= act.fuelCost;
      logs.push(`A${i}: 燃料消費 -${act.fuelCost} (移動元セル${act.from}:${TERRAIN_NAME[terrainAt(game.mapData, act.from)]}) → 残${ag.fuel}`);
    }

    // 1.2 移動反映
    for (const i of doneMoves) {
      const act = rt[i].action;
      game.agents[i].pos = act.to;
      logs.push(`A${i}: セル${act.from}→${act.to} 移動完了`);
    }
    for (const i of doneWaits) logs.push(`A${i}: 待機完了`);
    for (const i of [...doneMoves, ...doneWaits]) rt[i].action = null;

    // 1.3 うどん獲得(エージェント番号の若い順 / 公式Q26)
    game.agents.forEach((ag, i) => {
      if (ag.kind !== KIND_PATROL) return;
      const spot = game.spotByPos[ag.pos];
      if (!spot) return;
      if (acquiredToday[i].has(ag.pos)) return;
      if ((game.stocks[ag.pos] || 0) <= 0) {
        // 到着した瞬間のみ「在庫切れ」を記録(待機中の連続ログは抑制)
        if (doneMoves.includes(i)) logs.push(`A${i}: セル${ag.pos} 到着したが在庫0のため獲得不可`);
        return;
      }
      game.stocks[ag.pos]--;
      acquiredToday[i].add(ag.pos);
      ag.totalUdon++;
      ag.brandCount[spot.brand] = (ag.brandCount[spot.brand] || 0) + 1;
      game.totalByBrand[spot.brand] = (game.totalByBrand[spot.brand] || 0) + 1;
      dayBrands.add(spot.brand);
      ballsToday++;
      logs.push(`A${i}: うどん獲得! 系列${spot.brand} (セル${ag.pos} 在庫${game.stocks[ag.pos] + 1}→${game.stocks[ag.pos]})`);
    });

    // 1.4 補給(移動反映後の位置で判定 / 公式Q22)
    const supplyCells = new Set();
    game.agents.forEach(ag => { if (ag.kind === KIND_SUPPLY) supplyCells.add(ag.pos); });
    game.agents.forEach((ag, i) => {
      if (ag.kind !== KIND_PATROL) return;
      if (supplyCells.has(ag.pos) && ag.fuel < game.fuelLimits) {
        const before = ag.fuel;
        ag.fuel = game.fuelLimits;
        const sup = game.agents.find(s => s.kind === KIND_SUPPLY && s.pos === ag.pos);
        if (sup) sup.refuelGiven++;
        logs.push(`A${i}: 補給 ${before}→${ag.fuel} (セル${ag.pos}${sup ? ` / 補給車A${sup.id}` : ''})`);
      }
    });

    // 1.5 交通量更新(移動後の位置 / 全エージェント / 公式Q27)
    const added = {};
    game.agents.forEach(ag => {
      if (terrainAt(game.mapData, ag.pos) === TERRAIN.ROAD) {
        trafficToday[ag.pos] = (trafficToday[ag.pos] || 0) + 1;
        added[ag.pos] = (added[ag.pos] || 0) + 1;
      }
    });
    const keys = Object.keys(added);
    if (keys.length) logs.push('交通量: ' + keys.map(p => `セル${p} +${added[p]}(本日累計${trafficToday[p]})`).join(' / '));

    return { logs };
  }

  // ----- フェーズ列の実行: 0:AC / 1..N-1:反映→AC / N:反映 -----
  timeline.push({ kind: 'AC', step: 0, logs: acPhase(0), snapshot: snapshot(0) });
  for (let t = 1; t <= N; t++) {
    const ref = refPhase(t);
    timeline.push({ kind: 'REF', step: t, logs: ref.logs, snapshot: snapshot(t) });
    if (ref.fatal) return { valid: false, errors, timeline: [], game: origGame, dayResult: null };
    if (t < N) timeline.push({ kind: 'AC', step: t, logs: acPhase(t), snapshot: snapshot(t) });
  }

  // ----- 日の確定処理(複製側に記録) -----
  game.trafficDays.push(trafficToday);
  game.dayHistory.push({ day: game.day, brands: [...dayBrands], balls: ballsToday });

  return { valid: true, errors: [], timeline, game, dayResult: { dayBrands: [...dayBrands], ballsToday, trafficToday } };
}

// 提出計画の総合検証 + 実行。エラーがあれば {valid:false, errors}
function submitDayPlans(game, plans) {
  let errs = checkPlanStructure(plans, game.agents.length);
  if (errs.length) return { valid: false, errors: errs };
  errs = validatePlanPaths(game, plans);
  if (errs.length) return { valid: false, errors: errs };
  return runDay(game, plans); // 燃料不足はここで検出
}

// node(テスト)用エクスポート
if (typeof module !== 'undefined') {
  module.exports = {
    TERRAIN, TERRAIN_NAME, ROAD_STATUS_NAME, ROAD_STEPS, TERRAIN_STEPS, TERRAIN_FUEL,
    DIR_NAME, KIND_PATROL, KIND_SUPPLY,
    neighborPos, terrainAt, stepCostAt,
    validateMapData, createGame, startDay, computeRoadStatus, trafficDetail,
    checkPlanStructure, validatePlanPaths, runDay, submitDayPlans,
  };
}
