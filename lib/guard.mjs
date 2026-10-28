import {checkBotId} from 'botid/server';
import {failure} from './http.mjs';

// Runs only on CDN cache misses: bots cannot make the server reach GitHub or 12306, though they can
// read responses that real visitors already caused to be cached.
export async function rejectBots(request) {
  // Local builds leave the BotID client out, so the check only means something on Vercel (VERCEL=1).
  if (!process.env.VERCEL) return null;
  const {isBot} = await checkBotId({advancedOptions: {headers: Object.fromEntries(request.headers)}});
  return isBot ? failure('请求被拒绝', 403) : null;
}
