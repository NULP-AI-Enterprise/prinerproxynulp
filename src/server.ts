import http from "http";
import https from "https";
import path from "path";
import fs from "fs";

import express, { Request, Response, NextFunction } from "express";
import session from "express-session";
import httpProxy from "http-proxy";

// ---------------------------------------------------------------------------
// Config — fail fast in production if required secrets are absent
// ---------------------------------------------------------------------------
function requireEnv(name: string, fallback?: string): string {
  const val = process.env[name] ?? fallback;
  if (!val) {
    console.error(`[printer-proxy] FATAL: environment variable ${name} is not set`);
    process.exit(1);
  }
  return val;
}

const PORT = parseInt(process.env.PORT ?? "3000", 10);
const IS_PROD = process.env.NODE_ENV === "production";

const USERNAME       = requireEnv("AUTH_USERNAME",  IS_PROD ? undefined : "admin");
const PASSWORD       = requireEnv("AUTH_PASSWORD",  IS_PROD ? undefined : "changeme");
const SESSION_SECRET = requireEnv("SESSION_SECRET", IS_PROD ? undefined : "dev-secret-change-me");
const UPSTREAM_HOST = process.env.UPSTREAM_HOST ?? "192.168.1.177";
const UPSTREAM_FLUIDD_PORT = parseInt(process.env.UPSTREAM_PORT ?? "4409", 10);
const UPSTREAM_MOONRAKER_PORT = parseInt(process.env.MOONRAKER_PORT ?? "7125", 10);
const TRUST_PROXY = process.env.TRUST_PROXY === "true";

console.log(`[printer-proxy] auth username : "${USERNAME}"`);
console.log(`[printer-proxy] trust proxy   : ${TRUST_PROXY}`);

const FLUIDD_TARGET = `http://${UPSTREAM_HOST}:${UPSTREAM_FLUIDD_PORT}`;
const MOONRAKER_TARGET = `http://${UPSTREAM_HOST}:${UPSTREAM_MOONRAKER_PORT}`;

// ---------------------------------------------------------------------------
// Proxy instances
// ---------------------------------------------------------------------------

// Main proxy for Fluidd UI (HTTP + WS)
const fluiddProxy = httpProxy.createProxyServer({
  target: FLUIDD_TARGET,
  ws: true,
  changeOrigin: true,
  // Keep the connection alive; Fluidd polls aggressively
  proxyTimeout: 0,
  timeout: 0,
});

// Separate proxy for Moonraker JSON-RPC WebSocket / REST API
const moonrakerProxy = httpProxy.createProxyServer({
  target: MOONRAKER_TARGET,
  ws: true,
  changeOrigin: true,
  proxyTimeout: 0,
  timeout: 0,
});

// Forward proxy errors as 502 so the browser shows a meaningful error
// instead of hanging.
fluiddProxy.on("error", (err, _req, res) => {
  console.error("[fluidd proxy error]", err.message);
  if (res instanceof http.ServerResponse && !res.headersSent) {
    res.writeHead(502, { "Content-Type": "text/plain" });
    res.end("Bad Gateway — upstream unreachable");
  }
});

moonrakerProxy.on("error", (err, _req, res) => {
  console.error("[moonraker proxy error]", err.message);
  if (res instanceof http.ServerResponse && !res.headersSent) {
    res.writeHead(502, { "Content-Type": "text/plain" });
    res.end("Bad Gateway — Moonraker unreachable");
  }
});

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------
const app = express();

if (TRUST_PROXY) app.set("trust proxy", 1);

app.use(express.urlencoded({ extended: false }));
app.use(express.json());

app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      // secure: false — TLS is terminated at Cloudflare, not at the pod.
      // Setting this to true with HTTP-only ingress causes the browser to
      // silently drop the cookie, making every request look unauthenticated.
      secure: false,
      sameSite: "lax",
      maxAge: 8 * 60 * 60 * 1000, // 8 hours
    },
  })
);

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------
declare module "express-session" {
  interface SessionData {
    authenticated: boolean;
  }
}

function isAuthenticated(req: Request): boolean {
  return req.session.authenticated === true;
}

function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (isAuthenticated(req)) return next();
  // Preserve the originally-requested URL for post-login redirect
  const returnTo = encodeURIComponent(req.originalUrl);
  res.redirect(`/login?returnTo=${returnTo}`);
}

