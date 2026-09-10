

const DIRECTUS_URL = 'http://localhost:8081/api';
const ADMIN_EMAIL = 'admin@email.com';
const ADMIN_PASSWORD = 'H8987ntdE6dkqWFL';

async function main() {
  const loginRes = await fetch(`${DIRECTUS_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
  });
  const loginData = await loginRes.json();
  const token = loginData.data.access_token;
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`
  };

  const collectionsToRead = [
    'listening_targets',
    'listening_clips',
    'source_videos',
    'comments',
    'directus_files'
  ];

  console.log('Setting public read permissions...');
  for (const collection of collectionsToRead) {
    await fetch(`${DIRECTUS_URL}/permissions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        role: null,
        collection: collection,
        action: 'read',
        permissions: {},
        validation: null,
        presets: null,
        fields: ['*']
      })
    });
    console.log(`Granted public read for ${collection}`);
  }

  // Cho phép đọc Users (chỉ đọc các trường cơ bản để hiển thị Avatar/Tên)
  await fetch(`${DIRECTUS_URL}/permissions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      role: null,
      collection: 'directus_users',
      action: 'read',
      permissions: {},
      validation: null,
      presets: null,
      fields: ['id', 'first_name', 'last_name', 'avatar']
    })
  });
  console.log('Granted public read for directus_users');
}

main().catch(console.error);
