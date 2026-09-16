const http = require('http');
const fs = require('fs');
const path = require('path');
const { Telegraf } = require('telegraf');

const BOT_TOKEN = process.env.BOT_TOKEN;
const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY;
const PORT = process.env.PORT || 3000;
const NOTIFY_INTERVAL_MINUTES = Number(process.env.NOTIFY_INTERVAL_MINUTES || 240); // default every 4h
// Point this at a Railway Volume mount (e.g. /data) if you want subscriber
// lists to survive redeploys. Defaults to local disk, which is fine to start
// but resets on every new deploy.
const DATA_DIR = process.env.DATA_DIR || __dirname;
const STATE_FILE = path.join(DATA_DIR, 'state.json');

if (!BOT_TOKEN) {
  console.error('Missing BOT_TOKEN environment variable. Get one from @BotFather and set it in Railway → Variables.');
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

// ---------------------------------------------------------------------------
// Tiny JSON-file "database" for subscribers + last-seen news id.
// ---------------------------------------------------------------------------
function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch (e) {
    return { subscribers: [], lastNewsId: null };
  }
}
function saveState(state) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (e) {
    console.error('Could not persist state:', e.message);
  }
}
let state = loadState();

// ---------------------------------------------------------------------------
// Data sources
// ---------------------------------------------------------------------------
const RATE_PAIRS = [
  ['EUR', 'USD'],
  ['GBP', 'USD'],
  ['USD', 'JPY'],
  ['USD', 'CHF'],
  ['AUD', 'USD'],
  ['USD', 'CAD'],
  ['NZD', 'USD']
];

async function fetchRates() {
  // Group pairs by base currency so we only hit the (free, no-key) Frankfurter
  // API once per unique base.
  const byBase = {};
  RATE_PAIRS.forEach(([base, quote]) => {
    byBase[base] = byBase[base] || [];
    byBase[base].push(quote);
  });

  const entries = await Promise.all(
    Object.entries(byBase).map(async ([base, quotes]) => {
      const url = `https://api.frankfurter.app/latest?from=${base}&to=${quotes.join(',')}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Frankfurter responded ${res.status}`);
      const data = await res.json();
      return { base, rates: data.rates };
    })
  );

  const byBaseResult = {};
  entries.forEach((e) => (byBaseResult[e.base] = e.rates));

  return RATE_PAIRS.map(([base, quote]) => ({
    pair: `${base}/${quote}`,
    rate: byBaseResult[base] && byBaseResult[base][quote]
  }));
}

async function fetchForexNews(limit = 5) {
  if (!FINNHUB_API_KEY) {
    throw new Error('NO_API_KEY');
  }
  const url = `https://finnhub.io/api/v1/news?category=forex&token=${FINNHUB_API_KEY}`;
  const res = await fetch(url);
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) throw new Error('UNAUTHORIZED');
    throw new Error(`Finnhub responded ${res.status}`);
  }
  const data = await res.json();
  return (Array.isArray(data) ? data : []).slice(0, limit);
}

async function fetchEconomicCalendar() {
  if (!FINNHUB_API_KEY) {
    throw new Error('NO_API_KEY');
  }
  const url = `https://finnhub.io/api/v1/calendar/economic?token=${FINNHUB_API_KEY}`;
  const res = await fetch(url);
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) throw new Error('UNAUTHORIZED');
    throw new Error(`Finnhub responded ${res.status}`);
  }
  const data = await res.json();
  return Array.isArray(data.economicCalendar) ? data.economicCalendar : [];
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------
function fmtNewsItem(item) {
  const date = new Date(item.datetime * 1000);
  const timeStr = date.toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
  return `*${item.headline}*\n${item.source} · ${timeStr}\n${item.url}`;
}

function fmtRates(rates) {
  const lines = rates
    .filter((r) => typeof r.rate === 'number')
    .map((r) => `${r.pair.padEnd(8)} ${r.rate.toFixed(4)}`);
  return '📈 *Major Forex Rates*\n\n```\n' + lines.join('\n') + '\n```';
}

function fmtCalendar(events) {
  if (!events.length) return "No major economic events found for the current window.";
  const top = events.slice(0, 8);
  const lines = top.map((e) => {
    const impact = e.impact ? `[${e.impact}]` : '';
    return `• ${e.time || ''} *${e.event || 'Event'}* ${impact} — ${e.country || ''}`;
  });
  return '🌍 *Upcoming Economic Events*\n\n' + lines.join('\n');
}

const WELCOME_TEXT =
  '📊 *Forex News Bot*\n\n' +
  'Stay updated with the latest Forex market news, currency movements, economic ' +
  'events, and key market updates — all in one place.\n\n' +
  '⚡️ Fast Market Updates\n' +
  '📈 Forex News & Insights\n' +
  '🌍 Global Economic Events\n' +
  '🔔 Timely Notifications\n\n' +
  '*Commands*\n' +
  '/news — latest forex headlines\n' +
  '/rates — major currency pair snapshot\n' +
  '/calendar — upcoming economic events\n' +
  '/subscribe — get periodic news alerts here\n' +
  '/unsubscribe — stop alerts';

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------
bot.start((ctx) => ctx.replyWithMarkdown(WELCOME_TEXT));
bot.help((ctx) => ctx.replyWithMarkdown(WELCOME_TEXT));

