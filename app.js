// ---- State ----
let allData = null;
let categoryStyleMap = {};

// ---- Page initialization ----
document.getElementById('page-title').textContent = CONFIG.title;
document.getElementById('page-subtitle').textContent = CONFIG.subtitle;
document.title = CONFIG.title + ' - Live Scores';

// ---- Category palette system ----
const CATEGORY_PALETTE = [
  { bg: '#1e3a5f', color: '#60a5fa' }, { bg: '#3b1f54', color: '#c084fc' },
  { bg: '#1a3d2e', color: '#34d399' }, { bg: '#3d2b1a', color: '#fbbf24' },
  { bg: '#3d1a2b', color: '#f472b6' }, { bg: '#1a3d3d', color: '#2dd4bf' },
  { bg: '#2d2d1a', color: '#a3e635' }, { bg: '#3d1a1a', color: '#fca5a5' },
  { bg: '#1a2a3d', color: '#93c5fd' }, { bg: '#2a1a3d', color: '#d8b4fe' },
  { bg: '#3d3d1a', color: '#fde047' }, { bg: '#1a3d28', color: '#6ee7b7' },
];
let nextPaletteIndex = 0;
const dynamicStyleSheet = document.createElement('style');
document.head.appendChild(dynamicStyleSheet);

function getCategoryClass(category) {
  if (!category) return '';
  const key = category.toLowerCase().trim();
  if (categoryStyleMap[key]) return categoryStyleMap[key];
  const className = 'cat-dyn-' + nextPaletteIndex;
  const palette = CATEGORY_PALETTE[nextPaletteIndex % CATEGORY_PALETTE.length];
  dynamicStyleSheet.textContent += `.${className} { background: ${palette.bg}; color: ${palette.color}; }\n`;
  categoryStyleMap[key] = className;
  nextPaletteIndex++;
  return className;
}

