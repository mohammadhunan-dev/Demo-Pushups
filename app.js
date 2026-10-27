// The publishable key is meant to be public; row-level security in the database protects the data.
const SUPABASE_URL = 'https://uazlqmawtlzhatcktpcx.supabase.co';
const SUPABASE_KEY = 'sb_publishable_up4QXFYLTv-yf3YAofrD6g_UegJriFT';
const TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

// Rapid taps are batched into one row, sent after this much idle time.
const BATCH_DELAY_MS = 1500;
const RETRY_DELAY_MS = 5000;
const MAX_ENTRY = 1000;

const db = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
const $ = (id) => document.getElementById(id);
const fmt = (n) => Number(n).toLocaleString();

let currentUser = null;
let stats = null;
let lastLoggedAt = null;
let pending = 0;   // taps not yet sent to the database
let inFlight = 0;  // amount currently being saved
let flushTimer = null;
let statusTimer = null;

const chart = { period: 'W', offset: 0, rows: null, selected: null };

// ---- DOM helpers ----

function h(tag, className, ...children) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  node.append(...children);
  return node;
}

function svg(tag, attrs = {}) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  return node;
}

function icon(name, className = 'icon') {
  const node = svg('svg', { class: className, 'aria-hidden': 'true' });
  node.append(svg('use', { href: '#i-' + name }));
  return node;
}

// ---- Routing ----

let currentView = null;

function route() {
  const view = !currentUser ? 'signin' : location.hash === '#/pushups' ? 'detail' : 'summary';
  if (view === currentView) return;
  const previous = currentView;
  currentView = view;

  for (const name of ['signin', 'summary', 'detail']) $('view-' + name).hidden = name !== view;
  $('chrome').hidden = view === 'signin';

  // Push slides in from the right; going back slides the other way.
  const screen = $('view-' + view);
  screen.classList.remove('entering', 'entering-back');
  if (previous && previous !== 'signin' && view !== 'signin') {
    void screen.offsetWidth;
    screen.classList.add(view === 'detail' ? 'entering' : 'entering-back');
  }
  window.scrollTo(0, 0);
  if (view === 'detail') loadHistory();
}

window.addEventListener('hashchange', route);

// ---- Auth ----

const MIN_PASSWORD_LENGTH = 8;
const REDIRECT_URL = window.location.origin + window.location.pathname;
// 'link' (default: email a sign-in link), 'password', or 'signup'.
let authMode = 'link';

function setAuthMode(mode) {
  authMode = mode;
  const signup = mode === 'signup';
  $('signin-subhead').textContent = signup
    ? 'Create an account with your email and a password.'
    : 'Track every set and see how today compares.';
  $('signin-submit').textContent = { link: 'Email Me a Sign-In Link', password: 'Sign In', signup: 'Create Account' }[mode];
  $('password').hidden = mode === 'link';
  $('password').autocomplete = signup ? 'new-password' : 'current-password';
  $('password-hint').hidden = !signup;
  $('method-toggle').hidden = signup;
  $('method-toggle').textContent = mode === 'link' ? 'Sign In With Password' : 'Email Me a Link Instead';
  $('signup-toggle').replaceChildren(
    signup ? 'Already have an account? ' : "Don't have an account? ",
    h('span', 'action', signup ? 'Sign In' : 'Sign Up'),
  );
  $('signin-error').textContent = '';
}

setAuthMode('link');

function authErrorMessage(error) {
  switch (error.code) {
    case 'invalid_credentials': return 'Incorrect email or password.';
    case 'email_not_confirmed': return 'Confirm your email using the link in your inbox, then sign in.';
    case 'user_already_exists': return 'An account with this email already exists. Sign in instead.';
    case 'over_email_send_rate_limit': return 'Too many emails sent recently. Try again later, or sign in with a password.';
    default: return error.status === 429 ? 'Too many attempts. Wait a minute and try again.' : error.message;
  }
}

function validEmail() {
  const email = $('email').value.trim();
  if (/^\S+@\S+\.\S+$/.test(email)) return email;
  $('signin-error').textContent = 'Enter an email address, like name@example.com.';
  $('email').focus();
  return null;
}

async function withBusy(button, busyLabel, task) {
  const label = button.textContent;
  button.disabled = true;
  button.textContent = busyLabel;
  try {
    return await task();
  } finally {
    button.disabled = false;
    button.textContent = label;
  }
}

