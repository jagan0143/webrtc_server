import 'dotenv/config';

const required = ['MONGODB_URI', 'JWT_SECRET'];
const missing = required.filter((key) => !process.env[key]);
if (missing.length) {
  console.error(`Missing environment variables: ${missing.join(', ')}`);
  console.error('Copy webrtc_server/.env.example to webrtc_server/.env and fill in the values.');
  process.exit(1);
}

const list = (value, fallback = '') =>
  (value ?? fallback)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

export const env = {
  port: Number(process.env.PORT) || 5050,
  mongoUri: process.env.MONGODB_URI,
  jwtSecret: process.env.JWT_SECRET,
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',
  clientOrigins: list(process.env.CLIENT_ORIGIN, 'http://localhost:5173'),
  ringTimeoutMs: Number(process.env.RING_TIMEOUT_MS) || 30_000,
  stunUrls: list(process.env.STUN_URLS, 'stun:stun.l.google.com:19302'),
  turn: {
    url: process.env.TURN_URL?.trim() || '',
    username: process.env.TURN_USERNAME?.trim() || '',
    credential: process.env.TURN_CREDENTIAL?.trim() || '',
  },
};

export function iceServers() {
  const servers = [];
  if (env.stunUrls.length) servers.push({ urls: env.stunUrls });
  if (env.turn.url) {
    servers.push({
      urls: list(env.turn.url),
      username: env.turn.username,
      credential: env.turn.credential,
    });
  }
  return servers;
}
