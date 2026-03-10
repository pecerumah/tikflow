/**
 * ============================================================
 * TikFlow — Cloudflare Worker (Backend API + Cron Scheduler)
 * ============================================================
 * Deploy  : wrangler deploy
 * Cron    : setiap menit via wrangler.toml [triggers]
 * Runtime : Cloudflare Workers (Edge, global)
 * ============================================================
 */

// ── Routing ──────────────────────────────────────────────────
const ROUTES = {
  'POST /api/auth/login':         handleLogin,
  'POST /api/auth/logout':        handleLogout,
  'GET  /api/auth/me':            handleMe,

  'GET  /api/users':              handleGetUsers,
  'POST /api/users':              handleCreateUser,
  'PUT  /api/users/:id':          handleUpdateUser,
  'DEL  /api/users/:id':          handleDeleteUser,

  'GET  /api/accounts':           handleGetAccounts,
  'POST /api/accounts':           handleCreateAccount,
  'PUT  /api/accounts/:id':       handleUpdateAccount,
  'DEL  /api/accounts/:id':       handleDeleteAccount,
  'POST /api/accounts/oauth':     handleOAuthInit,
  'GET  /api/accounts/callback':  handleOAuthCallback,

  'POST /api/upload/presign':     handlePresignUpload,
  'POST /api/upload/complete':    handleUploadComplete,

  'GET  /api/posts':              handleGetPosts,
  'POST /api/posts':              handleCreatePost,
  'PUT  /api/posts/:id':          handleUpdatePost,
  'DEL  /api/posts/:id':          handleDeletePost,

  'GET  /api/r2/test':            handleTestR2,

  'GET  /api/analytics':          handleAnalytics,
};

// ── Main Handler ─────────────────────────────────────────────
export default {
  // HTTP requests
  async fetch(request, env, ctx) {
    // CORS preflight
    if (request.method === 'OPTIONS') {
      return corsResponse(new Response(null, { status: 204 }));
    }

    try {
      const url = new URL(request.url);
      const path = url.pathname;
      const method = request.method;

      // Match route
      for (const [routeKey, handler] of Object.entries(ROUTES)) {
        const [routeMethod, routePath] = routeKey.split(' ');
        if (routeMethod !== method && routeMethod !== 'DEL') continue;
        if (routeMethod === 'DEL' && method !== 'DELETE') continue;

        const params = matchRoute(routePath, path);
        if (params !== null) {
          const req = { request, url, params, env, ctx };
          const res = await handler(req);
          return corsResponse(res);
        }
      }

      return corsResponse(json({ error: 'Not Found' }, 404));
    } catch (err) {
      console.error('[Worker Error]', err);
      return corsResponse(json({ error: 'Internal Server Error', detail: err.message }, 500));
    }
  },

  // Cron Trigger — setiap menit
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runScheduler(env));
  },
};

// ── CORS Helper ───────────────────────────────────────────────
function corsResponse(response) {
  const headers = new Headers(response.headers);
  headers.set('Access-Control-Allow-Origin', '*');
  headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  return new Response(response.body, { status: response.status, headers });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function matchRoute(pattern, path) {
  const patternParts = pattern.split('/');
  const pathParts = path.split('/');
  if (patternParts.length !== pathParts.length) return null;
  const params = {};
  for (let i = 0; i < patternParts.length; i++) {
    if (patternParts[i].startsWith(':')) {
      params[patternParts[i].slice(1)] = pathParts[i];
    } else if (patternParts[i] !== pathParts[i]) {
      return null;
    }
  }
  return params;
}

// ── Auth Middleware ───────────────────────────────────────────
async function requireAuth(req) {
  const token = req.request.headers.get('Authorization')?.replace('Bearer ', '');
  if (!token) return null;
  const session = await req.env.KV.get(`session:${token}`);
  if (!session) return null;
  return JSON.parse(session); // { userId, role }
}

async function requireAdmin(req) {
  const user = await requireAuth(req);
  if (!user || user.role !== 'superadmin') return null;
  return user;
}

// ── AUTH Handlers ─────────────────────────────────────────────
async function handleLogin({ request, env }) {
  const { email, password } = await request.json();
  const user = await env.DB.prepare(
    `SELECT * FROM users WHERE email = ? AND active = 1`
  ).bind(email).first();

  if (!user) return json({ error: 'Email atau password salah' }, 401);

  const validPass = await verifyPassword(password, user.password_hash);
  if (!validPass) return json({ error: 'Email atau password salah' }, 401);

  const token = await generateToken();
  await env.KV.put(
    `session:${token}`,
    JSON.stringify({ userId: user.id, role: user.role }),
    { expirationTtl: 60 * 60 * 24 * 7 } // 7 hari
  );

  return json({
    token,
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      r2Config: user.r2_config ? JSON.parse(user.r2_config) : null,
    },
  });
}