function showEmailSent(email, purpose) {
  const message = $('sent-message');
  message.replaceChildren(
    'Tap the link sent to ', h('strong', '', email),
    purpose === 'confirm' ? ' to confirm your account, then sign in.' : ' to sign in.',
  );
  $('signin-form-state').hidden = true;
  $('signin-sent-state').hidden = false;
}

$('signin-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const error = $('signin-error');
  error.textContent = '';
  const email = validEmail();
  if (!email) return;

  if (authMode === 'link') {
    const { error: sendError } = await withBusy($('signin-submit'), 'Sending…',
      () => db.auth.signInWithOtp({ email, options: { emailRedirectTo: REDIRECT_URL } }));
    if (sendError) error.textContent = authErrorMessage(sendError);
    else showEmailSent(email, 'link');
    return;
  }

  const password = $('password').value;
  if (!password) {
    error.textContent = 'Enter your password.';
    $('password').focus();
    return;
  }
  if (authMode === 'signup' && password.length < MIN_PASSWORD_LENGTH) {
    error.textContent = `Choose a password with at least ${MIN_PASSWORD_LENGTH} characters.`;
    $('password').focus();
    return;
  }

  if (authMode === 'password') {
    const { error: signInError } = await withBusy($('signin-submit'), 'Signing In…',
      () => db.auth.signInWithPassword({ email, password }));
    if (signInError) error.textContent = authErrorMessage(signInError);
    else $('password').value = '';
    return;
  }

  const { data, error: signUpError } = await withBusy($('signin-submit'), 'Creating Account…',
    () => db.auth.signUp({ email, password, options: { emailRedirectTo: REDIRECT_URL } }));
  if (signUpError) {
    error.textContent = authErrorMessage(signUpError);
    return;
  }
  $('password').value = '';
  if (data.session) return;  // email confirmation is off; already signed in
  // With confirmation on, Supabase hides whether an address is taken by returning a user with no identities.
  if (data.user && data.user.identities?.length === 0) {
    setAuthMode('password');
    error.textContent = authErrorMessage({ code: 'user_already_exists' });
    return;
  }
  showEmailSent(email, 'confirm');
});

$('method-toggle').addEventListener('click', () => {
  setAuthMode(authMode === 'link' ? 'password' : 'link');
  (authMode === 'password' && $('email').value ? $('password') : $('email')).focus();
});

$('signup-toggle').addEventListener('click', () => {
  setAuthMode(authMode === 'signup' ? 'link' : 'signup');
  $('email').focus();
});

$('signin-reset').addEventListener('click', () => {
  $('signin-sent-state').hidden = true;
  $('signin-form-state').hidden = false;
  setAuthMode('link');
  $('email').focus();
});

$('sign-out').addEventListener('click', async () => {
  closeSheet(true);
  await flush();
  await db.auth.signOut();
  history.replaceState(null, '', window.location.pathname);
});

db.auth.onAuthStateChange((_event, session) => {
  const user = session?.user ?? null;
  const changed = user?.id !== currentUser?.id;
  currentUser = user;

  if (user) {
    $('avatar').textContent = (user.email ?? '?').charAt(0).toUpperCase();
    $('account-email').textContent = user.email ?? '';
  } else {
    stats = null;
    lastLoggedAt = null;
    closeSheet(true);
  }

  // Defer: calling Supabase inside this callback can deadlock the auth client.
  setTimeout(() => {
    route();
    if (user && changed) loadStats();
  }, 0);
});

// ---- Summary ----

async function loadStats() {
  const [statsResult, lastResult] = await Promise.all([
    db.rpc('get_stats', { tz: TIME_ZONE }),
    db.from('pushup_entries').select('created_at').order('created_at', { ascending: false }).limit(1),
  ]);
  if (statsResult.error) {
    setStatus('Unable to load totals. Check your connection.', 'error');
    return;
  }
  stats = statsResult.data;
  const latest = lastResult.data?.[0]?.created_at;
  lastLoggedAt = latest ? new Date(latest) : null;
  render();
}

// Unsaved taps are shown immediately on top of the last loaded totals.
function render() {
  if (!stats) return;
  const unsaved = pending + inFlight;
  const today = stats.today + unsaved;

  $('today-count').textContent = fmt(today);
  $('decrement').disabled = today <= 0;
  $('last-logged').textContent = unsaved !== 0 ? 'Now' : lastLoggedLabel();

  $('highlights').replaceChildren(
    highlightCard({
      current: today, previous: stats.yesterday_to_date,
      nowLabel: 'Today', thenLabel: 'Yesterday',
      period: 'today', comparedTo: 'by this time yesterday',
      footnote: `30-day average: ${fmt(stats.daily_avg_30d)} a day`,
    }),
    highlightCard({
      current: stats.week + unsaved, previous: stats.last_week_to_date,
      nowLabel: 'This Week', thenLabel: 'Last Week',
      period: 'this week', comparedTo: 'at this point last week',
      footnote: `Last week: ${fmt(stats.last_week_total)} total`,
    }),
    highlightCard({
      current: stats.month + unsaved, previous: stats.last_month_to_date,
      nowLabel: 'This Month', thenLabel: 'Last Month',
      period: 'this month', comparedTo: 'at this point last month',
      footnote: `Last month: ${fmt(stats.last_month_total)} total`,
    }),
  );
}

