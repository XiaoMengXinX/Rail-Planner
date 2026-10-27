import {checkBotId} from 'botid/server';
import {failure} from './http.mjs';

// Runs only on CDN cache misses: bots cannot make the server reach lltskb or 12306, though they can
// read responses that real visitors already caused to be cached.
export async function rejectBots(request) {
  const {isBot} = await checkBotId({advancedOptions: {headers: Object.fromEntries(request.headers)}});
  return isBot ? failure('请求被拒绝', 403) : null;
}
