import { json } from '@sveltejs/kit';
import { sql } from 'drizzle-orm';
import { db } from '$lib/server/db';

export const GET = async () => {
	try {
		await db.execute(sql`select 1`);
		return json({ ok: true });
	} catch {
		return json({ ok: false }, { status: 503 });
	}
};