function lastLoggedLabel() {
  if (!lastLoggedAt) return '';
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  if (lastLoggedAt >= startOfToday) {
    return lastLoggedAt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }
  if (lastLoggedAt >= new Date(startOfToday.getTime() - 864e5)) return 'Yesterday';
  return lastLoggedAt.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function highlightSentence({ current, previous, period, comparedTo }) {
  if (current === 0 && previous === 0) return `No pushups logged ${period} yet.`;
  if (current > previous) return `You've done more pushups ${period} than ${comparedTo}.`;
  if (current < previous) return `You've done fewer pushups ${period} than ${comparedTo}.`;
  return `You've done the same number of pushups ${period} as ${comparedTo}.`;
}

function deltaText(current, previous) {
  const diff = current - previous;
  if (diff === 0) return { text: 'No change', kind: '' };
  const pct = previous > 0 ? `${Math.round((Math.abs(diff) / previous) * 100)}%` : 'new';
  return diff > 0
    ? { text: `▲ +${fmt(diff)} (${pct})`, kind: 'up' }
    : { text: `▼ −${fmt(-diff)} (${pct})`, kind: 'down' };
}

function compareRow(value, label, max, className) {
  const fill = h('div', 'fill');
  fill.style.width = max > 0 ? `${(Math.max(value, 0) / max) * 100}%` : '0';
  return h('div', 'compare-row ' + className,
    h('div', 'compare-value', h('span', 'rounded-num', fmt(value)), h('span', 'unit', 'reps')),
    h('div', 'compare-bar', h('div', 'track', fill), h('span', 'label', label)),
  );
}

function highlightCard(item) {
  const max = Math.max(item.current, item.previous, 0);
  const delta = deltaText(item.current, item.previous);
  return h('div', 'card',
    h('div', 'card-head', icon('flame'), h('span', '', 'Pushups'), h('span', 'meta', item.nowLabel)),
    h('p', 'highlight-text', highlightSentence(item)),
    compareRow(item.current, item.nowLabel, max, 'current'),
    compareRow(item.previous, item.thenLabel, max, 'previous'),
    h('div', 'highlight-foot', h('span', 'delta ' + delta.kind, delta.text), ` · ${item.footnote}`),
  );
}

// ---- Logging ----

function setStatus(text, kind = '') {
  clearTimeout(statusTimer);
  const status = $('save-status');
  status.textContent = text;
  status.className = 'save-status glass' + (kind === 'error' ? ' error' : '');
  if (kind === 'done') statusTimer = setTimeout(() => status.classList.add('fade'), 1500);
}

function add(amount) {
  if (!stats) return;
  // Never let today's total go below zero.
  const today = stats.today + pending + inFlight;
  amount = Math.max(amount, -today);
  if (amount === 0) return;

  pending += amount;
  render();
  setStatus('Saving…');
  clearTimeout(flushTimer);
  flushTimer = setTimeout(flush, Math.abs(pending) >= MAX_ENTRY ? 0 : BATCH_DELAY_MS);
}

async function flush() {
  clearTimeout(flushTimer);
  if (pending === 0 || inFlight !== 0) return;

  const amount = Math.max(-MAX_ENTRY, Math.min(MAX_ENTRY, pending));
  pending -= amount;
  inFlight = amount;

  const { error } = await db.from('pushup_entries').insert({ count: amount });
  inFlight = 0;

  if (error) {
    // Put it back and try again later, so taps aren't lost on a flaky connection.
    pending += amount;
    setStatus('Not saved yet — retrying…', 'error');
    flushTimer = setTimeout(flush, RETRY_DELAY_MS);
    return;
  }

  if (pending !== 0) {
    flushTimer = setTimeout(flush, BATCH_DELAY_MS);
    return;
  }
  setStatus('Saved', 'done');
  await loadStats();
  if (currentView === 'detail') loadHistory();
}

$('increment').addEventListener('click', () => add(1));
$('decrement').addEventListener('click', () => add(-1));

// ---- Sheets ----

let openSheetEl = null;
let focusBeforeSheet = null;

function openSheet(id) {
  closeSheet(true);
  openSheetEl = $(id);
  focusBeforeSheet = document.activeElement;
  openSheetEl.hidden = false;

  if (id === 'sheet-add') {
    $('add-amount').value = '';
    $('add-error').textContent = 'Logged at the current time.';
    $('add-error').className = 'row-note';
    $('add-amount').focus();
  } else {
    openSheetEl.querySelector('[data-close-sheet].trailing')?.focus();
  }
}

function closeSheet(immediate = false) {
  if (!openSheetEl) return;
  const sheet = openSheetEl;
  openSheetEl = null;
  focusBeforeSheet?.focus?.();

  if (immediate) {
    sheet.hidden = true;
    return;
  }
  // Slide back down the way it came.
  const parts = sheet.querySelectorAll('.sheet, .scrim');
  parts.forEach((part) => part.classList.add('closing'));
  setTimeout(() => {
    sheet.hidden = true;
    parts.forEach((part) => part.classList.remove('closing'));
  }, 250);
}

document.addEventListener('click', (event) => {
  if (event.target.closest('[data-open-add]')) openSheet('sheet-add');
  else if (event.target.closest('[data-close-sheet]')) closeSheet();
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeSheet();
});

$('avatar').addEventListener('click', () => openSheet('sheet-account'));

$('add-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const amount = Number($('add-amount').value);
  if (!Number.isInteger(amount) || amount < 1 || amount > MAX_ENTRY) {
    $('add-error').textContent = `Enter a whole number from 1 to ${fmt(MAX_ENTRY)}.`;
    $('add-error').className = 'row-note error';
    $('add-amount').focus();
    return;
  }
  closeSheet();
  add(amount);
  flush();
});

