import fs from 'fs';

async function rollbackClipsTranslations() {
  const BASE_URL = 'http://127.0.0.1:8081/api';
  
  // Login to get token
  const loginRes = await fetch(`${BASE_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: 'admin@email.com',
      password: 'H8987ntdE6dkqWFL'
    })
  });
  
  if (!loginRes.ok) {
    console.error('Failed to login:', await loginRes.text());
    process.exit(1);
  }
  
  const token = (await loginRes.json()).data.access_token;

  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`
  };

  async function req(method, endpoint) {
    const res = await fetch(`${BASE_URL}${endpoint}`, { method, headers });
    if (!res.ok) {
      console.error(`❌ ${method} ${endpoint} failed:`, await res.text());
    } else {
      console.log(`✅ ${method} ${endpoint} success`);
    }
  }

  // Delete the translations alias field from listening_clips
  await req('DELETE', '/fields/listening_clips/translations');
  
  // Delete the listening_clips_translations collection
  // This automatically removes associated relations
  await req('DELETE', '/collections/listening_clips_translations');

  console.log('✅ Done rolling back listening_clips translations!');
}

rollbackClipsTranslations().catch(console.error);