// ---- Utility functions ----
function findColumn(headers, keyword) {
  const kw = keyword.toLowerCase();
  // Prefer exact match, then word-boundary match, then substring match
  const exact = headers.findIndex(h => h.toLowerCase().trim() === kw);
  if (exact !== -1) return exact;
  const wordRe = new RegExp('\\b' + kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i');
  const word = headers.findIndex(h => wordRe.test(h));
  if (word !== -1) return word;
  return headers.findIndex(h => h.toLowerCase().includes(kw));
}

// Extract the Question ID from a column label. With headers=3, the gviz API
// merges the Question ID row with the Forms header row, producing labels like
// "HeadsOrTails What will be the result..." or "HeadsOrTails HeadsOrTails".
// The Question ID is always the first space-delimited token.
function extractQuestionId(label) {
  const trimmed = label.trim();
  const spaceIdx = trimmed.indexOf(' ');
  return spaceIdx === -1 ? trimmed : trimmed.substring(0, spaceIdx);
}

// ---- Data loading ----
function loadSheetJsonp(gid, headers) {
  return new Promise((resolve, reject) => {
    const callbackName = '_gvizCb_' + gid + '_' + Date.now();
    const script = document.createElement('script');
    let url = `https://docs.google.com/spreadsheets/d/${CONFIG.sheetId}/gviz/tq?gid=${gid}&tqx=responseHandler:${callbackName}`;
    if (headers) url += '&headers=' + headers;
    script.src = url;
    window[callbackName] = function(response) {
      delete window[callbackName]; script.remove();
      if (response && response.table) resolve(response.table);
      else reject(new Error('Invalid response from Google Sheets'));
    };
    script.onerror = function() { delete window[callbackName]; script.remove(); reject(new Error('Failed to load sheet data')); };
    document.head.appendChild(script);
  });
}

function gvizToRows(table) {
  const colLabels = table.cols.map(c => c.label || '');
  const hasLabels = colLabels.some(l => l.length > 0);
  const dataRows = table.rows.map(row => row.c.map(cell => { if (!cell) return ''; return cell.v != null ? String(cell.v) : (cell.f || ''); }));
  if (hasLabels) return [colLabels, ...dataRows];
  else return dataRows;
}

function computeRanks(sorted) {
  const ranks = new Map();
  let i = 0;
  while (i < sorted.length) {
    let j = i + 1;
    while (j < sorted.length && sorted[j].score === sorted[i].score) j++;
    const isTied = (j - i) > 1;
    const rankNum = i + 1;
    for (let k = i; k < j; k++) ranks.set(sorted[k].name, isTied ? `T${rankNum}` : `${rankNum}`);
    i = j;
  }
  return ranks;
}

async function loadData() {
  const contentEl = document.getElementById('content');
  contentEl.innerHTML = '<div class="loading"><div class="spinner"></div><br>Loading data from Google Sheets...</div>';
  try {
    // Contest: headers=3 merges the 3 header rows (empty, Question IDs, Forms headers)
    // into clean column labels. Results: headers=1 uses row 1 as labels.
    const [contestTable, resultsTable] = await Promise.all([loadSheetJsonp(CONFIG.contestGid, 3), loadSheetJsonp(CONFIG.resultsGid, 1)]);
    const contest = gvizToRows(contestTable);
    const results = gvizToRows(resultsTable);

    const contestHeader = contest[0];
    const contestData = contest.slice(1);

    const colName = findColumn(contestHeader, CONFIG.contestColumns.name);
    const colScore = findColumn(contestHeader, CONFIG.contestColumns.score);
    const colRemaining = findColumn(contestHeader, CONFIG.contestColumns.remaining);
    const colEliminated = findColumn(contestHeader, CONFIG.contestColumns.eliminated);
    if (colName === -1 || colScore === -1) throw new Error('Could not find required columns.');

    const resultsHeader = results[0];
    const rColCategory = findColumn(resultsHeader, CONFIG.resultsColumns.category);
    const rColQuestionId = findColumn(resultsHeader, CONFIG.resultsColumns.questionId);
    const rColPrompt = findColumn(resultsHeader, CONFIG.resultsColumns.prompt);
    const rColResult = findColumn(resultsHeader, CONFIG.resultsColumns.result);
    if (rColQuestionId === -1 || rColPrompt === -1) throw new Error('Could not find required results columns.');

    const excludedCats = new Set(CONFIG.excludedCategories.map(c => c.toLowerCase()));

    // Build set of valid Question IDs from Results (excluding Informational)
    const allQuestionIds = new Set();
    for (let i = 1; i < results.length; i++) {
      const cat = (results[i][rColCategory] || '').trim().toLowerCase();
      const qid = (results[i][rColQuestionId] || '').trim();
      if (qid && !excludedCats.has(cat)) allQuestionIds.add(qid);
    }

    // Match contest columns to question IDs by extracting the first token from the label
    const metaColumns = new Set([colName, colScore, colRemaining, colEliminated].filter(i => i !== -1));
    const questionColumns = [];
    for (let j = 0; j < contestHeader.length; j++) {
      if (metaColumns.has(j)) continue;
      const colLabel = contestHeader[j].trim();
      if (!colLabel) continue;
      const qid = extractQuestionId(colLabel);
      if (allQuestionIds.has(qid)) questionColumns.push({ index: j, id: qid });
    }

    // Build question detail map (prompt, result, category) for rendering
    const questionMap = {};
    for (let i = 1; i < results.length; i++) {
      const category = (rColCategory !== -1 ? results[i][rColCategory] : '') || '';
      if (excludedCats.has(category.toLowerCase().trim())) continue;
      const qid = results[i][rColQuestionId] || '';
      const prompt = results[i][rColPrompt] || '';
      const result = (rColResult !== -1 ? results[i][rColResult] : '') || '';
      if (qid) questionMap[qid] = { prompt, result, category };
    }

    const entries = [];
    for (const r of contestData) {
      const answers = {};
      for (const qc of questionColumns) answers[qc.id] = r[qc.index] || '';
      entries.push({ name: r[colName] || '', score: parseInt(r[colScore]) || 0, totalRemaining: colRemaining !== -1 ? (parseInt(r[colRemaining]) || 0) : 0, eliminated: colEliminated !== -1 ? (r[colEliminated] === CONFIG.eliminatedValue) : false, answers });
    }

    allData = { entries, questionMap, questionColumns: questionColumns.map(qc => qc.id) };
    const select = document.getElementById('name-select');
    const currentVal = select.value;
    select.innerHTML = '<option value="">-- Select a name --</option>';
    const sortedNames = entries.map(e => e.name).filter(n => n).sort();
    for (const name of sortedNames) { const opt = document.createElement('option'); opt.value = name; opt.textContent = name; select.appendChild(opt); }
    if (currentVal && entries.find(e => e.name === currentVal)) select.value = currentVal;
    document.getElementById('last-updated').textContent = 'Last updated: ' + new Date().toLocaleTimeString();
    renderView();
  } catch (err) { contentEl.innerHTML = '<div class="no-selection">Error loading data: ' + err.message + '<br>Make sure the spreadsheet is accessible.</div>'; }
}

// ---- Rendering ----
function renderView() {
  const selectedName = document.getElementById('name-select').value;
  const contentEl = document.getElementById('content');
  if (!allData) { contentEl.innerHTML = '<div class="no-selection">Data not loaded yet.</div>'; return; }
  if (!selectedName) { contentEl.innerHTML = '<div class="no-selection">Select a name above to view scores and answers.</div>'; return; }
  const { entries, questionMap, questionColumns } = allData;
  const selected = entries.find(e => e.name === selectedName);
  if (!selected) return;
  const answeredCount = questionColumns.filter(q => questionMap[q] && questionMap[q].result).length;
  const totalQuestions = questionColumns.length;
  const sorted = [...entries].sort((a, b) => b.score - a.score || a.totalRemaining - b.totalRemaining);
  const ranks = computeRanks(sorted);
  const myRank = ranks.get(selectedName);
  const maxScore = Math.max(...entries.map(e => e.score), 1);
  let html = '';
  html += '<div class="score-summary">';
  html += '<div class="stat-card"><div class="stat-value gold">' + selected.score + '</div><div class="stat-label">Current Score</div></div>';
  html += '<div class="stat-card"><div class="stat-value">' + myRank + '</div><div class="stat-label">Rank</div></div>';
  html += '<div class="stat-card"><div class="stat-value green">' + selected.totalRemaining + '</div><div class="stat-label">Points Remaining</div></div>';
  html += '<div class="stat-card"><div class="stat-value ' + (selected.eliminated ? 'red' : 'green') + '">' + (selected.eliminated ? 'OUT' : 'ALIVE') + '</div><div class="stat-label">Status</div></div>';
  html += '<div class="stat-card"><div class="stat-value">' + answeredCount + '/' + totalQuestions + '</div><div class="stat-label">Questions Resolved</div></div>';
  html += '</div>';
  html += '<div class="chart-section"><h2>Leaderboard</h2><div class="bar-chart">';
  for (let i = 0; i < sorted.length; i++) {
    const entry = sorted[i];
    const isHighlighted = entry.name === selectedName;
    const isEliminated = entry.eliminated;
    const barClass = isHighlighted ? 'highlighted' : (isEliminated ? 'eliminated' : 'normal');
    const rowClass = isEliminated ? 'eliminated' : (isHighlighted ? 'highlighted' : '');
    const widthPercent = maxScore > 0 ? (entry.score / maxScore) * 100 : 0;
    const entryRank = ranks.get(entry.name);
    html += '<div class="bar-row ' + rowClass + '"><span class="rank-num">' + entryRank + '</span><span class="bar-name" title="' + entry.name + '">' + entry.name + '</span><div class="bar-track" title="' + entry.name + '"><div class="bar-fill ' + barClass + '" style="width: ' + Math.max(widthPercent, 2) + '%"><span class="bar-label">' + entry.name + '</span></div></div><span class="bar-score">' + entry.score + '</span></div>';
  }
  html += '</div></div>';
  const noOneHasPoints = entries.every(e => e.score === 0);
  html += '<div class="answers-section"><h2>' + selectedName + "\'s Picks</h2>";
  if (noOneHasPoints) html += '<div class="picks-hidden-wrapper">';
  html += '<table class="answers-table"><thead><tr><th class="col-category">Category</th><th>Question</th><th>Your Pick</th><th>Result</th></tr></thead><tbody>';
  const sortedQids = [...questionColumns].sort((a, b) => {
    const aResolved = questionMap[a] && questionMap[a].result ? 1 : 0;
    const bResolved = questionMap[b] && questionMap[b].result ? 1 : 0;
    return aResolved - bResolved;
  });
  for (const qid of sortedQids) {
    const qInfo = questionMap[qid] || {};
    const pick = selected.answers[qid] || '';
    const result = qInfo.result || '';
    const category = qInfo.category || '';
    const question = qInfo.prompt || qid;
    const catClass = getCategoryClass(category);
    const isResolved = !!result;
    let pickHtml = '';
    if (!result) { pickHtml = pick; }
    else {
      const pickSelection = pick.replace(/\s*\(\d+\s*Points?\)\s*$/, '').trim();
      const isCorrect = pickSelection && (result === pickSelection || result.includes(pickSelection) || pickSelection.includes(result));
      if (isCorrect) pickHtml = '<span class="result-correct"><span class="result-icon">&#10003;</span>' + pick + '</span>';
      else pickHtml = '<span class="result-incorrect"><span class="result-icon">&#10007;</span>' + pick + '</span>';
    }
    html += '<tr class="' + (isResolved ? 'resolved' : '') + '"><td class="col-category"><span class="category-badge ' + catClass + '">' + category + '</span></td><td>' + question + '</td><td>' + pickHtml + '</td><td>' + (result || '<span class="result-pending">--</span>') + '</td></tr>';
  }
  html += '</tbody></table>';
  if (noOneHasPoints) html += '<div class="picks-hidden-overlay"><span>To prevent cheating, picks will be hidden until Kickoff</span></div></div>';
  html += '</div>';
  contentEl.innerHTML = html;
}

// ---- Startup ----
document.getElementById('name-select').addEventListener('change', renderView);
loadData();
setInterval(loadData, CONFIG.refreshInterval * 1000);