bot.command('news', async (ctx) => {
  const statusMsg = await ctx.reply('Fetching latest forex news…');
  try {
    const items = await fetchForexNews(5);
    if (!items.length) throw new Error('EMPTY');
    const text = items.map(fmtNewsItem).join('\n\n');
    await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, undefined, text, {
      parse_mode: 'Markdown',
      disable_web_page_preview: true
    });
  } catch (err) {
    await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, undefined, newsErrorText(err));
  }
});

bot.command('rates', async (ctx) => {
  const statusMsg = await ctx.reply('Fetching latest rates…');
  try {
    const rates = await fetchRates();
    await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, undefined, fmtRates(rates), {
      parse_mode: 'Markdown'
    });
  } catch (err) {
    console.error('rates command failed:', err);
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      undefined,
      "⚠️ Couldn't reach the rates feed just now. Try again in a moment."
    );
  }
});

bot.command('calendar', async (ctx) => {
  const statusMsg = await ctx.reply('Checking the economic calendar…');
  try {
    const events = await fetchEconomicCalendar();
    await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, undefined, fmtCalendar(events), {
      parse_mode: 'Markdown'
    });
  } catch (err) {
    await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, undefined, calendarErrorText(err));
  }
});

bot.command('subscribe', async (ctx) => {
  const id = ctx.chat.id;
  if (!state.subscribers.includes(id)) {
    state.subscribers.push(id);
    saveState(state);
  }
  await ctx.reply(`🔔 Subscribed. I'll send fresh forex headlines here roughly every ${NOTIFY_INTERVAL_MINUTES} minutes.`);
});

bot.command('unsubscribe', async (ctx) => {
  const id = ctx.chat.id;
  state.subscribers = state.subscribers.filter((s) => s !== id);
  saveState(state);
  await ctx.reply('🔕 Unsubscribed — no more automatic alerts here.');
});

function newsErrorText(err) {
  if (err.message === 'NO_API_KEY') {
    return "⚠️ News isn't configured yet — missing FINNHUB_API_KEY on the server.";
  }
  if (err.message === 'UNAUTHORIZED') {
    return '⚠️ The configured Finnhub key was rejected for the news feed. Double-check the key and its plan.';
  }
  return "⚠️ Couldn't reach the news feed just now. Try again in a moment.";
}
function calendarErrorText(err) {
  if (err.message === 'NO_API_KEY') {
    return "⚠️ The economic calendar isn't configured yet — missing FINNHUB_API_KEY on the server.";
  }
  if (err.message === 'UNAUTHORIZED') {
    return (
      "⚠️ Finnhub's economic calendar endpoint isn't available on the current API plan.\n" +
      'You can check one for free at https://www.forexfactory.com/calendar in the meantime.'
    );
  }
  return "⚠️ Couldn't reach the economic calendar just now. Try again in a moment.";
}

bot.catch((err, ctx) => {
  console.error(`Unhandled error for ${ctx.updateType}:`, err);
});

// ---------------------------------------------------------------------------
// Periodic notifications: check for fresh news, push to subscribers.
// ---------------------------------------------------------------------------
async function checkAndNotify() {
  if (!FINNHUB_API_KEY || state.subscribers.length === 0) return;
  try {
    const items = await fetchForexNews(5);
    if (!items.length) return;

    const freshItems = state.lastNewsId
      ? items.filter((i) => i.id > state.lastNewsId)
      : [items[0]]; // first run: seed with just the newest, don't spam history

    if (freshItems.length === 0) return;

    state.lastNewsId = Math.max(...items.map((i) => i.id));
    saveState(state);

    const text = '🔔 *Fresh Forex Headlines*\n\n' + freshItems.map(fmtNewsItem).join('\n\n');

    for (const chatId of state.subscribers) {
      try {
        await bot.telegram.sendMessage(chatId, text, { parse_mode: 'Markdown', disable_web_page_preview: true });
      } catch (err) {
        console.error(`Failed to notify ${chatId}, removing subscriber:`, err.message);
        state.subscribers = state.subscribers.filter((s) => s !== chatId);
        saveState(state);
      }
    }
  } catch (err) {
    console.error('checkAndNotify failed:', err.message);
  }
}

setInterval(checkAndNotify, NOTIFY_INTERVAL_MINUTES * 60 * 1000);

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
bot.launch().then(() => {
  console.log('Forex News Bot is up and polling for updates.');
});

http
  .createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Forex News Bot is running.');
  })
  .listen(PORT, () => console.log(`Health check server listening on port ${PORT}`));

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
