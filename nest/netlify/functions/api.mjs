// Netlify Functions (v2): every /api/* request lands here.
import { handle } from '../../src/api.js';

export default async req => handle(req);

export const config = { path: '/api/*' };
