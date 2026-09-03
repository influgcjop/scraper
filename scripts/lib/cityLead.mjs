/**
 * saveCityLead — guarda un creador o marca cuya ciudad SÍ se identificó,
 * pero no es Caracas/Valencia. No se descarta ni se fuerza al alcance
 * actual, queda acá para si algún día se expande a otras ciudades.
 */
export async function saveCityLead(db, { kind, platform, username, city, followerCount }) {
  const { error } = await db.from('city_lead').upsert(
    {
      kind,
      platform,
      username: String(username).toLowerCase(),
      city,
      follower_count: followerCount ?? null,
    },
    { onConflict: 'kind,platform,username' }
  );
  if (error) console.warn(`  ⚠ city_lead @${username}:`, error.message);
}
