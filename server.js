
const express = require("express");
const http = require("http");
const path = require("path");
const session = require("express-session");
const SQLiteStore = require("connect-sqlite3")(session);
const bcrypt = require("bcryptjs");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const { Server } = require("socket.io");
const sqlite3 = require("sqlite3").verbose();
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const db = new sqlite3.Database("./messenger.db");

app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const sessionMiddleware = session({
  store: new SQLiteStore({ db: "sessions.db" }),
  secret: process.env.SESSION_SECRET || "change-this-secret-before-deploying",
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 7 * 24 * 60 * 60 * 1000
  }
});

app.use(sessionMiddleware);
io.engine.use(sessionMiddleware);

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS lobbies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    code TEXT UNIQUE NOT NULL,
    owner_id INTEGER NOT NULL
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS members (
    lobby_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    UNIQUE(lobby_id, user_id)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lobby_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    username TEXT NOT NULL,
    text TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false
});

function requireAuth(req, res, next) {
  if (!req.session.user) {
    return res.status(401).json({ error: "ابتدا وارد حساب شو." });
  }
  next();
}

function generateCode() {
  return crypto.randomBytes(4).toString("hex").slice(0, 6).toUpperCase();
}

app.post("/api/register", authLimiter, async (req, res) => {
  const { username, password } = req.body || {};

  if (
    typeof username !== "string" ||
    typeof password !== "string" ||
    !/^[a-zA-Z0-9_]{3,20}$/.test(username) ||
    password.length < 8 ||
    password.length > 72
  ) {
    return res.status(400).json({
      error: "نام کاربری باید ۳ تا ۲۰ کاراکتر و رمز حداقل ۸ کاراکتر باشد."
    });
  }

  try {
    const hash = await bcrypt.hash(password, 12);

    db.run(
      "INSERT INTO users (username, password) VALUES (?, ?)",
      [username, hash],
      function (err) {
        if (err) {
          return res.status(409).json({
            error: "این نام کاربری قبلاً ثبت شده."
          });
        }

        req.session.user = {
          id: this.lastID,
          username
        };

        req.session.save(() => {
          res.json({ user: req.session.user });
        });
      }
    );
  } catch {
    res.status(500).json({ error: "خطای سرور." });
  }
});

app.post("/api/login", authLimiter, (req, res) => {
  const { username, password } = req.body || {};

  if (typeof username !== "string" || typeof password !== "string") {
    return res.status(400).json({ error: "اطلاعات ورود نامعتبر است." });
  }

  db.get(
    "SELECT * FROM users WHERE username = ?",
    [username],
    async (err, user) => {
      if (err) return res.status(500).json({ error: "خطای سرور." });

      if (!user || !(await bcrypt.compare(password, user.password))) {
        return res.status(401).json({
          error: "نام کاربری یا رمز اشتباه است."
        });
      }

      req.session.regenerate((sessionErr) => {
        if (sessionErr) {
          return res.status(500).json({ error: "خطای نشست کاربری." });
        }

        req.session.user = {
          id: user.id,
          username: user.username
        };

        req.session.save(() => {
          res.json({ user: req.session.user });
        });
      });
    }
  );
});

app.post("/api/logout", requireAuth, (req, res) => {
  req.session.destroy(() => {
    res.clearCookie("connect.sid");
    res.json({ ok: true });
  });
});

app.get("/api/me", (req, res) => {
  res.json({ user: req.session.user || null });
});

app.get("/api/lobbies", requireAuth, (req, res) => {
  db.all(
    `SELECT l.id, l.name, l.code, l.owner_id
     FROM lobbies l
     JOIN members m ON m.lobby_id = l.id
     WHERE m.user_id = ?
     ORDER BY l.id DESC`,
    [req.session.user.id],
    (err, rows) => {
      if (err) return res.status(500).json({ error: "خطای سرور." });
      res.json({ lobbies: rows });
    }
  );
});

