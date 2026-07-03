'use strict';
// ================================================================
// test_sim.js — sim.js の検証テスト(node実行)
// 中核: 公式Q&A補足資料 [3/4]-[4/4] の8エージェント実例の完全再現
// ================================================================
const S = require('./sim.js');

let pass = 0, fail = 0;
function eq(name, actual, expected) {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a === b) { pass++; console.log(`  OK   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n       actual:   ${a}\n       expected: ${b}`); }
}

// ---------------------------------------------------------------
// [1] 隣接テーブル(偶数行が右にずれる / 公式Q1・Q47)
// ---------------------------------------------------------------
console.log('[1] 隣接テーブル');
{
  const W = 8, H = 8;
  // 偶数行 row2 col3 = pos19 (右にずれている行)
  eq('偶数行 左上(0)', S.neighborPos(W, H, 19, 0), 11);
  eq('偶数行 右上(1)', S.neighborPos(W, H, 19, 1), 12);
  eq('偶数行 右(2)',   S.neighborPos(W, H, 19, 2), 20);
  eq('偶数行 右下(3)', S.neighborPos(W, H, 19, 3), 28);
  eq('偶数行 左下(4)', S.neighborPos(W, H, 19, 4), 27);
  eq('偶数行 左(5)',   S.neighborPos(W, H, 19, 5), 18);
  // 奇数行 row1 col3 = pos11
  eq('奇数行 左上(0)', S.neighborPos(W, H, 11, 0), 2);
  eq('奇数行 右上(1)', S.neighborPos(W, H, 11, 1), 3);
  eq('奇数行 右(2)',   S.neighborPos(W, H, 11, 2), 12);
  eq('奇数行 右下(3)', S.neighborPos(W, H, 11, 3), 19);
  eq('奇数行 左下(4)', S.neighborPos(W, H, 11, 4), 18);
  eq('奇数行 左(5)',   S.neighborPos(W, H, 11, 5), 10);
  // マップ外
  eq('左端から左はnull', S.neighborPos(W, H, 8, 5), null);
  eq('上端から左上はnull', S.neighborPos(W, H, 0, 0), null);
  eq('右下隅から右下はnull', S.neighborPos(W, H, 63, 3), null);
}