async function handleLogout({ request, env }) {
  const token = request.headers.get('Authorization')?.replace('Bearer ', '');
  if (token) await env.KV.delete(`session:${token}`);
  return json({ success: true });
}

async function handleMe(req) {
  const user = await requireAuth(req);
  if (!user) return json({ error: 'Unauthorized' }, 401);
  const row = await req.env.DB.prepare('SELECT id, name, email, role, r2_config FROM users WHERE id = ?').bind(user.userId).first();
  if (!row) return json({ error: 'User not found' }, 404);
  return json({
    id: row.id, name: row.name, email: row.email, role: row.role,
    r2Config: row.r2_config ? JSON.parse(row.r2_config) : null,
  });
}

// ── USER Handlers ─────────────────────────────────────────────
async function handleGetUsers(req) {
  const admin = await requireAdmin(req);
  if (!admin) return json({ error: 'Forbidden' }, 403);
  const rows = await req.env.DB.prepare(
    'SELECT id, name, email, role, active, r2_config, created_at FROM users ORDER BY created_at DESC'
  ).all();
  return json(rows.results.map(u => ({
    ...u, r2Config: u.r2_config ? JSON.parse(u.r2_config) : null, r2_config: undefined,
  })));
}

async function handleCreateUser(req) {
  const admin = await requireAdmin(req);
  if (!admin) return json({ error: 'Forbidden' }, 403);
  const { name, email, password, role, accountIds } = await req.request.json();
  const exists = await req.env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
  if (exists) return json({ error: 'Email sudah terdaftar' }, 400);
  const hash = await hashPassword(password);
  const result = await req.env.DB.prepare(
    `INSERT INTO users (name, email, password_hash, role, active) VALUES (?, ?, ?, ?, 1)`
  ).bind(name, email, hash, role || 'user').run();
  const uid = result.meta.last_row_id;
  if (accountIds?.length) {
    for (const aid of accountIds) {
      await req.env.DB.prepare('INSERT OR IGNORE INTO account_users (account_id, user_id) VALUES (?, ?)').bind(aid, uid).run();
    }
  }
  return json({ id: uid, success: true });
}

async function handleUpdateUser(req) {
  const session = await requireAuth(req);
  if (!session) return json({ error: 'Unauthorized' }, 401);
  const id = parseInt(req.params.id);
  // Users can only update themselves; admins can update anyone
  if (session.role !== 'superadmin' && session.userId !== id) return json({ error: 'Forbidden' }, 403);
  const body = await req.request.json();
  const db = req.env.DB;

  // R2 config update (allowed for self)
  if (body.r2Config !== undefined) {
    await db.prepare('UPDATE users SET r2_config = ? WHERE id = ?')
      .bind(JSON.stringify(body.r2Config), id).run();
  }
  if (body.name) await db.prepare('UPDATE users SET name = ? WHERE id = ?').bind(body.name, id).run();
  if (body.email && session.role === 'superadmin') await db.prepare('UPDATE users SET email = ? WHERE id = ?').bind(body.email, id).run();
  if (body.role && session.role === 'superadmin') await db.prepare('UPDATE users SET role = ? WHERE id = ?').bind(body.role, id).run();
  if (body.active !== undefined && session.role === 'superadmin') await db.prepare('UPDATE users SET active = ? WHERE id = ?').bind(body.active ? 1 : 0, id).run();
  if (body.password) {
    const h = await hashPassword(body.password);
    await db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').bind(h, id).run();
  }
  return json({ success: true });
}

