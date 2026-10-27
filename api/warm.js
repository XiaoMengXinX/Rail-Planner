import {getDatabase} from '../lib/database.mjs';

// Cron every two days: pulls a newly announced package into the shared cache before users ask for it.
export async function GET(request) {
  if (!process.env.CRON_SECRET || request.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response('Unauthorized', {status: 401});
  }
  const {announced, version} = await getDatabase();
  return Response.json({announced, version});
}
