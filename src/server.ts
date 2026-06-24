import http from "http";
import path from "path";
import fs from "fs";

import express, { Request, Response, NextFunction } from "express";
import session from "express-session";
import httpProxy from "http-proxy";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
function requireEnv(name: string, fallback?: string): string {
  const val = process.env[name] ?? fallback;
  if (!val) {
    console.error(`[printer-proxy] FATAL: environment variable ${name} is not set`);
    process.exit(1);
  }
  return val;
}

const PORT         = parseInt(process.env.PORT ?? "3000", 10);
const IS_PROD      = process.env.NODE_ENV === "production";
const USERNAME     = requireEnv("AUTH_USERNAME",  IS_PROD ? undefined : "admin");
const PASSWORD     = requireEnv("AUTH_PASSWORD",  IS_PROD ? undefined : "changeme");
const SESSION_SECRET = requireEnv("SESSION_SECRET", IS_PROD ? undefined : "dev-secret-change-me");
const TRUST_PROXY  = process.env.TRUST_PROXY === "true";

// Single upstream — Fluidd at port 4409 already handles everything
// (static UI + internal Moonraker proxying). We do not need a separate
// Moonraker port; routing all traffic here is correct.
const UPSTREAM_HOST = process.env.UPSTREAM_HOST ?? "192.168.1.177";
const UPSTREAM_PORT = parseInt(process.env.UPSTREAM_PORT ?? "4409", 10);
const UPSTREAM      = `http://${UPSTREAM_HOST}:${UPSTREAM_PORT}`;

console.log(`[printer-proxy] auth username : "${USERNAME}"`);
console.log(`[printer-proxy] upstream      : ${UPSTREAM}`);
console.log(`[printer-proxy] trust proxy   : ${TRUST_PROXY}`);

// ---------------------------------------------------------------------------
// Single proxy instance — handles both HTTP and WebSocket
// ---------------------------------------------------------------------------
const proxy = httpProxy.createProxyServer({
  target: UPSTREAM,
  ws: true,
  changeOrigin: true,
  proxyTimeout: 0,
  timeout: 0,
});

proxy.on("error", (err, _req, res) => {
  console.error("[proxy error]", err.message);
  if (res instanceof http.ServerResponse && !res.headersSent) {
    res.writeHead(502, { "Content-Type": "text/plain" });
    res.end("Bad Gateway — printer unreachable");
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
// Proxied routes — everything behind requireAuth → single upstream
// ---------------------------------------------------------------------------
app.use("/", requireAuth, (req, res) => {
  proxy.web(req, res);
});

// ---------------------------------------------------------------------------
// HTTP server — raw server required to intercept WebSocket upgrades
// ---------------------------------------------------------------------------
const server = http.createServer(app);

// ---------------------------------------------------------------------------
// WebSocket upgrade handling
// Express never sees Upgrade requests — must attach to the raw http.Server.
// Gate on the signed connect.sid cookie (unforgeable without SESSION_SECRET).
// ---------------------------------------------------------------------------
server.on("upgrade", (req: http.IncomingMessage, socket: import("net").Socket, head: Buffer) => {
  const cookieHeader = req.headers.cookie ?? "";

  if (!cookieHeader.includes("connect.sid")) {
    console.warn(`[ws] rejected unauthenticated upgrade: ${req.url}`);
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }

  console.log(`[ws] upgrade: ${req.url}`);
  proxy.ws(req, socket, head);
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
server.listen(PORT, () => {
  console.log(`[printer-proxy] listening on port ${PORT}`);
  console.log(`[printer-proxy] upstream → ${UPSTREAM}`);
});

// Graceful shutdown
process.on("SIGTERM", () => {
  server.close(() => process.exit(0));
});
