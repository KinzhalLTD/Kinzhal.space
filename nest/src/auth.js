// Who is calling, and what may they do?
// Every API call carries a Firebase ID token (Authorization: Bearer …). The token is verified with the Firebase Admin SDK,
// including the revocation check, and the caller must be a verified-email member of the workspace.
import { db, admin } from './db.js';

let authImpl = null;
export const useAuth = a => { authImpl = a; return a; };
async function auth() {
  if (authImpl) return authImpl;
  const { getAuth } = await import('firebase-admin/auth');
  authImpl = getAuth(await admin());
  return authImpl;
}

export const ROLES = ['owner', 'editor', 'viewer'];
const RANK = { viewer: 1, editor: 2, owner: 3 };
export const can = (member, need) => !!member && (RANK[member.role] || 0) >= (RANK[need] || 99);

export class HttpError extends Error { constructor(status, code, message) { super(message || code); this.status = status; this.code = code; } }

const normEmail = e => String(e || '').trim().toLowerCase();
export const ownerEmail = () => normEmail(process.env.OWNER_EMAIL);
export const emailKey = e => normEmail(e).replace(/[^a-z0-9@._+-]/g, '_');

/** Verify the bearer token. Returns the decoded token. */
export async function verify(req) {
  const h = req.headers.get('authorization') || '';
  const m = h.match(/^Bearer\s+([\w-]+\.[\w-]+\.[\w-]+)$/);
  if (!m) throw new HttpError(401, 'signed_out', 'Please sign in');
  let t;
  try { t = await (await auth()).verifyIdToken(m[1], true); } // true = reject revoked sessions ("Sign out everywhere")
  catch (e) {
    const revoked = /revoked/i.test(e.code || e.message || '');
    throw new HttpError(401, revoked ? 'revoked' : 'signed_out', revoked ? 'This session was signed out. Please sign in again.' : 'Your session expired. Please sign in again.');
  }
  if (!t.email || t.email_verified !== true) throw new HttpError(403, 'verify_email', 'Verify your email address first');
  return t;
}

/**
 * The caller's membership. Creates it on first sign-in for the owner (OWNER_EMAIL) and for invited emails.
 * Throws 403 for anyone else.
 */
export async function member(t, { bootstrap = false } = {}) {
  const path = `members/${t.uid}`;
  let m = await db().get(path);
  if (!m && bootstrap) {
    const email = normEmail(t.email);
    if (!ownerEmail()) throw new HttpError(500, 'no_owner', 'Set OWNER_EMAIL in Netlify environment variables');
    if (email === ownerEmail()) {
      m = { uid: t.uid, email, role: 'owner', joinedAt: new Date().toISOString(), revokedAt: 0 };
      await db().set(path, m);
    } else {
      m = await db().tx(async x => {
        const inv = await x.get(`invites/${emailKey(email)}`);
        if (!inv) return null;
        if (inv.expires && Date.parse(inv.expires) < Date.now()) { await x.del(`invites/${emailKey(email)}`); return null; }
        const team = (await x.get('team/settings')) || {};
        const nm = { uid: t.uid, email, role: ROLES.includes(inv.role) && inv.role !== 'owner' ? inv.role : 'viewer', invitedBy: inv.by || '', joinedAt: new Date().toISOString(), revokedAt: 0, mfa: !!team.requireMfa };
        await x.set(path, nm);
        await x.del(`invites/${emailKey(email)}`);
        return nm;
      });
    }
  }
  if (!m) throw new HttpError(403, 'not_invited', 'This account has not been invited to Kinzhal Nest. Ask the owner for an invite.');
  if (m.disabled) throw new HttpError(403, 'disabled', 'Your access was removed by the owner.');
  if (m.revokedAt && (t.auth_time || 0) <= m.revokedAt) throw new HttpError(401, 'revoked', 'This session was signed out. Please sign in again.');
  const team = (await db().get('team/settings')) || {};
  const hasMfa = !!t.firebase?.sign_in_second_factor;
  if (team.requireMfa && !hasMfa) throw new HttpError(403, 'mfa_required', 'Your workspace requires 2-step verification. Turn it on in Account, then sign in again.');
  return { ...m, mfaActive: hasMfa };
}

/** Verify + membership + role in one call. */
export async function requireRole(req, need = 'viewer') {
  const t = await verify(req);
  const m = await member(t);
  if (!can(m, need)) throw new HttpError(403, 'forbidden', `This needs the ${need} role`);
  return { t, m };
}

/** Sign out everywhere: revoke refresh tokens and reject older ID tokens in the API and in Firestore rules. */
export async function revokeAll(uid) {
  await (await auth()).revokeRefreshTokens(uid);
  const now = Math.floor(Date.now() / 1000);
  const m = await db().get(`members/${uid}`);
  if (m) await db().set(`members/${uid}`, { revokedAt: now }, { merge: true });
  return now;
}

export async function authUser(uid) { try { return await (await auth()).getUser(uid); } catch { return null; } }