// ---------------------------------------------------------------------------
// Auth routes
// ---------------------------------------------------------------------------
const LOGIN_HTML = fs.readFileSync(
  path.join(__dirname, "views", "login.html"),
  "utf8"
);

app.get("/login", (_req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(LOGIN_HTML);
});

app.post("/login", (req: Request, res: Response) => {
  const { username, password } = req.body as { username?: string; password?: string };
  const returnTo = typeof req.query.returnTo === "string" ? req.query.returnTo : "/";
  const ip = req.ip ?? req.socket.remoteAddress;

  if (username === USERNAME && password === PASSWORD) {
    console.log(`[printer-proxy] login OK  — user="${username}" ip=${ip}`);
    req.session.authenticated = true;
    req.session.regenerate((err) => {
      if (err) console.error("session regenerate error:", err);
      req.session.authenticated = true;
      res.redirect(returnTo.startsWith("/") ? returnTo : "/");
    });
  } else {
    console.warn(`[printer-proxy] login FAIL — user="${username}" ip=${ip} (wrong credentials)`);
    res.status(401).setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(LOGIN_HTML.replace("<!--ERROR-->", errorFragment("Invalid credentials")));
  }
});

app.post("/logout", (req: Request, res: Response) => {
  req.session.destroy(() => {
    res.redirect("/login");
  });
});

function errorFragment(msg: string): string {
  return `<p class="error-msg" role="alert">${msg}</p>`;
}

// ---------------------------------------------------------------------------
// Moonraker path matcher
// Fluidd loads from the proxy origin and calls Moonraker at these standard
// paths on the SAME origin. Every one must be forwarded to port 7125.
// Reference: https://moonraker.readthedocs.io/en/latest/web_api/
// ---------------------------------------------------------------------------
const MOONRAKER_PREFIXES = [
  "/websocket",       // Moonraker JSON-RPC WebSocket
  "/api",             // Octoprint-compatible REST
  "/server",          // Server management
  "/access",          // API key / auth
  "/machine",         // Machine / OS control
  "/printer",         // Printer status & control
  "/klippy_connection",
];

function isMoonrakerPath(url: string): boolean {
  return MOONRAKER_PREFIXES.some(
    (p) => url === p || url.startsWith(p + "/") || url.startsWith(p + "?")
  );
}

// ---------------------------------------------------------------------------
// Proxied routes — all behind requireAuth
// ---------------------------------------------------------------------------

// Standard Moonraker API paths — forwarded to port 7125 as-is
app.use(MOONRAKER_PREFIXES, requireAuth, (req, res) => {
  console.log(`[proxy → moonraker] ${req.method} ${req.url}`);
  moonrakerProxy.web(req, res);
});

// Everything else (Fluidd static assets, SPA) → port 4409
app.use("/", requireAuth, (req, res) => {
  fluiddProxy.web(req, res);
});

// ---------------------------------------------------------------------------
// HTTP server — must be a raw http.Server so we can intercept upgrades
// ---------------------------------------------------------------------------
const server = http.createServer(app);

// ---------------------------------------------------------------------------
// WebSocket upgrade handling
// Express never sees Upgrade requests — attach directly to the raw server.
// We gate on the signed connect.sid cookie (unforgeable without SESSION_SECRET).
// ---------------------------------------------------------------------------
server.on("upgrade", (req: http.IncomingMessage, socket: import("net").Socket, head: Buffer) => {
  const cookieHeader = req.headers.cookie ?? "";

  if (!cookieHeader.includes("connect.sid")) {
    console.warn(`[ws] rejected unauthenticated upgrade: ${req.url}`);
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }

  const url = req.url ?? "/";
  console.log(`[ws] upgrade → ${isMoonrakerPath(url) ? "moonraker" : "fluidd"} : ${url}`);

  if (isMoonrakerPath(url)) {
    moonrakerProxy.ws(req, socket, head);
  } else {
    fluiddProxy.ws(req, socket, head);
  }
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
server.listen(PORT, () => {
  console.log(`[printer-proxy] listening on port ${PORT}`);
  console.log(`[printer-proxy] upstream Fluidd  → ${FLUIDD_TARGET}`);
  console.log(`[printer-proxy] upstream Moonraker → ${MOONRAKER_TARGET}`);
});

// Graceful shutdown
process.on("SIGTERM", () => {
  server.close(() => process.exit(0));
});
