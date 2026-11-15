// Kinzhal Nest · Firebase adapter (loaded only on the Netlify site).
// Gives the app a small, testable surface: window.__knFbResolve(adapter).
const V = '10.14.1';
const base = `https://www.gstatic.com/firebasejs/${V}/`;

async function boot() {
  const cfgRes = await fetch('/api/config', { cache: 'no-store' });
  const cfg = await cfgRes.json().catch(() => ({}));
  if (!cfgRes.ok || !cfg.ready) return { ok: false, missing: cfg.missing || ['/api/config did not respond'] };

  const [{ initializeApp }, A, F] = await Promise.all([
    import(base + 'firebase-app.js'), import(base + 'firebase-auth.js'), import(base + 'firebase-firestore.js')
  ]);
  const app = initializeApp(cfg.firebase);
  const auth = A.getAuth(app);
  auth.useDeviceLanguage();
  const fs = F.getFirestore(app);
  let resolver = null, totpSecret = null;

  // Email links come back to this site; if the domain is not in Firebase's authorized list, send the plain email instead.
  const withContinue = async (fn) => { try { return await fn({ url: location.origin + '/' }); } catch (e) { if (/unauthorized-continue-uri|invalid-continue-uri|missing-continue-uri/.test(e.code || '')) return fn(undefined); throw e; } };
  const userOut = u => u && { uid: u.uid, email: u.email, emailVerified: u.emailVerified };
  const mfaFactors = () => A.multiFactor(auth.currentUser).enrolledFactors.map(f => ({ uid: f.uid, name: f.displayName || 'Authenticator app', factorId: f.factorId, at: f.enrollmentTime }));

  return {
    ok: true,
    projectId: cfg.firebase.projectId,
    user: () => userOut(auth.currentUser),
    onUser: cb => A.onIdTokenChanged(auth, u => cb(userOut(u))),
    async signIn(email, password, remember) {
      await A.setPersistence(auth, remember ? A.browserLocalPersistence : A.browserSessionPersistence);
      try { await A.signInWithEmailAndPassword(auth, email, password); return { ok: true }; }
      catch (e) {
        if (e.code === 'auth/multi-factor-auth-required') {
          resolver = A.getMultiFactorResolver(auth, e);
          const hint = resolver.hints.find(h => h.factorId === A.TotpMultiFactorGenerator.FACTOR_ID) || resolver.hints[0];
          return { ok: false, mfa: true, hint: hint?.displayName || 'Authenticator app' };
        }
        throw e;
      }
    },
    async mfaSignIn(code) {
      if (!resolver) throw Object.assign(new Error('Sign in again'), { code: 'auth/missing-multi-factor-session' });
      const hint = resolver.hints.find(h => h.factorId === A.TotpMultiFactorGenerator.FACTOR_ID);
      if (!hint) throw Object.assign(new Error('Unsupported second factor'), { code: 'auth/unsupported-first-factor' });
      const assertion = A.TotpMultiFactorGenerator.assertionForSignIn(hint.uid, code);
      await resolver.resolveSignIn(assertion); resolver = null;
    },
    async signUp(email, password) {
      await A.setPersistence(auth, A.browserSessionPersistence);
      const c = await A.createUserWithEmailAndPassword(auth, email, password);
      await withContinue(o => A.sendEmailVerification(c.user, o));
    },
    sendVerify: () => withContinue(o => A.sendEmailVerification(auth.currentUser, o)),
    async reload() { await auth.currentUser?.reload(); if (auth.currentUser) await auth.currentUser.getIdToken(true); return !!auth.currentUser?.emailVerified; },
    reset: email => withContinue(o => A.sendPasswordResetEmail(auth, email, o)),
    signOut: () => A.signOut(auth),
    token: (force = false) => auth.currentUser ? auth.currentUser.getIdToken(force) : Promise.resolve(''),
    async changePassword(current, next) {
      const u = auth.currentUser;
      await A.reauthenticateWithCredential(u, A.EmailAuthProvider.credential(u.email, current));
      await A.updatePassword(u, next);
    },
    async reauth(current) { const u = auth.currentUser; await A.reauthenticateWithCredential(u, A.EmailAuthProvider.credential(u.email, current)); },
    mfaFactors,
    async totpStart() {
      const session = await A.multiFactor(auth.currentUser).getSession();
      totpSecret = await A.TotpMultiFactorGenerator.generateSecret(session);
      return { secret: totpSecret.secretKey, uri: totpSecret.generateQrCodeUrl(auth.currentUser.email, 'Kinzhal Nest') };
    },
    async totpFinish(code, name = 'Authenticator app') {
      if (!totpSecret) throw new Error('Start again');
      const assertion = A.TotpMultiFactorGenerator.assertionForEnrollment(totpSecret, code);
      await A.multiFactor(auth.currentUser).enroll(assertion, name); totpSecret = null;
    },
    mfaRemove: uid => A.multiFactor(auth.currentUser).unenroll(uid),
    ws: {
      subscribe(onDocs, onErr) {
        let first = true;
        return F.onSnapshot(F.collection(fs, 'ws'), snap => {
          const docs = snap.docs.map(d => ({ id: d.id, json: d.data().json, by: d.data().by }));
          onDocs(docs, first); first = false;
        }, onErr);
      },
      write: (key, json) => F.setDoc(F.doc(fs, 'ws', key), { json, by: auth.currentUser.uid, at: F.serverTimestamp() })
    }
  };
}

boot().then(a => window.__knFbResolve && window.__knFbResolve(a))
  .catch(e => window.__knFbResolve && window.__knFbResolve({ ok: false, error: String(e && e.message || e) }));