// ---------------------------------------------------------------
// [2] 公式補足資料の実例再現
//   1行×4セル: 0=道路(順調) 1=道路(混雑) 2=平地(スポット在庫4) 3=平地
//   fuelLimits=3, N=6, 8エージェント(index順: A,B,C,D,E,F,G,補給)
// ---------------------------------------------------------------
console.log('[2] 公式補足資料の実例');
{
  const mapData = {
    daySeconds: [60], daySteps: [6],
    map: { height: 1, width: 4, cells: [[1, 1, 0, 0]] },
    spots: [{ brand: 0, pos: 2, stocks: 4 }],
    agents: [0, 0, 0, 0, 2, 3, 3, 2],
    fuelLimits: 3, players: 1, busyThreshold: 99, jammedThreshold: 100,
  };
  const types = [0, 0, 0, 0, 0, 0, 0, 1]; // 最後だけ補給車
  const game = S.createGame(mapData, types, mapData.agents);
  S.startDay(game);
  game.roadStatus[1] = 1; // 例の前提: セル1は混雑(day1は本来順調だが例に合わせ注入)

  const plans = [
    [2, 2, 2, -1],   // A
    [-1, 2, 2, 2],   // B
    [-2, 2, 2, -1],  // C
    [-3, 2, -2],     // D
    [5, 5, -2],      // E
    [5, 5, -2],      // F
    [-2, 5, 5],      // G
    [5, 5, -2],      // 補給車
  ];
  const r = S.submitDayPlans(game, plans);
  eq('回答が有効', r.valid, true);
  const g = r.game;
  eq('最終位置 [A..G,補給]', g.agents.map(a => a.pos), [3, 3, 2, 1, 0, 1, 1, 0]);
  eq('最終燃料 [A..G]', g.agents.slice(0, 7).map(a => a.fuel), [0, 0, 1, 1, 3, 1, 1]);
  eq('うどん獲得 [A..G]', g.agents.slice(0, 7).map(a => a.totalUdon), [1, 1, 0, 0, 1, 1, 0]);
  eq('スポット在庫が0', g.stocks[2], 0);
  eq('交通量 セル0=12', r.dayResult.trafficToday[0], 12);
  eq('交通量 セル1=17', r.dayResult.trafficToday[1], 17);
  eq('獲得系列は{0}', r.dayResult.dayBrands, [0]);
  eq('本日の玉数=4', r.dayResult.ballsToday, 4);

  // フェーズ数 = 1(AC) + 2*(N-1) + 1(REF) = 2N
  eq('タイムラインのフェーズ数=12', r.timeline.length, 12);

  // E は S1(最初の反映)で獲得(公式: スポットからのスタートなのでステップ1で獲得)
  const s1 = r.timeline.find(p => p.kind === 'REF' && p.step === 1);
  eq('S1でEが獲得', s1.snapshot.agents[4].totalUdon, 1);
  // B は S4 で獲得し、同時到着の G は獲得しない(ID順 / 公式Q26)
  const s4 = r.timeline.find(p => p.kind === 'REF' && p.step === 4);
  eq('S4でBが獲得', s4.snapshot.agents[1].totalUdon, 1);
  eq('S4でGは獲得しない', s4.snapshot.agents[6].totalUdon, 0);
  eq('S4で在庫0', s4.snapshot.stocks[2], 0);
  // F は補給車の1セル後ろを追いかけるため一度も補給されない(公式Q22)
  const anyRefuelF = r.timeline.some(p => p.logs.some(l => l.startsWith('A5: 補給')));
  eq('Fは一度も補給されない', anyRefuelF, false);
  // E は移動のたび消費→同フェーズで補給され満タン維持
  const s2 = r.timeline.find(p => p.kind === 'REF' && p.step === 2);
  eq('S2終了時Eは満タン', s2.snapshot.agents[4].fuel, 3);
  // 元のgameが変更されていない(runDayは複製上で実行)
  eq('元のgameは不変(位置)', game.agents.map(a => a.pos), [0, 0, 0, 0, 2, 3, 3, 2]);
}

// ---------------------------------------------------------------
// [3] 無効回答の検出
// ---------------------------------------------------------------
console.log('[3] 無効回答');
{
  const mapData = {
    daySeconds: [60], daySteps: [6],
    map: { height: 1, width: 4, cells: [[1, 1, 0, 0]] },
    spots: [{ brand: 0, pos: 2, stocks: 4 }],
    agents: [0, 0, 0, 0, 2, 3, 3, 2],
    fuelLimits: 3, players: 1, busyThreshold: 99, jammedThreshold: 100,
  };
  const types = [0, 0, 0, 0, 0, 0, 0, 1];
  function fresh() { const g = S.createGame(mapData, types, mapData.agents); S.startDay(g); g.roadStatus[1] = 1; return g; }
  const idle = [[-6], [-6], [-6], [-6], [-6], [-6], [-6]]; // 7体分(1体分を差し替えて使う)

  // ステップ数超過(巡回車A: 最後の待機なしで移動追加 → 合計超過)
  let r = S.submitDayPlans(fresh(), [[2, 2, 2, 2], ...idle]);
  eq('合計超過は無効', r.valid, false);
  // ステップ数不足(最後に待機を入れない: 公式「巡回車A」の注意)
  r = S.submitDayPlans(fresh(), [[2, 2, 2], ...idle]);
  eq('合計不足は無効', r.valid, false);
  // マップ外
  r = S.submitDayPlans(fresh(), [[5, -5], ...idle]);
  eq('マップ外移動は無効', r.valid, false);
  // 燃料不足(公式「巡回車D」: 待機3→右→さらに右は燃料不足)
  r = S.submitDayPlans(fresh(), [[-3, 2, 2], ...idle]);
  eq('燃料不足は無効', r.valid, false);
  eq('燃料エラー文言', r.errors[0].includes('燃料が不足'), true);
  // エージェント数不一致
  r = S.submitDayPlans(fresh(), [[-6], [-6]]);
  eq('本数不一致は無効', r.valid, false);
  // 非整数
  r = S.submitDayPlans(fresh(), [['a', -5], ...idle]);
  eq('非整数は無効', r.valid, false);
}

