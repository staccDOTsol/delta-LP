import { type IncomingMessage, type ServerResponse } from 'node:http';
import { configuredApp } from '../waitlist/app.js';
export default function handler(req: IncomingMessage, res: ServerResponse) {
  try { return configuredApp()(req,res); }
  catch { res.statusCode = 503; res.setHeader('Content-Type','application/json'); res.end(JSON.stringify({error:'The waitlist is being configured. Please try again shortly.'})); }
}
