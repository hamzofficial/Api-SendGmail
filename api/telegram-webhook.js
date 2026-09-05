import { Telegraf } from 'telegraf';
import { Gmail } from '../models/Gmail.js';
import { BandingSession } from '../models/BandingSession.js';
import { ApiKey } from '../models/ApiKey.js';
import connectDB from '../utils/connectDB.js';
import { calculateExpiry } from '../utils/calculateExpiry.js';
import { TUJUAN_EMAILS } from '../utils/emailTargets.js';
import { normalizeTargetUrl } from '../utils/targetInjector.js';
import { Target } from '../models/Target.js';
import { TelegramLog } from '../models/TelegramLog.js';
import nodemailer from 'nodemailer';
import { createLogger, maskEmail } from '../utils/logger.js';
const log = createLogger('telegram-webhook');

const BASE_URL = process.env.BASE_URL;
const ADMIN_CHAT_IDS = (process.env.ADMIN_CHAT_ID || '').split(',').map(id => id.trim()).filter(Boolean);

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function isAdmin(chatId) {
  const ok = ADMIN_CHAT_IDS.includes(String(chatId));
  log.info(`isAdmin check chatId=${chatId} -> ${ok ? 'YA' : 'TIDAK'} adminIds=${ADMIN_CHAT_IDS.length} set`);
  return ok;
}

// Cooldown untuk command dailyreport (60 detik)
const dailyReportCooldown = new Map();