// ---------------------------------------------------------------
// [4] 池への移動 / 複数日の交通量と道路状態
// ---------------------------------------------------------------
console.log('[4] 池 / 複数日交通量');
{
  // 2行×4列: row0 = [平,道,平,平], row1 = [池,平,平,平]
  const mapData = {
    daySeconds: [60, 60, 60], daySteps: [4, 4, 4],
    map: { height: 2, width: 4, cells: [[0, 1, 0, 0], [3, 0, 0, 0]] },
    spots: [{ brand: 0, pos: 2, stocks: 1 }],
    agents: [0],
    fuelLimits: 12, players: 1, busyThreshold: 3, jammedThreshold: 6,
  };
  const game = S.createGame(mapData, [0], [0]);
  S.startDay(game);

  // 池への移動(pos0 は偶数行 → 右下(3)は row1,col1=pos5(平地)、左下(4)は row1,col0=pos4(池))
  let r = S.submitDayPlans(game, [[4, -2]]);
  eq('池への移動は無効', r.valid, false);
  eq('池エラー文言', r.errors[0].includes('池'), true);

  // Day1: 道路セル1に移動して滞在 → 交通量を蓄積
  // pos0(平地:2step,燃料1) 右(2)→pos1、残り2stepを待機
  r = S.submitDayPlans(game, [[2, -2]]);
  eq('Day1 有効', r.valid, true);
  // S2で移動完了しpos1(道路)。S2,S3,S4の反映で滞在カウント → 3
  eq('Day1 セル1交通量=3', r.dayResult.trafficToday[1], 3);
  let g = r.game;

  // Day2 開始: 前日交通量3 ÷ 1 = 3 → busy(3)以上 jammed(6)未満 → 混雑
  g.day = 2; S.startDay(g);
  eq('Day2 セル1は混雑', g.roadStatus[1], 1);
  eq('Day2 在庫補充', g.stocks[2], 1);

  // Day2: pos1(道路・混雑:2step,燃料2) 右(2)→pos2(スポット)、残2待機
  r = S.submitDayPlans(g, [[2, -2]]);
  eq('Day2 有効', r.valid, true);
  g = r.game;
  eq('Day2 うどん獲得(在庫1→0)', g.agents[0].totalUdon, 1);
  // S1,S2の反映でpos1に滞在(移動完了はS2 → S2は移動後pos2でカウントなし)
  // S1: pos1滞在+1。S2: 移動完了→pos2(道路でない)。→ Day2のセル1交通量=1
  eq('Day2 セル1交通量=1', r.dayResult.trafficToday[1], 1);

  // Day3 開始: (前日1 + 前々日3) ÷ 1 = 4 → 混雑
  g.day = 3; S.startDay(g);
  eq('Day3 セル1は混雑(4.0)', g.roadStatus[1], 1);
  eq('Day3 交通量内訳', S.trafficDetail(g, 1), { prev: 1, prev2: 3, value: 4 });

  // 待機中は燃料を消費しない(公式Q16)
  eq('燃料はDay1:-1, Day2:-2 のみ消費', g.agents[0].fuel, 12 - 1 - 2);
  // 累積種類数(日ごとの種類数の合計): Day1=0種, Day2=1種
  eq('dayHistory', g.dayHistory.map(h => [h.day, h.brands.length, h.balls]), [[1, 0, 0], [2, 1, 1]]);
}