// ---- Chart ----

const periodButtons = document.querySelectorAll('[data-period]');
let historyRequest = 0;

periodButtons.forEach((button) => button.addEventListener('click', () => {
  chart.period = button.dataset.period;
  chart.offset = 0;
  loadHistory();
}));

$('page-prev').addEventListener('click', () => {
  chart.offset += 1;
  loadHistory();
});

$('page-next').addEventListener('click', () => {
  if (chart.offset === 0) return;
  chart.offset -= 1;
  loadHistory();
});

async function loadHistory() {
  const request = ++historyRequest;
  periodButtons.forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.period === chart.period)));
  $('page-next').disabled = chart.offset === 0;

  const { data, error } = await db.rpc('get_history', { tz: TIME_ZONE, period: chart.period, page_offset: chart.offset });
  if (request !== historyRequest) return;  // a newer request superseded this one
  if (error) {
    setStatus('Unable to load history. Check your connection.', 'error');
    return;
  }
  chart.rows = data.map((row) => ({ date: parseLocal(row.bucket), total: Number(row.total) }));
  chart.selected = null;
  renderChart();
}

// Buckets are wall-clock times in the user's time zone, e.g. "2026-10-25T13:00:00".
function parseLocal(value) {
  const [date, time = '00'] = value.split('T');
  const [year, month, day] = date.split('-').map(Number);
  return new Date(year, month - 1, day, Number(time.slice(0, 2)));
}

function periodEnd(start) {
  const end = new Date(start);
  if (chart.period === 'D') end.setDate(end.getDate() + 1);
  if (chart.period === 'W') end.setDate(end.getDate() + 7);
  if (chart.period === 'M') end.setMonth(end.getMonth() + 1);
  if (chart.period === 'Y') end.setFullYear(end.getFullYear() + 1);
  return end;
}

// Averages only count days that have happened, so a partial week isn't diluted by future days.
function daysCounted(start) {
  let end = periodEnd(start);
  if (chart.offset === 0) {
    end = new Date();
    end.setHours(0, 0, 0, 0);
    end.setDate(end.getDate() + 1);
  }
  return Math.max(1, Math.round((end - start) / 864e5));
}

function rangeLabel(start) {
  const { period, offset } = chart;
  if (period === 'D') {
    if (offset === 0) return 'Today';
    if (offset === 1) return 'Yesterday';
    return start.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
  }
  if (period === 'W') {
    const last = new Date(start);
    last.setDate(last.getDate() + 6);
    return new Intl.DateTimeFormat([], { month: 'short', day: 'numeric', year: 'numeric' }).formatRange(start, last);
  }
  if (period === 'M') return start.toLocaleDateString([], { month: 'long', year: 'numeric' });
  return String(start.getFullYear());
}