async function handleDeleteUser(req) {
  const admin = await requireAdmin(req);
  if (!admin) return json({ error: 'Forbidden' }, 403);
  const id = parseInt(req.params.id);
  if (id === admin.userId) return json({ error: 'Tidak bisa menghapus akun sendiri' }, 400);
  await req.env.DB.prepare('DELETE FROM account_users WHERE user_id = ?').bind(id).run();
  await req.env.DB.prepare('DELETE FROM users WHERE id = ?').bind(id).run();
  return json({ success: true });
}

// ── TIKTOK ACCOUNT Handlers ───────────────────────────────────
async function handleGetAccounts(req) {
  const session = await requireAuth(req);
  if (!session) return json({ error: 'Unauthorized' }, 401);
  let rows;
  if (session.role === 'superadmin') {
    rows = await req.env.DB.prepare(
      `SELECT ta.*, GROUP_CONCAT(au.user_id) as user_ids
       FROM tiktok_accounts ta
       LEFT JOIN account_users au ON ta.id = au.account_id
       GROUP BY ta.id ORDER BY ta.created_at DESC`
    ).all();
  } else {
    rows = await req.env.DB.prepare(
      `SELECT ta.*, GROUP_CONCAT(au.user_id) as user_ids
       FROM tiktok_accounts ta
       JOIN account_users au ON ta.id = au.account_id
       WHERE au.user_id = ?
       GROUP BY ta.id ORDER BY ta.created_at DESC`
    ).bind(session.userId).all();
  }
  return json(rows.results.map(r => ({
    ...r,
    userIds: r.user_ids ? r.user_ids.split(',').map(Number) : [],
    user_ids: undefined, access_token: undefined, refresh_token: undefined,
  })));
}

async function handleCreateAccount(req) {
  const admin = await requireAdmin(req);
  if (!admin) return json({ error: 'Forbidden' }, 403);
  const body = await req.request.json();
  const result = await req.env.DB.prepare(
    `INSERT INTO tiktok_accounts (display_name, handle, open_id, access_token, refresh_token, token_expires_at, status)
     VALUES (?, ?, ?, ?, ?, ?, 'connected')`
  ).bind(body.displayName, body.handle, body.openId, body.accessToken, body.refreshToken, body.expiresAt).run();
  const aid = result.meta.last_row_id;
  if (body.userIds?.length) {
    for (const uid of body.userIds) {
      await req.env.DB.prepare('INSERT OR IGNORE INTO account_users (account_id, user_id) VALUES (?, ?)').bind(aid, uid).run();
    }
  }
  return json({ id: aid, success: true });
}

async function handleUpdateAccount(req) {
  const admin = await requireAdmin(req);
  if (!admin) return json({ error: 'Forbidden' }, 403);
  const id = parseInt(req.params.id);
  const body = await req.request.json();
  if (body.displayName) await req.env.DB.prepare('UPDATE tiktok_accounts SET display_name = ? WHERE id = ?').bind(body.displayName, id).run();
  if (body.status) await req.env.DB.prepare('UPDATE tiktok_accounts SET status = ? WHERE id = ?').bind(body.status, id).run();
  if (body.userIds) {
    await req.env.DB.prepare('DELETE FROM account_users WHERE account_id = ?').bind(id).run();
    for (const uid of body.userIds) {
      await req.env.DB.prepare('INSERT OR IGNORE INTO account_users (account_id, user_id) VALUES (?, ?)').bind(id, uid).run();
    }
  }
  return json({ success: true });
}

async function handleDeleteAccount(req) {
  const admin = await requireAdmin(req);
  if (!admin) return json({ error: 'Forbidden' }, 403);
  const id = parseInt(req.params.id);
  await req.env.DB.prepare('DELETE FROM account_users WHERE account_id = ?').bind(id).run();
  await req.env.DB.prepare('DELETE FROM post_accounts WHERE account_id = ?').bind(id).run();
  await req.env.DB.prepare('DELETE FROM tiktok_accounts WHERE id = ?').bind(id).run();
  return json({ success: true });
}