app.post("/api/lobbies", requireAuth, (req, res) => {
  let name = req.body?.name;

  if (typeof name !== "string" || !name.trim()) {
    return res.status(400).json({ error: "اسم لابی را وارد کن." });
  }

  name = name.trim().slice(0, 40);
  const user = req.session.user;
  const code = generateCode();

  db.run(
    "INSERT INTO lobbies (name, code, owner_id) VALUES (?, ?, ?)",
    [name, code, user.id],
    function (err) {
      if (err) return res.status(500).json({ error: "ساخت لابی ناموفق بود." });

      const lobbyId = this.lastID;

      db.run(
        "INSERT INTO members (lobby_id, user_id) VALUES (?, ?)",
        [lobbyId, user.id],
        (memberErr) => {
          if (memberErr) {
            return res.status(500).json({ error: "خطای عضویت در لابی." });
          }

          res.json({
            lobby: {
              id: lobbyId,
              name,
              code,
              owner_id: user.id
            }
          });
        }
      );
    }
  );
});

app.post("/api/lobbies/join", requireAuth, (req, res) => {
  const code = String(req.body?.code || "").trim().toUpperCase();

  if (!/^[A-F0-9]{6}$/.test(code)) {
    return res.status(400).json({ error: "کد لابی معتبر نیست." });
  }

  db.get(
    "SELECT * FROM lobbies WHERE code = ?",
    [code],
    (err, lobby) => {
      if (err) return res.status(500).json({ error: "خطای سرور." });
      if (!lobby) return res.status(404).json({ error: "لابی پیدا نشد." });

      db.run(
        "INSERT OR IGNORE INTO members (lobby_id, user_id) VALUES (?, ?)",
        [lobby.id, req.session.user.id],
        (memberErr) => {
          if (memberErr) {
            return res.status(500).json({ error: "عضویت ناموفق بود." });
          }

          res.json({ lobby });
        }
      );
    }
  );
});

function checkMembership(lobbyId, userId, callback) {
  db.get(
    "SELECT 1 FROM members WHERE lobby_id = ? AND user_id = ?",
    [lobbyId, userId],
    (err, row) => callback(!err && Boolean(row))
  );
}

io.on("connection", (socket) => {
  const user = socket.request.session.user;

  if (!user) {
    socket.disconnect(true);
    return;
  }

  socket.on("join-lobby", (lobbyId, callback) => {
    lobbyId = Number(lobbyId);

    if (!Number.isInteger(lobbyId) || lobbyId < 1) {
      return callback?.({ error: "لابی نامعتبر است." });
    }

    checkMembership(lobbyId, user.id, (allowed) => {
      if (!allowed) {
        return callback?.({ error: "عضو این لابی نیستی." });
      }

      socket.join(`lobby-${lobbyId}`);

      db.all(
        `SELECT username, text, created_at
         FROM messages WHERE lobby_id = ?
         ORDER BY id DESC LIMIT 50`,
        [lobbyId],
        (err, rows) => {
          if (err) return callback?.({ error: "دریافت پیام‌ها ناموفق بود." });

          callback?.({
            messages: rows.reverse()
          });
        }
      );
    });
  });

  socket.on("send-message", (data, callback) => {
    const lobbyId = Number(data?.lobbyId);
    const message = typeof data?.text === "string" ? data.text.trim() : "";

    if (!Number.isInteger(lobbyId) || lobbyId < 1 || !message || message.length > 1000) {
      return callback?.({ error: "پیام نامعتبر است." });
    }

    checkMembership(lobbyId, user.id, (allowed) => {
      if (!allowed) {
        return callback?.({ error: "اجازه ارسال پیام نداری." });
      }

      db.run(
        `INSERT INTO messages (lobby_id, user_id, username, text)
         VALUES (?, ?, ?, ?)`,
        [lobbyId, user.id, user.username, message],
        function (err) {
          if (err) return callback?.({ error: "ارسال پیام ناموفق بود." });

          const payload = {
            id: this.lastID,
            username: user.username,
            text: message,
            created_at: new Date().toISOString()
          };

          io.to(`lobby-${lobbyId}`).emit("new-message", payload);
          callback?.({ ok: true });
        }
      );
    });
  });
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(`Messenger running at http://localhost:${PORT}`);
});
