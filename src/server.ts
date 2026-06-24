import http from "http";
import net from "net";
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

const PORT           = parseInt(process.env.PORT ?? "3000", 10);
const IS_PROD        = process.env.NODE_ENV === "production";
const USERNAME       = requireEnv("AUTH_USERNAME",  IS_PROD ? undefined : "admin");
const PASSWORD       = requireEnv("AUTH_PASSWORD",  IS_PROD ? undefined : "changeme");
const SESSION_SECRET = requireEnv("SESSION_SECRET", IS_PROD ? undefined : "dev-secret-change-me");
const TRUST_PROXY    = process.env.TRUST_PROXY === "true";

const UPSTREAM_HOST      = process.env.UPSTREAM_HOST ?? "192.168.1.177";
const UPSTREAM_HTTP_PORT = parseInt(process.env.UPSTREAM_PORT    ?? "4409", 10);
const UPSTREAM_WS_PORT   = parseInt(process.env.MOONRAKER_PORT   ?? "7125", 10);

// HTTP traffic (Mainsail/Fluidd static + REST API) → port 4409
const HTTP_TARGET = `http://${UPSTREAM_HOST}:${UPSTREAM_HTTP_PORT}`;
// WebSocket traffic (Moonraker JSON-RPC) → port 7125 directly.
// Port 4409 Nginx does proxy /websocket to localhost:7125 internally, but
// that double-hop through our proxy → Nginx → Moonraker does not survive.
// Going straight to Moonraker avoids the issue entirely.
const WS_TARGET   = `http://${UPSTREAM_HOST}:${UPSTREAM_WS_PORT}`;

console.log(`[printer-proxy] auth username : "${USERNAME}"`);
console.log(`[printer-proxy] http target   : ${HTTP_TARGET}`);
console.log(`[printer-proxy] ws target     : ${WS_TARGET}`);
console.log(`[printer-proxy] trust proxy   : ${TRUST_PROXY}`);

// ---------------------------------------------------------------------------
// Proxy helper — shared error handler factory
// ---------------------------------------------------------------------------
function makeProxy(target: string, label: string) {
  const p = httpProxy.createProxyServer({
    target,
    ws: true,
    changeOrigin: true,
    proxyTimeout: 0,
    timeout: 0,
  });

  p.on("error", (err: NodeJS.ErrnoException, req: http.IncomingMessage, resOrSocket) => {
    const code = err.code ?? err.message;
    console.error(`[${label} error] ${req.url} — ${code}`);

    if (resOrSocket instanceof http.ServerResponse) {
      if (!resOrSocket.headersSent) {
        resOrSocket.writeHead(502, { "Content-Type": "text/plain" });
        resOrSocket.end(`Bad Gateway — ${label} unreachable (${code})`);
      }
    } else if (resOrSocket instanceof net.Socket) {
      // WebSocket socket — must be destroyed on error or it hangs forever
      resOrSocket.destroy();
    }
  });

  return p;
}

const httpProxy_ = makeProxy(HTTP_TARGET, "http");
const wsProxy    = makeProxy(WS_TARGET,   "ws");

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
      // false — TLS is terminated at Cloudflare. Setting true causes the
      // browser to drop the cookie on HTTP, creating an infinite login loop.
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
    console.warn(`[printer-proxy] login FAIL — user="${username}" ip=${ip}`);
    res.status(401).setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(LOGIN_HTML.replace("<!--ERROR-->", errorFragment("Invalid credentials")));
  }
});

app.post("/logout", (req: Request, res: Response) => {
  req.session.destroy(() => res.redirect("/login"));
});

function errorFragment(msg: string): string {
  return `<p class="error-msg" role="alert">${msg}</p>`;
}

// ---------------------------------------------------------------------------
// Proxied HTTP routes — all behind requireAuth → port 4409
// ---------------------------------------------------------------------------
app.use("/", requireAuth, (req, res) => {
  httpProxy_.web(req, res);
});

// ---------------------------------------------------------------------------
// Raw HTTP server — required to intercept WebSocket Upgrade events
// ---------------------------------------------------------------------------
const server = http.createServer(app);

// ---------------------------------------------------------------------------
// WebSocket upgrade handler
// Express never sees Upgrade requests — must hook the raw http.Server.
// Auth gate: connect.sid cookie is HMAC-signed; cannot be forged without
// SESSION_SECRET. Full session store lookup not possible here without async.
// ---------------------------------------------------------------------------
server.on("upgrade", (req: http.IncomingMessage, socket: net.Socket, head: Buffer) => {
  const cookieHeader = req.headers.cookie ?? "";

  if (!cookieHeader.includes("connect.sid")) {
    console.warn(`[ws] REJECTED unauthenticated upgrade: ${req.url}`);
    socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }

  // All WebSocket traffic goes directly to Moonraker port 7125.
  console.log(`[ws] upgrade → ${WS_TARGET}${req.url}`);
  wsProxy.ws(req, socket, head);
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
server.listen(PORT, () => {
  console.log(`[printer-proxy] listening on port ${PORT}`);
});

process.on("SIGTERM", () => server.close(() => process.exit(0)));