async function handleOAuthInit(req) {
  const session = await requireAuth(req);
  if (!session) return json({ error: 'Unauthorized' }, 401);
  const state = await generateToken(16);
  await req.env.KV.put(`oauth:${state}`, String(session.userId), { expirationTtl: 600 });
  const authUrl =
    `https://www.tiktok.com/v2/auth/authorize/` +
    `?client_key=${req.env.TIKTOK_CLIENT_KEY}` +
    `&response_type=code` +
    `&scope=user.info.basic,video.upload,video.publish` +
    `&redirect_uri=${encodeURIComponent(req.env.OAUTH_REDIRECT_URI)}` +
    `&state=${state}`;
  return json({ authUrl });
}

async function handleOAuthCallback({ request, url, env }) {
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const error = url.searchParams.get('error');

  if (error) return Response.redirect(`${env.FRONTEND_URL}?error=${error}`);

  const userId = await env.KV.get(`oauth:${state}`);
  if (!userId) return Response.redirect(`${env.FRONTEND_URL}?error=invalid_state`);
  await env.KV.delete(`oauth:${state}`);

  // Exchange code → token
  const tokenRes = await fetch('https://open.tiktokapis.com/v2/oauth/token/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_key: env.TIKTOK_CLIENT_KEY,
      client_secret: env.TIKTOK_CLIENT_SECRET,
      code,
      grant_type: 'authorization_code',
      redirect_uri: env.OAUTH_REDIRECT_URI,
    }),
  });
  const td = await tokenRes.json();
  if (td.error) return Response.redirect(`${env.FRONTEND_URL}?error=${td.error}`);

  // Get user info
  const uRes = await fetch(
    'https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name,avatar_url,follower_count,likes_count,video_count',
    { headers: { Authorization: `Bearer ${td.access_token}` } }
  );
  const ud = await uRes.json();
  const tk = ud.data?.user;

  await env.DB.prepare(`
    INSERT INTO tiktok_accounts (open_id, display_name, handle, avatar_url, followers, access_token, refresh_token, token_expires_at, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'connected')
    ON CONFLICT(open_id) DO UPDATE SET
      access_token = excluded.access_token,
      refresh_token = excluded.refresh_token,
      token_expires_at = excluded.token_expires_at,
      status = 'connected',
      followers = excluded.followers
  `).bind(
    tk.open_id, tk.display_name,
    '@' + tk.display_name.toLowerCase().replace(/\s+/g, ''),
    tk.avatar_url, tk.follower_count,
    td.access_token, td.refresh_token,
    Date.now() + td.expires_in * 1000
  ).run();

  const acc = await env.DB.prepare('SELECT id FROM tiktok_accounts WHERE open_id = ?').bind(tk.open_id).first();
  await env.DB.prepare('INSERT OR IGNORE INTO account_users (account_id, user_id) VALUES (?, ?)').bind(acc.id, parseInt(userId)).run();

  return Response.redirect(`${env.FRONTEND_URL}?success=account_connected`);
}

// ── UPLOAD Handlers ───────────────────────────────────────────
async function handlePresignUpload(req) {
  const session = await requireAuth(req);
  if (!session) return json({ error: 'Unauthorized' }, 401);

  // Get user's R2 config
  const user = await req.env.DB.prepare('SELECT r2_config FROM users WHERE id = ?').bind(session.userId).first();
  if (!user?.r2_config) return json({ error: 'R2 belum dikonfigurasi' }, 400);
  const r2 = JSON.parse(user.r2_config);
  if (!r2.verified) return json({ error: 'R2 belum terverifikasi' }, 400);

  const { filename, contentType } = await req.request.json();
  const key = `videos/${session.userId}/${Date.now()}-${filename.replace(/[^a-zA-Z0-9.\-_]/g, '_')}`;

  return json({ key, uploadUrl: `${r2.endpoint}/${r2.bucket}/${key}`, r2Config: { bucket: r2.bucket, endpoint: r2.endpoint } });
}