function bucketLabel(date) {
  if (chart.period === 'D') {
    const next = new Date(date);
    next.setHours(next.getHours() + 1);
    return new Intl.DateTimeFormat([], { hour: 'numeric' }).formatRange(date, next);
  }
  if (chart.period === 'Y') return date.toLocaleDateString([], { month: 'long', year: 'numeric' });
  return date.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}

function tickLabel(date, index) {
  switch (chart.period) {
    case 'D': return index % 6 === 0 ? date.toLocaleTimeString([], { hour: 'numeric' }) : null;
    case 'W': return date.toLocaleDateString([], { weekday: 'narrow' });
    case 'M': return (index % 7 === 0) ? String(date.getDate()) : null;
    default: return date.toLocaleDateString([], { month: 'narrow' });
  }
}

function niceMax(value) {
  if (value <= 0) return 10;
  const power = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 2, 5, 10]) if (step * power >= value) return step * power;
  return 10 * power;
}

function renderChartHeader() {
  const { rows, selected } = chart;
  let caption, value, range;
  if (selected !== null) {
    caption = 'Total';
    value = rows[selected].total;
    range = bucketLabel(rows[selected].date);
  } else {
    const sum = rows.reduce((total, row) => total + row.total, 0);
    if (chart.period === 'D') {
      caption = 'Total';
      value = sum;
    } else {
      caption = 'Daily Average';
      value = Math.round(sum / daysCounted(rows[0].date));
    }
    range = rangeLabel(rows[0].date);
  }
  $('chart-caption').textContent = caption;
  $('chart-value').textContent = fmt(value);
  $('chart-range').textContent = range;
  $('chart').setAttribute('aria-label', `${caption}: ${fmt(value)} reps, ${range}`);
}

function renderChart() {
  const { rows } = chart;
  if (!rows || !rows.length) return;
  renderChartHeader();

  const box = $('chart');
  const width = box.clientWidth || 340;
  const height = box.clientHeight || 220;
  const axisWidth = 36;
  const labelHeight = 20;
  const plotWidth = width - axisWidth;
  const plotHeight = height - labelHeight;
  const max = niceMax(Math.max(...rows.map((row) => row.total)));
  const slot = plotWidth / rows.length;
  const barWidth = Math.max(2, Math.min(slot * 0.6, 28));
  const y = (value) => plotHeight - (Math.max(value, 0) / max) * plotHeight;

  const root = svg('svg', { viewBox: `0 0 ${width} ${height}`, 'aria-hidden': 'true' });

  for (const value of [0, max / 2, max]) {
    if (!Number.isInteger(value)) continue;
    root.append(svg('line', { class: 'grid', x1: 0, x2: plotWidth, y1: y(value), y2: y(value) }));
    const label = svg('text', { class: 'axis', x: plotWidth + 6, y: y(value) + 4 });
    label.textContent = fmt(value);
    root.append(label);
  }

  rows.forEach((row, index) => {
    const x = index * slot + (slot - barWidth) / 2;
    if (row.total > 0) {
      // Rounded top corners only, like Health's bars.
      const top = y(row.total);
      const r = Math.min(barWidth / 2, 4, plotHeight - top);
      const d = `M${x},${plotHeight} V${top + r} Q${x},${top} ${x + r},${top} H${x + barWidth - r} Q${x + barWidth},${top} ${x + barWidth},${top + r} V${plotHeight} Z`;
      const dim = chart.selected !== null && chart.selected !== index;
      root.append(svg('path', { class: 'bar' + (dim ? ' dim' : ''), d }));
    }

    const tick = tickLabel(row.date, index);
    if (tick) {
      const label = svg('text', { class: 'axis', x: index * slot + slot / 2, y: height - 4, 'text-anchor': 'middle' });
      label.textContent = tick;
      root.append(label);
    }

    const hit = svg('rect', { class: 'hit', x: index * slot, y: 0, width: slot, height: plotHeight });
    hit.addEventListener('click', () => {
      chart.selected = chart.selected === index ? null : index;
      renderChart();
    });
    root.append(hit);
  });

  box.replaceChildren(root);
}

window.addEventListener('resize', () => {
  if (currentView === 'detail') renderChart();
});

// Save before the tab is hidden; refresh totals when it comes back (e.g. the next day).
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    flush();
  } else if (currentUser && pending === 0 && inFlight === 0) {
    loadStats();
    if (currentView === 'detail') loadHistory();
  }
});
