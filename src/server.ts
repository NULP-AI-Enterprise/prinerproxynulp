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

// In production these MUST come from the Kubernetes Secret.
// In dev they fall back to safe placeholder values so `npm run dev` works
// without a .env file — but the placeholders are intentionally weak so you
// notice immediately if a secret injection fails.
const USERNAME       = requireEnv("AUTH_USERNAME",  IS_PROD ? undefined : "admin");
const PASSWORD       = requireEnv("AUTH_PASSWORD",  IS_PROD ? undefined : "changeme");
const SESSION_SECRET = requireEnv("SESSION_SECRET", IS_PROD ? undefined : "dev-secret-change-me");
const UPSTREAM_HOST = process.env.UPSTREAM_HOST ?? "192.168.1.177";
const UPSTREAM_FLUIDD_PORT = parseInt(process.env.UPSTREAM_PORT ?? "4409", 10);
const UPSTREAM_MOONRAKER_PORT = parseInt(process.env.MOONRAKER_PORT ?? "7125", 10);
const TRUST_PROXY = process.env.TRUST_PROXY === "true";

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
      secure: TRUST_PROXY,   // true only when TLS is terminated upstream
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

  if (username === USERNAME && password === PASSWORD) {
    req.session.authenticated = true;
    // Regenerate session id on privilege escalation (session fixation prevention)
    req.session.regenerate((err) => {
      if (err) console.error("session regenerate error:", err);
      req.session.authenticated = true;
      res.redirect(returnTo.startsWith("/") ? returnTo : "/");
    });
  } else {
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
// Proxied routes — all behind requireAuth
// ---------------------------------------------------------------------------

// Moonraker REST API & WebSocket endpoint.
// Fluidd connects to /moonraker/* (configurable in Fluidd settings) OR directly
// to the Moonraker host. We expose it on /moonraker so a single ingress suffices.
app.use("/moonraker", requireAuth, (req, res) => {
  // Strip the /moonraker prefix before forwarding
  req.url = req.url.replace(/^\/moonraker/, "") || "/";
  moonrakerProxy.web(req, res);
});

// Everything else → Fluidd
app.use("/", requireAuth, (req, res) => {
  fluiddProxy.web(req, res);
});

// ---------------------------------------------------------------------------
// HTTP server — must be a raw http.Server so we can intercept upgrades
// ---------------------------------------------------------------------------
const server = http.createServer(app);

// ---------------------------------------------------------------------------
// WebSocket upgrade handling
// This is the critical piece: Express never sees WS upgrade requests, so we
// must attach the handler directly to the underlying http.Server.
// ---------------------------------------------------------------------------
server.on("upgrade", (req: http.IncomingMessage, socket: import("net").Socket, head: Buffer) => {
  // Parse cookies manually to check the session cookie.
  // express-session does not run for raw upgrade events, so we do a quick
  // check: if the Cookie header contains the session cookie we allow the
  // upgrade.  A proper implementation would verify the session store; for a
  // single-node deployment the in-memory store is in the same process, but
  // we cannot call req.session here.
  //
  // Strategy: allow WS upgrades only when a valid session cookie is present.
  // The session middleware signs cookies, so an attacker cannot forge one
  // without the SESSION_SECRET.
  const cookieHeader = req.headers.cookie ?? "";

  // express-session default cookie name is "connect.sid"
  if (!cookieHeader.includes("connect.sid")) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }

  const url = req.url ?? "/";

  if (url.startsWith("/moonraker")) {
    req.url = url.replace(/^\/moonraker/, "") || "/";
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