async function handleUploadComplete(req) {
  const session = await requireAuth(req);
  if (!session) return json({ error: 'Unauthorized' }, 401);
  const { key, size, duration } = await req.request.json();

  const user = await req.env.DB.prepare('SELECT r2_config FROM users WHERE id = ?').bind(session.userId).first();
  const r2 = JSON.parse(user.r2_config);
  const publicUrl = `https://${r2.publicDomain}/${key}`;

  const result = await req.env.DB.prepare(
    `INSERT INTO video_files (user_id, r2_key, r2_url, file_size, duration, uploaded_at) VALUES (?, ?, ?, ?, ?, datetime('now'))`
  ).bind(session.userId, key, publicUrl, size || 0, duration || 0).run();

  return json({ id: result.meta.last_row_id, key, url: publicUrl });
}

// ── POST Handlers ─────────────────────────────────────────────
async function handleGetPosts(req) {
  const session = await requireAuth(req);
  if (!session) return json({ error: 'Unauthorized' }, 401);
  const { status } = Object.fromEntries(req.url.searchParams);

  let query = `
    SELECT p.*, GROUP_CONCAT(pa.account_id) as account_ids
    FROM posts p
    LEFT JOIN post_accounts pa ON p.id = pa.post_id
  `;
  const binds = [];

  if (session.role !== 'superadmin') {
    query += ` WHERE p.created_by = ?`;
    binds.push(session.userId);
    if (status) { query += ` AND p.status = ?`; binds.push(status); }
  } else if (status) {
    query += ` WHERE p.status = ?`;
    binds.push(status);
  }

  query += ` GROUP BY p.id ORDER BY p.scheduled_at DESC LIMIT 100`;
  const stmt = req.env.DB.prepare(query);
  const rows = await (binds.length ? stmt.bind(...binds) : stmt).all();

  return json(rows.results.map(p => ({
    ...p,
    accountIds: p.account_ids ? p.account_ids.split(',').map(Number) : [],
    hashtags: JSON.parse(p.hashtags || '[]'),
    affiliates: JSON.parse(p.affiliates || '[]'),
    account_ids: undefined,
  })));
}

