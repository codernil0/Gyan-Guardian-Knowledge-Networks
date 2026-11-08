const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const Database = require("better-sqlite3");
const jwt = require("jsonwebtoken");
const cookieParser = require("cookie-parser");
const multer = require("multer");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const UPLOAD_DIR = path.join(DATA_DIR, "uploads");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

if (!process.env.JWT_SECRET || !process.env.ADMIN_PASSWORD) {
  console.error("Set JWT_SECRET and ADMIN_PASSWORD environment variables before starting.");
  process.exit(1);
}

const db = new Database(path.join(DATA_DIR, "gyan-guardian.sqlite"));
db.pragma("journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS content (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT DEFAULT '',
    class_level TEXT NOT NULL DEFAULT 'All',
    subject TEXT DEFAULT '',
    resource_type TEXT NOT NULL DEFAULT 'note',
    file_url TEXT DEFAULT '',
    video_url TEXT DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

app.use(helmet({ crossOriginResourcePolicy: { policy: "same-site" } }));
app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());
app.use("/uploads", requireAuth, express.static(UPLOAD_DIR, { fallthrough: false }));
app.use(express.static(path.join(__dirname, "public")));

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: "draft-7", legacyHeaders: false });
const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase().slice(0, 10);
      cb(null, crypto.randomUUID() + ext);
    }
  }),
  limits: { fileSize: 100 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = /^(application\/pdf|video\/mp4|video\/webm|video\/quicktime)$/;
    cb(allowed.test(file.mimetype) ? null : new Error("Only PDF and common video files are allowed."), allowed.test(file.mimetype));
  }
});

function signToken(payload) {
  return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: "7d" });
}
function setAuthCookie(res, token) {
  res.cookie("gg_session", token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 7 * 24 * 60 * 60 * 1000
  });
}
function requireAuth(req, res, next) {
  try {
    const token = req.cookies.gg_session;
    if (!token) return res.status(401).json({ error: "Please sign in to continue." });
    req.auth = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: "Your session has expired. Please sign in again." });
  }
}
function requireAdmin(req, res, next) {
  if (req.auth?.role !== "admin") return res.status(403).json({ error: "Administrator access required." });
  next();
}
function cleanText(value, max = 500) {
  return String(value ?? "").trim().slice(0, max);
}

app.get("/api/health", (_req, res) => res.json({ status: "ok", app: "Gyan Guardian Knowledge Networks" }));

app.post("/api/register", authLimiter, async (req, res) => {
  const username = cleanText(req.body.username, 40);
  const password = String(req.body.password || "");
  if (!/^[a-zA-Z0-9_.-]{3,40}$/.test(username)) return res.status(400).json({ error: "Username must be 3–40 characters and use letters, numbers, dots, underscores or hyphens." });
  if (password.length < 8 || password.length > 128) return res.status(400).json({ error: "Password must be at least 8 characters." });
  try {
    const hash = await bcrypt.hash(password, 12);
    const result = db.prepare("INSERT INTO users (username, password_hash) VALUES (?, ?)").run(username, hash);
    setAuthCookie(res, signToken({ id: result.lastInsertRowid, username, role: "student" }));
    res.status(201).json({ user: { username, role: "student" } });
  } catch (error) {
    if (String(error.code).includes("SQLITE_CONSTRAINT")) return res.status(409).json({ error: "That username is already registered." });
    res.status(500).json({ error: "Could not create your account." });
  }
});

app.post("/api/login", authLimiter, async (req, res) => {
  const username = cleanText(req.body.username, 80);
  const password = String(req.body.password || "");
  if (username.toLowerCase() === String(process.env.ADMIN_USERNAME || "admin").toLowerCase()) {
    if (password && password === process.env.ADMIN_PASSWORD) {
      setAuthCookie(res, signToken({ username, role: "admin" }));
      return res.json({ user: { username, role: "admin" } });
    }
    return res.status(401).json({ error: "Invalid username or password." });
  }
  const user = db.prepare("SELECT * FROM users WHERE username = ? COLLATE NOCASE").get(username);
  if (!user || !(await bcrypt.compare(password, user.password_hash))) return res.status(401).json({ error: "Invalid username or password." });
  setAuthCookie(res, signToken({ id: user.id, username: user.username, role: "student" }));
  res.json({ user: { username: user.username, role: "student" } });
});

app.post("/api/logout", (_req, res) => {
  res.clearCookie("gg_session", { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax" });
  res.json({ ok: true });
});
app.get("/api/me", requireAuth, (req, res) => res.json({ user: { username: req.auth.username, role: req.auth.role } }));

app.get("/api/content", requireAuth, (req, res) => {
  const level = cleanText(req.query.class, 30);
  const rows = level && level !== "All"
    ? db.prepare("SELECT * FROM content WHERE class_level IN (?, 'All') ORDER BY created_at DESC").all(level)
    : db.prepare("SELECT * FROM content ORDER BY created_at DESC").all();
  res.json({ content: rows });
});

app.post("/api/content", requireAuth, requireAdmin, (req, res) => {
  const title = cleanText(req.body.title, 160);
  if (!title) return res.status(400).json({ error: "A title is required." });
  const values = [
    title, cleanText(req.body.description, 2000), cleanText(req.body.class_level, 30) || "All",
    cleanText(req.body.subject, 80), cleanText(req.body.resource_type, 20) || "note",
    cleanText(req.body.file_url, 500), cleanText(req.body.video_url, 500)
  ];
  const info = db.prepare("INSERT INTO content (title, description, class_level, subject, resource_type, file_url, video_url) VALUES (?, ?, ?, ?, ?, ?, ?)").run(...values);
  res.status(201).json({ item: db.prepare("SELECT * FROM content WHERE id = ?").get(info.lastInsertRowid) });
});

app.put("/api/content/:id", requireAuth, requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const title = cleanText(req.body.title, 160);
  if (!Number.isInteger(id) || !title) return res.status(400).json({ error: "Valid content ID and title are required." });
  const result = db.prepare(`UPDATE content SET title=?, description=?, class_level=?, subject=?, resource_type=?, file_url=?, video_url=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(title, cleanText(req.body.description, 2000), cleanText(req.body.class_level, 30) || "All", cleanText(req.body.subject, 80), cleanText(req.body.resource_type, 20) || "note", cleanText(req.body.file_url, 500), cleanText(req.body.video_url, 500), id);
  if (!result.changes) return res.status(404).json({ error: "Resource not found." });
  res.json({ item: db.prepare("SELECT * FROM content WHERE id = ?").get(id) });
});

app.delete("/api/content/:id", requireAuth, requireAdmin, (req, res) => {
  const result = db.prepare("DELETE FROM content WHERE id = ?").run(Number(req.params.id));
  if (!result.changes) return res.status(404).json({ error: "Resource not found." });
  res.json({ ok: true });
});

app.post("/api/upload", requireAuth, requireAdmin, upload.single("resource"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Choose a PDF or video file." });
  res.status(201).json({ url: "/uploads/" + req.file.filename, originalName: req.file.originalname, mimeType: req.file.mimetype });
});

app.use((err, _req, res, _next) => {
  console.error(err.message);
  res.status(err instanceof multer.MulterError ? 400 : 500).json({ error: err.message || "Server error." });
});

app.listen(PORT, () => console.log(`Gyan Guardian running on port ${PORT}`));