// ---------------------------------------------------------------
// [5] 日をまたぐ同一スポット再獲得(公式Q7/Q8/Q17) と 0ステップ目
// ---------------------------------------------------------------
console.log('[5] 日またぎ獲得');
{
  const mapData = {
    daySeconds: [60, 60], daySteps: [4, 4],
    map: { height: 2, width: 4, cells: [[0, 0, 0, 0], [3, 1, 2, 0]] },
    spots: [{ brand: 1, pos: 1, stocks: 2 }],
    agents: [0],
    fuelLimits: 12, players: 1, busyThreshold: 3, jammedThreshold: 6,
  };
  const game = S.createGame(mapData, [0], [0]);
  S.startDay(game);

  // Day1: pos0 右(2)→pos1(スポット) 2step、残2待機
  let r = S.submitDayPlans(game, [[2, -2]]);
  let g = r.game;
  eq('Day1で1玉獲得', g.agents[0].totalUdon, 1);
  // 同日中に待機し続けても2玉目は獲得しない
  eq('同日重複獲得なし(在庫2→1)', g.stocks[1], 1);

  // Day2: スポット上で1日待機 → 0ステップ目では獲得せず、S1の反映で獲得(公式Q7)
  g.day = 2; S.startDay(g);
  r = S.submitDayPlans(g, [[-4]]);
  const s1 = r.timeline.find(p => p.kind === 'REF' && p.step === 1);
  eq('Day2 S1で再獲得', s1.snapshot.agents[0].totalUdon, 2);
  const s0 = r.timeline.find(p => p.kind === 'AC' && p.step === 0);
  eq('Day2 S0では未獲得', s0.snapshot.agents[0].totalUdon, 1);
}

// ---------------------------------------------------------------
// [6] マップ検証
// ---------------------------------------------------------------
console.log('[6] マップ検証');
{
  const SAMPLE = {"startsAt":1778227200,"daySeconds":[60,60,60,60],"daySteps":[16,16,16,16],"map":{"height":8,"width":8,"cells":[[0,1,0,0,0,2,0,0],[0,0,0,1,0,0,0,2],[3,0,1,0,0,0,0,0],[0,0,0,0,1,0,2,0],[0,2,0,1,0,0,0,0],[0,0,0,0,0,1,0,2],[0,1,0,0,2,0,0,0],[0,0,0,1,0,0,0,0]]},"spots":[{"brand":0,"pos":10,"stocks":3},{"brand":1,"pos":20,"stocks":3},{"brand":0,"pos":36,"stocks":3},{"brand":1,"pos":50,"stocks":3}],"agents":[0,4,56,62],"fuelLimits":20,"players":1,"busyThreshold":3,"jammedThreshold":6};
  eq('サンプルマップは合格', S.validateMapData(SAMPLE), []);

  const bad = structuredClone(SAMPLE);
  bad.map.cells[0][0] = 5;
  eq('不正地形値を検出', S.validateMapData(bad).length > 0, true);

  const bad2 = structuredClone(SAMPLE);
  bad2.agents = [0, 0, 56, 62];
  eq('初期位置重複を検出', S.validateMapData(bad2).some(m => m.includes('重複')), true);

  const bad3 = structuredClone(SAMPLE);
  bad3.spots[0].pos = 9; // pos9はrow1col1=0平地だがエージェント…ではない → stocksテスト用に別件
  bad3.spots[0].pos = 0; // エージェント初期位置と衝突
  eq('スポットと初期位置の衝突を検出', S.validateMapData(bad3).some(m => m.includes('初期位置')), true);

  const bad4 = structuredClone(SAMPLE);
  bad4.fuelLimits = 100; // 16*3=48超
  eq('fuelLimits範囲外を検出', S.validateMapData(bad4).some(m => m.includes('fuelLimits')), true);
}

console.log(`\n===== 結果: PASS ${pass} / FAIL ${fail} =====`);
process.exit(fail ? 1 : 0);