async function handleCreatePost(req) {
  const session = await requireAuth(req);
  if (!session) return json({ error: 'Unauthorized' }, 401);
  const body = await req.request.json();

  const result = await req.env.DB.prepare(`
    INSERT INTO posts (title, caption, video_file_id, r2_key, r2_url, music_title, music_id, hashtags, affiliates, scheduled_at, status, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    body.title, body.caption, body.videoFileId || null,
    body.r2Key || null, body.r2Url || null,
    body.musicTitle || null, body.musicId || null,
    JSON.stringify(body.hashtags || []),
    JSON.stringify(body.affiliates || []),
    body.scheduledAt || null,
    body.status || 'scheduled',
    session.userId
  ).run();

  const pid = result.meta.last_row_id;
  for (const accId of (body.accountIds || [])) {
    await req.env.DB.prepare('INSERT INTO post_accounts (post_id, account_id) VALUES (?, ?)').bind(pid, accId).run();
  }
  return json({ id: pid, success: true });
}

async function handleUpdatePost(req) {
  const session = await requireAuth(req);
  if (!session) return json({ error: 'Unauthorized' }, 401);
  const id = parseInt(req.params.id);
  const post = await req.env.DB.prepare('SELECT created_by FROM posts WHERE id = ?').bind(id).first();
  if (!post) return json({ error: 'Post not found' }, 404);
  if (session.role !== 'superadmin' && post.created_by !== session.userId) return json({ error: 'Forbidden' }, 403);

  const body = await req.request.json();
  await req.env.DB.prepare(`
    UPDATE posts SET title=?, caption=?, music_title=?, music_id=?, hashtags=?, affiliates=?, scheduled_at=?, status=?
    WHERE id=?
  `).bind(
    body.title, body.caption, body.musicTitle || null, body.musicId || null,
    JSON.stringify(body.hashtags || []), JSON.stringify(body.affiliates || []),
    body.scheduledAt || null, body.status, id
  ).run();

  if (body.accountIds) {
    await req.env.DB.prepare('DELETE FROM post_accounts WHERE post_id = ?').bind(id).run();
    for (const aid of body.accountIds) {
      await req.env.DB.prepare('INSERT INTO post_accounts (post_id, account_id) VALUES (?, ?)').bind(id, aid).run();
    }
  }
  return json({ success: true });
}

async function handleDeletePost(req) {
  const session = await requireAuth(req);
  if (!session) return json({ error: 'Unauthorized' }, 401);
  const id = parseInt(req.params.id);
  const post = await req.env.DB.prepare('SELECT created_by, r2_key FROM posts WHERE id = ?').bind(id).first();
  if (!post) return json({ error: 'Not found' }, 404);
  if (session.role !== 'superadmin' && post.created_by !== session.userId) return json({ error: 'Forbidden' }, 403);

  await req.env.DB.prepare('DELETE FROM post_accounts WHERE post_id = ?').bind(id).run();
  await req.env.DB.prepare('DELETE FROM posts WHERE id = ?').bind(id).run();
  return json({ success: true });
}

// ── R2 TEST ───────────────────────────────────────────────────
async function handleTestR2(req) {
  const session = await requireAuth(req);
  if (!session) return json({ error: 'Unauthorized' }, 401);
  const user = await req.env.DB.prepare('SELECT r2_config FROM users WHERE id = ?').bind(session.userId).first();
  if (!user?.r2_config) return json({ ok: false, error: 'R2 belum dikonfigurasi' });
  const r2 = JSON.parse(user.r2_config);

  try {
    // Try a simple HEAD request to the endpoint
    const testRes = await fetch(`${r2.endpoint}/`, { method: 'HEAD' });
    return json({ ok: true, bucket: r2.bucket, domain: r2.publicDomain });
  } catch (e) {
    return json({ ok: false, error: e.message });
  }
}

// ── ANALYTICS ─────────────────────────────────────────────────
async function handleAnalytics(req) {
  const session = await requireAuth(req);
  if (!session) return json({ error: 'Unauthorized' }, 401);

  const posts = await req.env.DB.prepare(
    session.role === 'superadmin'
      ? 'SELECT COUNT(*) as total, status FROM posts GROUP BY status'
      : 'SELECT COUNT(*) as total, status FROM posts WHERE created_by = ? GROUP BY status'
  ).bind(session.userId).all();

  return json({ postsByStatus: posts.results });
}

// ══════════════════════════════════════════════════════════════
// CRON SCHEDULER — Berjalan setiap menit
// ══════════════════════════════════════════════════════════════
async function runScheduler(env) {
  const now = new Date();
  const nowStr = now.toISOString().slice(0, 16).replace('T', ' '); // "YYYY-MM-DD HH:MM"

  console.log(`[Scheduler] ${now.toISOString()} — Cek jadwal posting...`);

  // Ambil semua post yang jadwalnya sudah tiba
  const due = await env.DB.prepare(`
    SELECT p.*, GROUP_CONCAT(pa.account_id) as account_ids
    FROM posts p
    JOIN post_accounts pa ON p.id = pa.post_id
    WHERE p.status = 'scheduled'
      AND p.scheduled_at <= ?
      AND p.scheduled_at > datetime(?, '-1 minute')
    GROUP BY p.id
  `).bind(nowStr, nowStr).all();

  console.log(`[Scheduler] Ditemukan ${due.results.length} post untuk diproses`);

  for (const post of due.results) {
    const accountIds = post.account_ids?.split(',').map(Number) || [];

    // Update status → processing
    await env.DB.prepare(`UPDATE posts SET status = 'processing' WHERE id = ?`).bind(post.id).run();

    let allSuccess = true;
    const errors = [];

    for (const accountId of accountIds) {
      try {
        const publishId = await postToTikTok(post, accountId, env);
        await env.DB.prepare(
          `UPDATE post_accounts SET tiktok_publish_id = ?, posted_at = datetime('now') WHERE post_id = ? AND account_id = ?`
        ).bind(publishId, post.id, accountId).run();
        console.log(`[Scheduler] ✅ Post ${post.id} → akun ${accountId} berhasil (publishId: ${publishId})`);
      } catch (err) {
        allSuccess = false;
        errors.push(`Akun ${accountId}: ${err.message}`);
        console.error(`[Scheduler] ❌ Post ${post.id} → akun ${accountId} gagal:`, err.message);
      }
    }

    const finalStatus = allSuccess ? 'posted' : (errors.length === accountIds.length ? 'failed' : 'partial');
    await env.DB.prepare(`
      UPDATE posts SET status = ?, published_at = datetime('now'), error_message = ? WHERE id = ?
    `).bind(finalStatus, errors.join('; ') || null, post.id).run();
  }

  // Refresh token yang akan expire dalam 1 jam
  await refreshExpiringTokens(env);
}

async function postToTikTok(post, accountId, env) {
  const account = await env.DB.prepare('SELECT * FROM tiktok_accounts WHERE id = ?').bind(accountId).first();
  if (!account) throw new Error(`Akun ${accountId} tidak ditemukan`);
  if (account.status !== 'connected') throw new Error(`Akun ${accountId} tidak terhubung (status: ${account.status})`);

  // Refresh token jika hampir expire
  let token = account.access_token;
  if (account.token_expires_at < Date.now() + 300_000) {
    token = await refreshAccessToken(account, env);
  }

  if (!post.r2_url) throw new Error('Tidak ada URL video di R2');

  // Parse affiliates untuk keranjang VT
  const affiliates = JSON.parse(post.affiliates || '[]');

  // ── TikTok Content Posting API ────────────────────────────
  const body = {
    post_info: {
      title: post.caption.substring(0, 2200),
      privacy_level: 'PUBLIC_TO_EVERYONE',
      disable_duet: false,
      disable_comment: false,
      disable_stitch: false,
      video_cover_timestamp_ms: 1000,
    },
    source_info: {
      source: 'PULL_FROM_URL',
      video_url: post.r2_url,
    },
  };

  // Tambahkan music jika ada
  if (post.music_id) {
    body.post_info.music_id = post.music_id;
  }

  // Tambahkan produk affiliate (Keranjang VT) jika ada
  if (affiliates.length > 0) {
    body.post_info.brand_content_toggle = false;
    body.post_info.brand_organic_toggle = false;
    // Product links untuk Shopping Content
    body.post_info.product_ids = affiliates.map(p => p.id).slice(0, 20);
  }

  const res = await fetch('https://open.tiktokapis.com/v2/post/publish/video/init/', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=UTF-8',
    },
    body: JSON.stringify(body),
  });

  const data = await res.json();
  if (data.error?.code !== 'ok' && data.error?.code !== 'success') {
    throw new Error(`TikTok API: ${data.error?.message || JSON.stringify(data.error)}`);
  }

  return data.data?.publish_id || 'unknown';
}

async function refreshAccessToken(account, env) {
  const res = await fetch('https://open.tiktokapis.com/v2/oauth/token/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_key: env.TIKTOK_CLIENT_KEY,
      client_secret: env.TIKTOK_CLIENT_SECRET,
      grant_type: 'refresh_token',
      refresh_token: account.refresh_token,
    }),
  });
  const data = await res.json();
  if (data.error) throw new Error(`Refresh token gagal: ${data.error}`);
  await env.DB.prepare(
    `UPDATE tiktok_accounts SET access_token=?, refresh_token=?, token_expires_at=?, status='connected' WHERE id=?`
  ).bind(data.access_token, data.refresh_token, Date.now() + data.expires_in * 1000, account.id).run();
  return data.access_token;
}

async function refreshExpiringTokens(env) {
  const expiring = await env.DB.prepare(
    `SELECT * FROM tiktok_accounts WHERE token_expires_at < ? AND status = 'connected'`
  ).bind(Date.now() + 3_600_000).all();

  for (const acc of expiring.results) {
    try {
      await refreshAccessToken(acc, env);
      console.log(`[TokenRefresh] ✅ ${acc.handle}`);
    } catch (e) {
      await env.DB.prepare(`UPDATE tiktok_accounts SET status = 'expired' WHERE id = ?`).bind(acc.id).run();
      console.warn(`[TokenRefresh] ❌ ${acc.handle}: ${e.message}`);
    }
  }
}

// ── Crypto helpers ────────────────────────────────────────────
async function hashPassword(password) {
  const data = new TextEncoder().encode(password);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return btoa(String.fromCharCode(...new Uint8Array(hash)));
}
async function verifyPassword(password, hash) {
  return (await hashPassword(password)) === hash;
}
async function generateToken(bytes = 32) {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
}
