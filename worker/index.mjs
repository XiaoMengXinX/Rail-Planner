import {fetchFares} from '../lib/fares.mjs';
import {fetchServiceCalendar} from '../lib/service-calendar.mjs';

// Makes the two 12306 lookups for the Vercel functions, whose outbound addresses 12306 often refuses.
// Request validation, BotID and caching stay on Vercel; this only serves callers holding RELAY_SECRET.
export default {
  async fetch(request, env) {
    if (!env.RELAY_SECRET || request.headers.get('Authorization') !== `Bearer ${env.RELAY_SECRET}`) {
      return Response.json({error: '请求被拒绝'}, {status: 403});
    }
    const {pathname, searchParams: params} = new URL(request.url);
    try {
      if (pathname === '/service-calendar') return Response.json(await fetchServiceCalendar(params.get('code'), params.get('date')));
      if (pathname === '/fares') return Response.json({fares: await fetchFares(params.get('from'), params.get('to'), params.get('date'))});
      return Response.json({error: '未知接口'}, {status: 404});
    } catch (error) {
      return Response.json({error: error.message}, {status: 502});
    }
  },
};