export default async function handler(req, res) {
  res.json = (data) => {
    res.setHeader('Content-Type', 'application/json');
    return res.send(JSON.stringify(data, null, 2));
  };
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({
      status: 'error',
      error: 'Method Not Allowed',
      message: 'Webhook Telegram hanya menerima POST request.',
      usage: 'Endpoint ini digunakan oleh Telegram untuk mengirim update. Jangan dipanggil manual. Untuk menguji bot, gunakan perintah di aplikasi Telegram.',
      author: 'Ipanzxdev'
    });
  }

  const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  if (!BOT_TOKEN) {
    log.error('FATAL: TELEGRAM_BOT_TOKEN missing');
    return res.status(500).json({ error: 'Missing bot token', hint: 'Set TELEGRAM_BOT_TOKEN di env' });
  }

  const incomingChatId = req.body?.message?.chat?.id || req.body?.callback_query?.message?.chat?.id || '-';
  const incomingText = req.body?.message?.text || req.body?.callback_query?.data || req.body?.message?.photo ? '[photo]' : '-';
  const fromId = req.body?.message?.from?.id || req.body?.callback_query?.from?.id || '-';
  log.info(`Incoming update chatId=${incomingChatId} from=${fromId} text="${String(incomingText).slice(0,80)}" type=${req.body?.message ? 'message' : req.body?.callback_query ? 'callback' : 'unknown'}`);
  if (!ADMIN_CHAT_IDS.length) log.warn('ADMIN_CHAT_ID kosong — semua command admin akan ditolak');
  if (!BASE_URL) log.warn('BASE_URL kosong — fetch fallback tidak akan jalan');

  const t0 = Date.now();
  try {
    const bot = new Telegraf(BOT_TOKEN, { handlerTimeout: 25_000 });
    bot.catch((err, ctx) => log.error(`bot.catch error for ${ctx?.updateType}: ${err.message}`, { stack: err.stack?.slice(0,800) }));

    // Fungsi kirim pesan dengan retry jika rate limit
    const sendMessageWithRetry = async (chatId, text, retries = 3) => {
      for (let i = 0; i < retries; i++) {
        try {
          await bot.telegram.sendMessage(chatId, text);
          return;
        } catch (err) {
          if (err.response && err.response.statusCode === 429) {
            const retryAfter = err.response.body?.parameters?.retry_after || 5;
            log.warn(`sendMessage rate limit retryAfter=${retryAfter}s attempt=${i+1}/${retries} chatId=${chatId}`);
            await sleep(retryAfter * 1000);
          } else {
            throw err;
          }
        }
      }
      throw new Error('Gagal mengirim pesan setelah beberapa percobaan.');
    };

    // debug: cek status admin kamu
    bot.command('cekadmin', (ctx) => {
      const cid = String(ctx.chat.id);
      log.info(`Command /cekadmin from ${cid} isAdmin=${isAdmin(cid)}`);
      return ctx.reply(`chatId kamu: ${cid}\nADMIN_CHAT_ID env: ${process.env.ADMIN_CHAT_ID || '(kosong)'}\nisAdmin: ${isAdmin(cid) ? 'YA ✅' : 'TIDAK ❌'}\nDATABASE_URL: ${process.env.DATABASE_URL ? 'set' : 'MISSING'}\nBASE_URL: ${BASE_URL || '(kosong)'}`);
    });

    bot.start((ctx) => { log.info(`Command /start from ${ctx.chat.id}`); return ctx.reply('Selamat datang! Gunakan /help untuk melihat daftar perintah.'); });
    bot.help((ctx) => { log.info(`Command /help from ${ctx.chat.id}`); return ctx.reply(
      '/banding - Laporkan akun fake (Emergency)\n' +
      '/batal - Batalkan pelaporan\n\n' +
      'Admin commands:\n' +
      '/addkey <key> <email> <duration> <limit>\n' +
      '  duration: 1h, 7h, 1month, permanent\n' +
      '  limit: 1..2147483647 atau permanent/unlimited (default 100)\n' +
      '  contoh: /addkey abc123 user@mail.com 1month 50\n' +
      '  contoh: /addkey abc123 user@mail.com permanent unlimited\n' +
      '/delkey <key>\n' +
      '/listkey\n' +
      '/addgmail <email> <app_password>\n' +
      '/delgmail <email>\n' +
      '/listgmail\n' +
      '/addtarget <https://t.me/username>\n' +
      '/deltarget <username>\n' +
      '/listtarget\n' +
      '/dailyreport - Kirim laporan harian penggunaan Gmail (alias /rekap)'
    ); });

    // ========== ADMIN COMMANDS ==========
    // ponytail: langsung pakai DB (tanpa fetch BASE_URL) agar tidak timeout / tidak respon saat BASE_URL kosong
    bot.command('addkey', async (ctx) => {
      log.info(`Command /addkey from ${ctx.chat.id} text="${ctx.message.text.slice(0,100)}"`);
      if (!isAdmin(ctx.chat.id)) { log.warn(`addkey rejected not admin chatId=${ctx.chat.id}`); return ctx.reply('❌ Anda bukan admin.'); }
      const args = ctx.message.text.split(' ').slice(1);
      if (args.length < 3) return ctx.reply('Format: /addkey <key> <email> <duration> [limit]\nDurasi: 1h,7h,1month,permanent\nLimit: 1..unlimited atau permanent/unlimited (default 100)\nContoh: /addkey abc123 user@mail.com 1month 50\nContoh: /addkey abc123 user@mail.com permanent 5000');
      const [key, email, duration, limitRaw] = args;
      const limit = limitRaw ?? '100';
      const tierStr = String(limit).toLowerCase();
      let parsedLimit;
      if (tierStr === 'permanent' || tierStr === 'unlimited') {
        parsedLimit = null;
      } else {
        const n = parseInt(limit, 10);
        if (isNaN(n) || n < 1) return ctx.reply('❌ Limit tidak valid. Gunakan 1..2147483647 atau permanent/unlimited');
        if (n > 2147483647) return ctx.reply('❌ Limit terlalu besar (max 2147483647)');
        parsedLimit = n;
      }
      const validDurations = ['1h','7h','1month','permanent'];
      if (!validDurations.includes(duration)) return ctx.reply('❌ Durasi tidak valid. Gunakan: 1h, 7h, 1month, permanent');
      try {
        await connectDB();
        const exists = await ApiKey.findOneByKey(key);
        if (exists) { log.warn(`addkey fail Key exists key=${key}`); return ctx.reply('❌ Gagal: Key exists'); }
        const expiresAt = calculateExpiry(duration);
        await ApiKey.create({ key, email, duration, expiresAt, isActive: true, usageLimit: parsedLimit });
        const displayLimit = parsedLimit === null ? 'permanent' : String(parsedLimit);
        log.info(`addkey success key=${key} email=${email} duration=${duration} limit=${displayLimit}`);
        return ctx.reply(`✅ API Key ${key} berhasil ditambahkan.\n📊 Limit: ${displayLimit}/hari (reset 00:00 WIB)\n⏱️ Throttle: 5 detik/hit`);
      } catch (err) {
        log.error(`addkey error: ${err.message}`, { stack: err.stack?.slice(0,800) });
        // fallback ke fetch BASE_URL kalau DB langsung gagal (misal column belum migrasi)
        if (BASE_URL) {
          try {
            const response = await fetch(`${BASE_URL}/api/admin?action=create`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'x-admin-key': process.env.ADMIN_API_KEY },
              body: JSON.stringify({ key, email, duration, limit })
            });
            const data = await response.json();
            if (response.ok) return ctx.reply(`✅ API Key ${key} berhasil ditambahkan.\n📊 Limit: ${limit}/hari (reset 00:00 WIB)\n⏱️ Throttle: 5 detik/hit`);
            else return ctx.reply(`❌ Gagal: ${data.error || err.message}`);
          } catch {}
        }
        return ctx.reply(`❌ Gagal: ${err.message}`);
      }
    });

    bot.command('delkey', async (ctx) => {
      log.info(`Command /delkey from ${ctx.chat.id} text="${ctx.message.text.slice(0,80)}"`);
      if (!isAdmin(ctx.chat.id)) { log.warn(`delkey rejected not admin chatId=${ctx.chat.id}`); return ctx.reply('❌ Anda bukan admin.'); }
      const args = ctx.message.text.split(' ').slice(1);
      if (args.length < 1) return ctx.reply('Format: /delkey <key>');
      const key = args[0];
      try {
        await connectDB();
        const result = await ApiKey.delete(key);
        if (result.deletedCount > 0) { log.info(`delkey success key=${key}`); return ctx.reply(`✅ API Key ${key} dihapus.`); }
        else { log.warn(`delkey not found key=${key}`); return ctx.reply('❌ Key not found'); }
      } catch (err) {
        log.error(`delkey error: ${err.message}`);
        if (BASE_URL) {
          try {
            const response = await fetch(`${BASE_URL}/api/admin?action=delete`, {
              method: 'DELETE',
              headers: { 'Content-Type': 'application/json', 'x-admin-key': process.env.ADMIN_API_KEY },
              body: JSON.stringify({ key })
            });
            const data = await response.json();
            if (response.ok) return ctx.reply(`✅ API Key ${key} dihapus.`);
            else return ctx.reply(`❌ Gagal: ${data.error || err.message}`);
          } catch {}
        }
        return ctx.reply(`❌ Gagal: ${err.message}`);
      }
    });

    bot.command('listkey', async (ctx) => {
      log.info(`Command /listkey from ${ctx.chat.id}`);
      if (!isAdmin(ctx.chat.id)) { log.warn(`listkey rejected not admin chatId=${ctx.chat.id}`); return ctx.reply('❌ Anda bukan admin.'); }
      try {
        await connectDB();
        const keys = await ApiKey.list(true);
        // juga ambil inactive untuk total? cukup active dulu, tapi tampilkan semua jika diminta
        // ponytail: ambil semua lalu filter, biar listkey tetap muncul walau ada inactive
        const allKeys = keys.length ? keys : await ApiKey.list(null);
        if (allKeys.length === 0) { log.info('listkey empty'); return ctx.reply('Tidak ada API Key.'); }
        log.info(`listkey found ${allKeys.length} keys`);
        let msg = '*Daftar API Key:*\n';
        for (const k of allKeys.slice(0, 20)) {
          const lim = k.usageLimit === null || k.usageLimit === undefined ? '∞' : k.usageLimit;
          const used = k.usageCount ?? 0;
          const rem = k.usageLimit === null ? '∞' : Math.max(0, k.usageLimit - used);
          msg += `\`${k.key}\` - ${k.duration} - lim:${lim} used:${used} sisa:${rem} - ${k.isActive ? '✅ aktif' : '❌ nonaktif'}\n`;
        }
        if (allKeys.length > 20) msg += `\n... dan ${allKeys.length - 20} lainnya.`;
        msg += '\n_Reset harian 00:00 WIB | Throttle 5s/hit_';
        return ctx.reply(msg, { parse_mode: 'Markdown' });
      } catch (err) {
        log.error(`listkey error: ${err.message}`);
        if (BASE_URL) {
          try {
            const response = await fetch(`${BASE_URL}/api/admin?action=list`, { headers: { 'x-admin-key': process.env.ADMIN_API_KEY } });
            const data = await response.json();
            if (data.success) {
              if (data.keys.length === 0) return ctx.reply('Tidak ada API Key.');
              let msg = '*Daftar API Key:*\n';
              for (const k of data.keys.slice(0, 20)) {
                const lim = k.usageLimit === null || k.usageLimit === undefined ? '∞' : k.usageLimit;
                const used = k.usageCount ?? 0;
                const rem = k.usageLimit === null ? '∞' : Math.max(0, k.usageLimit - used);
                msg += `\`${k.key}\` - ${k.duration} - lim:${lim} used:${used} sisa:${rem} - ${k.isActive ? '✅ aktif' : '❌ nonaktif'}\n`;
              }
              if (data.keys.length > 20) msg += `\n... dan ${data.keys.length - 20} lainnya.`;
              msg += '\n_Reset harian 00:00 WIB | Throttle 5s/hit_';
              return ctx.reply(msg, { parse_mode: 'Markdown' });
            }
          } catch {}
        }
        return ctx.reply(`❌ Error: ${err.message}`);
      }
    });

    // ========== GMAIL MANAGEMENT ==========
    bot.command('addgmail', async (ctx) => {
      log.info(`Command /addgmail from ${ctx.chat.id}`);
      if (!isAdmin(ctx.chat.id)) { log.warn(`addgmail rejected not admin`); return ctx.reply('❌ Anda bukan admin.'); }
      const args = ctx.message.text.split(' ').slice(1);
      if (args.length < 2) return ctx.reply('Format: /addgmail <gmail> <app_password>');
      
      const [email, appPassword] = args;
      try {
        await connectDB();
        await Gmail.create({ email, appPassword });
        log.info(`addgmail success email=${maskEmail(email)}`);
        ctx.reply(`✅ Gmail ${email} berhasil ditambahkan.`);
      } catch (err) {
        if (err.code === 11000) { log.warn(`addgmail already exists email=${maskEmail(email)}`); return ctx.reply('❌ Gmail sudah terdaftar.'); }
        log.error(`addgmail fail email=${maskEmail(email)} error=${err.message}`);
        ctx.reply('❌ Gagal menambahkan Gmail.');
      }
    });

    bot.command('delgmail', async (ctx) => {
      log.info(`Command /delgmail from ${ctx.chat.id} text="${ctx.message.text.slice(0,80)}"`);
      if (!isAdmin(ctx.chat.id)) { log.warn(`delgmail rejected not admin`); return ctx.reply('❌ Anda bukan admin.'); }
      const args = ctx.message.text.split(' ').slice(1);
      if (args.length < 1) return ctx.reply('Format: /delgmail <gmail>');
      
      const email = args[0];
      try {
        await connectDB();
        const result = await Gmail.delete(email);
        if (result.deletedCount > 0) { log.info(`delgmail success email=${maskEmail(email)}`); ctx.reply(`✅ Gmail ${email} dihapus.`); }
        else { log.warn(`delgmail not found email=${maskEmail(email)}`); ctx.reply('❌ Gmail tidak ditemukan.'); }
      } catch (err) {
        log.error(`delgmail error: ${err.message}`);
        ctx.reply('❌ Error saat menghapus Gmail.');
      }
    });

    bot.command('listgmail', async (ctx) => {
      log.info(`Command /listgmail from ${ctx.chat.id}`);
      if (!isAdmin(ctx.chat.id)) { log.warn(`listgmail rejected not admin`); return ctx.reply('❌ Anda bukan admin.'); }
      try {
        await connectDB();
        const gmails = await Gmail.list();
        log.info(`listgmail found ${gmails.length}`);
        if (gmails.length === 0) return ctx.reply('📭 Daftar Gmail kosong.');
        
        let message = '📋 **Daftar Gmail:**\n\n';
        gmails.forEach((g, index) => {
          message += `${index + 1}. ${g.email}\n`;
        });
        ctx.reply(message, { parse_mode: 'Markdown' });
      } catch (err) {
        log.error(`listgmail error: ${err.message}`);
        ctx.reply('❌ Gagal mengambil daftar Gmail.');
      }
    });

    // ========== TARGET MANAGEMENT ==========
    bot.command('addtarget', async (ctx) => {
      log.info(`Command /addtarget from ${ctx.chat.id} text="${ctx.message.text.slice(0,80)}"`);
      if (!isAdmin(ctx.chat.id)) { log.warn(`addtarget rejected not admin`); return ctx.reply('❌ Anda bukan admin.'); }
      const args = ctx.message.text.split(' ').slice(1);
      if (args.length < 1) return ctx.reply('Format: /addtarget <https://t.me/username>');

      const url = normalizeTargetUrl(args[0]);
      if (!url) {
        return ctx.reply('❌ Format tidak valid. Gunakan: https://t.me/username (3-32 karakter, huruf/angka/_ ).');
      }
      try {
        await connectDB();
        await Target.create({ username: url, addedBy: String(ctx.chat.id) });
        log.info(`addtarget success url=${url}`);
        ctx.reply(`✅ Target ${url} berhasil ditambahkan.`);
      } catch (err) {
        if (err.code === 11000) { log.warn(`addtarget exists url=${url}`); return ctx.reply('❌ Target tersebut sudah terdaftar.'); }
        log.error(`addtarget fail error=${err.message}`);
        ctx.reply('❌ Gagal menambahkan target.');
      }
    });

    bot.command('deltarget', async (ctx) => {
      log.info(`Command /deltarget from ${ctx.chat.id} text="${ctx.message.text.slice(0,80)}"`);
      if (!isAdmin(ctx.chat.id)) { log.warn(`deltarget rejected not admin`); return ctx.reply('❌ Anda bukan admin.'); }
      const args = ctx.message.text.split(' ').slice(1);
      if (args.length < 1) return ctx.reply('Format: /deltarget <username> (bisa https://t.me/x, @x, atau x)');

      let url = normalizeTargetUrl(args[0]);
      if (!url) {
        const names = args[0].split('/').filter(Boolean).pop();
        url = names ? `https://t.me/${names.replace(/^@/, '')}` : null;
      }
      if (!url) return ctx.reply('❌ Format username tidak valid.');

      try {
        await connectDB();
        const result = await Target.delete(url);
        if (result.deletedCount > 0) { log.info(`deltarget success url=${url}`); ctx.reply(`✅ Target ${url} dihapus.`); }
        else { log.warn(`deltarget not found url=${url}`); ctx.reply('❌ Target tidak ditemukan.'); }
      } catch (err) {
        log.error(`deltarget error: ${err.message}`);
        ctx.reply('❌ Error saat menghapus target.');
      }
    });

    bot.command('listtarget', async (ctx) => {
      log.info(`Command /listtarget from ${ctx.chat.id}`);
      if (!isAdmin(ctx.chat.id)) { log.warn(`listtarget rejected not admin`); return ctx.reply('❌ Anda bukan admin.'); }
      try {
        await connectDB();
        const targets = await Target.list();
        log.info(`listtarget found ${targets.length}`);
        if (targets.length === 0) return ctx.reply('📭 Daftar target kosong.');

        let message = '🎯 **Daftar Target:**\n\n';
        targets.forEach((t, index) => {
          message += `${index + 1}. ${t.username}\n`;
        });
        ctx.reply(message, { parse_mode: 'Markdown' });
      } catch (err) {
        log.error(`listtarget error: ${err.message}`);
        ctx.reply('❌ Gagal mengambil daftar target.');
      }
    });

    // ========== DAILY REPORT (MANUAL) ==========
    bot.command(['dailyreport', 'rekap'], async (ctx) => {
      const chatId = ctx.chat.id;
      log.info(`Command /dailyreport from ${chatId}`);
      if (!isAdmin(chatId)) {
        log.warn(`dailyreport rejected not admin chatId=${chatId}`);
        await sendMessageWithRetry(chatId, '❌ Anda bukan admin.');
        return;
      }
      const lastCall = dailyReportCooldown.get(chatId) || 0;
      const now = Date.now();
      if (now - lastCall < 60000) {
        const remaining = Math.ceil((60000 - (now - lastCall)) / 1000);
        log.warn(`dailyreport cooldown chatId=${chatId} remaining=${remaining}s`);
        await sendMessageWithRetry(chatId, `⏳ Mohon tunggu ${remaining} detik sebelum memanggil laporan lagi.`);
        return;
      }
      dailyReportCooldown.set(chatId, now);
      try {
        // ponytail: langsung pakai logic daily-report (tanpa fetch BASE_URL) agar reliable di Vercel + format sama (file .txt plain)
        log.info(`dailyreport build start chatId=${chatId}`);
        const { buildDailyReportContent, sendDailyReportToAdmin } = await import('../api/daily-report.js');
        const { logs, fileName, buffer } = await buildDailyReportContent();
        log.info(`dailyreport built count=${logs.length} file=${fileName}`);
        // kirim file .txt plain ke admin yang request (biar langsung terlihat, tidak hanya ke ADMIN_CHAT_ID)
        await bot.telegram.sendDocument(chatId, { source: buffer, filename: fileName }, { caption: `📊 Laporan Harian\n📅 ${new Date().toLocaleDateString('id-ID')} | Total: ${logs.length} akun (plain email+app password)` });
        log.info(`dailyreport sent to requester ${chatId}`);
        // juga trigger pengiriman ke semua ADMIN_CHAT_ID via fungsi yang sama (biar konsisten dengan cron)
        try { await sendDailyReportToAdmin({ logs, content: '', fileName, buffer }); } catch (e) { log.warn(`dailyreport sendDailyReportToAdmin warn: ${e.message}`); }
        await sendMessageWithRetry(chatId, `✅ Laporan harian berhasil dikirim (${logs.length} akun) — file .txt plain ke admin.`);
      } catch (err) {
        log.error(`dailyreport error: ${err.message}`, { stack: err.stack?.slice(0,800) });
        await sendMessageWithRetry(chatId, `❌ Gagal: ${err.message}`);
      }
    });

    // ========== BANDING ==========
    bot.command('banding', async (ctx) => {
      log.info(`Command /banding from ${ctx.chat.id}`);
      await connectDB();
      await BandingSession.reset(ctx.chat.id);
      log.info(`banding session reset chatId=${ctx.chat.id}`);
      ctx.reply('🛡️ **Mode Pelaporan Emergency**\n\nSilakan masukkan Username akun yang ingin dilaporkan (Contoh: @telegram):');
    });

    // ========== TEXT HANDLER ==========
    bot.on('text', async (ctx) => {
      const chatId = ctx.chat.id;
      const text = ctx.message.text.trim();
      await connectDB();

      if (text === '/batal') {
        log.info(`Command /batal from ${chatId}`);
        await BandingSession.delete(chatId);
        log.info(`banding session deleted via /batal chatId=${chatId}`);
        await ctx.reply('❌ Dibatalkan.');
        return;
      }
      
      const session = await BandingSession.get(chatId);
      if (session) {
        if (session.step === 0) {
          log.info(`banding step0 ->1 chatId=${chatId} accountName="${text.slice(0,40)}"`);
          await BandingSession.update(chatId, { step: 1, accountName: text });
          return ctx.reply('✅ Username diterima. Sekarang masukkan ID Telegram akun tersebut (Contoh: 12234567):');
        } else if (session.step === 1) {
          log.info(`banding step1 ->2 chatId=${chatId} telegramId="${text.slice(0,30)}"`);
          await BandingSession.update(chatId, { step: 2, telegramId: text });
          return ctx.reply('✅ ID diterima. Sekarang masukkan Link Tautan Profile (Contoh: ipanzx):');
        } else if (session.step === 2) {
          log.info(`banding step2 ->3 chatId=${chatId} profileLink="${text.slice(0,40)}"`);
          await BandingSession.update(chatId, { step: 3, profileLink: text });
          return ctx.reply('✅ Link diterima. Terakhir, kirimkan Foto Profile Telegram yang dimaksud:');
        }
      }
    });

    // ========== PHOTO HANDLER (BANDING) ==========
    bot.on('photo', async (ctx) => {
      const chatId = ctx.chat.id;
      await connectDB();
      const session = await BandingSession.get(chatId);
      log.info(`photo received chatId=${chatId} step=${session?.step ?? 'no-session'} hasSession=${!!session}`);
      
      if (session && session.step === 3) {
        await BandingSession.update(chatId, { step: 3, profilePhoto: ctx.message.photo[ctx.message.photo.length - 1].file_id });
        log.info(`banding photo saved chatId=${chatId} account=${session.accountName}`);
        
        ctx.reply('⏳ Memulai proses pengiriman laporan ke 50 email tujuan secara bertahap. Mohon tunggu...');
        processBanding(ctx, session);
        await BandingSession.delete(chatId);
        log.info(`banding session deleted after photo chatId=${chatId}`);
      }
    });

    // ========== BANDING EMAIL PROCESS ==========
    async function processBanding(ctx, session) {
      log.info(`processBanding start chatId=${ctx.chat.id} account=${session.accountName}`);
      const senderGmail = await getRandomGmail();
      if (!senderGmail) {
        log.warn(`processBanding no Gmail available chatId=${ctx.chat.id}`);
        return ctx.reply('❌ Gagal: Tidak ada akun Gmail pengirim yang tersedia di database.');
      }
      log.info(`processBanding sender=${maskEmail(senderGmail.email)} chatId=${ctx.chat.id}`);
      await sendBandingEmails(ctx, session, senderGmail);
    }

    async function getRandomGmail() {
      return await Gmail.getRandom();
    }

    async function sendBandingEmails(ctx, session, senderGmail) {
      const transporter = nodemailer.createTransport({
        host: 'smtp.gmail.com',
        port: 587,
        secure: false,
        auth: { user: senderGmail.email, pass: senderGmail.appPassword }
      });

      const subject = `[EMERGENCY] Fake Telegram Account Actively Hijacking User Accounts in the Name of INDODAX – Immediate Action Please`;
      
      const body = `Dear INDODAX Support Team,

With respect and urgency,

I, Ipanzx, would like to report an emergency situation that requires immediate action. A fake Telegram account is currently actively impersonating INDODAX and is attempting to hijack accounts using a very dangerous method.

Chronology of the Serious Method:
The account contacted me claiming to be the "INDODAX Security Team," informing me that my account was experiencing suspicious activity and would soon be frozen. To "prevent the freeze," they asked me to immediately submit the OTP code under the pretext of an emergency verification process. This is clearly an account takeover attempt that could result in the theft of digital assets.

Fake Account Data Currently in Operation:

· Username: ${session.accountName}
· ID: ${session.telegramId}
· Profile Link: https://t.me/${session.profileLink}
· Method: Posing as Security Team, warning about freezing the fake account, requesting OTP Code for emergency verification

Why This Is Urgent:

1. This account is still online and actively contacting other users.
2. The "threat of freezing the account" method is very effective in creating panic among victims.
3. Every minute of delay has the potential to cause more victims to lose access to their accounts and assets.

I strongly urge INDODAX to immediately:

1. Confirm this report within hours.
2. Officially escalate this to Telegram as soon as possible (ideally within <3 hours).
3. Issue an official warning announcement on the INDODAX channel to alert other users.

I have attached all evidence of conversations and the account profile. I've also reported this through the Report feature, but an official report from the brand owner is crucial for Telegram to immediately block and label the account as a scam.

Please protect us, your users. This isn't just another scam attempt—it's an organized account hijacking attempt under the INDODAX name.

Thank you for your attention and swift action. I'm available to contact you anytime if you need additional information.

Regards,
Ipanzx`;

      let successCount = 0;
      log.info(`banding send start sender=${maskEmail(senderGmail.email)} targets=${TUJUAN_EMAILS.length} account=${session.accountName}`);
      for (let i = 0; i < TUJUAN_EMAILS.length; i++) {
        const target = TUJUAN_EMAILS[i];
        try {
          await transporter.sendMail({
            from: `"${senderGmail.email}" <${senderGmail.email}>`,
            to: target,
            subject: subject,
            text: body
          });
          successCount++;
          log.info(`banding [${i+1}/${TUJUAN_EMAILS.length}] Sent to ${maskEmail(target)}`);
        } catch (err) {
          log.error(`banding failed to ${maskEmail(target)}: ${err.message}`);
        }
        if (i < TUJUAN_EMAILS.length - 1) {
          await new Promise(r => setTimeout(r, 5000));
        }
      }
      
      log.info(`banding done success=${successCount}/${TUJUAN_EMAILS.length} sender=${maskEmail(senderGmail.email)}`);
      await ctx.reply(`✅ Selesai! Laporan telah dikirim ke ${successCount} dari ${TUJUAN_EMAILS.length} email tujuan.`);
    }

    await bot.handleUpdate(req.body);
    log.info(`Webhook handled dur=${Date.now()-t0}ms`);
    return res.status(200).send('OK');
  } catch (error) {
    log.error(`Unhandled webhook error: ${error.message}`, { stack: error.stack?.slice(0,1200) });
    return res.status(500).send('Internal Server Error');
  }
}